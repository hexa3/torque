// Runtime: wires parser output to the interpreter, bus, scheduler,
// backend and live tuner, then runs the program to completion.
//
// Lifetime rules:
//   - If fn main exists, the program runs UNTIL main returns
//     (main usually calls run_for(...) to control how long loops spin).
//   - If there is no main, the program runs until SIGINT or until every
//     loop has been disarmed/stopped.

import fs from "node:fs"
import { parseSource } from "./front.ts"
import type { Program } from "./ast.ts"
import { Interpreter, Env, registerUnitNames, type RuntimeHost } from "./interpreter.ts"
import { UNITS } from "./units.ts"
import { installBuiltins } from "./builtins.ts"
import { Scheduler } from "./scheduler.ts"
import { Bus } from "./bus.ts"
import { checkProgram } from "./checker.ts"
import { SimBackend } from "./backends/sim.ts"
import { SerialBackend } from "./backends/serial.ts"
import type { Backend } from "./backends/backend.ts"
import { LiveTuner } from "./live.ts"
import { isUnitVal, type TorqueValue } from "./values.ts"

export interface RunOptions {
  file: string
  backend: "sim" | "serial"
  port?: string
  forSeconds?: number          // hard wall-clock cap (--for DUR)
  tunes?: string[]             // ["kp=8@1s", ...] automated live tuning
  quietReport?: boolean
}

export interface RunResult {
  exitCode: number
}

const PROGRAM_START_US = performance.now() * 1000

function nowUs(): number {
  return performance.now() * 1000
}

function durationSeconds(d: TorqueValue, what: string): number {
  if (isUnitVal(d) && d.key === "T1") return d.canon
  throw new Error(`type error: ${what} expects a Duration like 2s or 500ms`)
}

export async function runProgram(opts: RunOptions): Promise<RunResult> {
  let src: string
  try {
    src = fs.readFileSync(opts.file, "utf8")
  } catch (e) {
    console.error(`torque: cannot read ${opts.file}: ${(e as Error).message}`)
    return { exitCode: 1 }
  }

  let program: Program
  try {
    program = parseSource(src)
  } catch (e) {
    printParseError(opts.file, src, e)
    return { exitCode: 1 }
  }

  // ---- static checks (allocation lint) ----
  const check = checkProgram(program)
  let warned = false
  for (const w of check.warnings) {
    if (!warned) { console.error("── alloc-lint warnings " + "─".repeat(30)); warned = true }
    console.error(`[alloc-warn] ${opts.file}:${w.line}:${w.col}: ${w.message}`)
  }
  if (check.errors.length > 0) {
    console.error(`── alloc-lint rejected program (${check.errors.length} error${check.errors.length === 1 ? "" : "s"}) ──`)
    for (const e of check.errors) {
      console.error(`[alloc-lint] ${opts.file}:${e.line}:${e.col}: ${e.message}`)
    }
    return { exitCode: 2 }
  }

  // ---- construct runtime pieces ----
  const interp = new Interpreter(program)
  registerUnitNames(Object.keys(UNITS))
  const bus = new Bus()

  const backend: Backend = opts.backend === "serial"
    ? new SerialBackend({ path: opts.port })
    : new SimBackend()

  const scheduler = new Scheduler(interp, program)

  const host: RuntimeHost = {
    nowUs,
    startTimeUs: () => PROGRAM_START_US,
    runFor: async d => { await sleep(durationSeconds(d, "run_for()") * 1000) },
    spin: d => {
      const ms = durationSeconds(d, "spin()") * 1000
      const end = performance.now() + ms
      while (performance.now() < end) { /* deliberate busy-wait */ }
    },
    read: ch => backend.read(ch),
    write: (ch, v) => backend.write(ch, v),
    publish: (path, v) => bus.publish(path, v),
    stopLoop: name => scheduler.stop(name),
    tickCount: () => {
      const ctx = interp.currentLoop
      if (ctx === null) throw new Error("runtime error: tick_count() is only valid inside a loop body")
      return ctx.tick
    },
  }
  interp.setHost(host)
  installBuiltins(interp, host)

  const problems = await scheduler.buildLoops()
  if (problems.length > 0) {
    for (const p of problems) console.error(`[loop] ${p}`)
    return { exitCode: 1 }
  }

  // ---- topics & handlers ----
  for (const t of program.topics) bus.declare(t)
  for (const h of program.ons) {
    if (!bus.topics.has(h.path)) {
      console.error(`[bus] warning: handler for undeclared topic /${h.path}`)
    }
    bus.subscribe({
      path: h.path,
      subscriber: `on /${h.path}`,
      deliver: async msg => {
        const env = new Env(interp.globals)
        env.define(h.varName, msg)
        await interp.execStmts(h.body, env)
      },
    })
  }

  // ---- go ----
  try {
    await backend.start()
  } catch (e) {
    console.error(`torque: ${(e as Error).message}`)
    return { exitCode: 1 }
  }

  try {
    await interp.execTopLevel()
  } catch (e) {
    reportRuntimeError(e)
    try { await backend.stop() } catch { /* ignore */ }
    return { exitCode: 1 }
  }
  scheduler.armAll()

  const tuner = new LiveTuner(interp, scheduler)
  tuner.startTunes(opts.tunes ?? [])
  tuner.startRepl()

  // Shutdown plumbing.
  let shutDown = false
  let resolveShutdown!: () => void
  const shutdownPromise = new Promise<void>(r => { resolveShutdown = r })
  const shutdown = (): void => {
    if (shutDown) return
    shutDown = true
    scheduler.stopAll()
    tuner.stopRepl()
    process.removeListener("SIGINT", onSig)
    resolveShutdown()
  }

  function onSig(): void {
    console.error("\n[interrupt] shutting down…")
    shutdown()
  }
  process.once("SIGINT", onSig)

  if (opts.forSeconds !== undefined) {
    const t = setTimeout(shutdown, opts.forSeconds * 1000)
    t.unref?.()
  }

  let exitCode = 0
  try {
    await interp.callMain()
    if (program.fns.has("main")) {
      // main returned -> normal end of program
      shutdown()
    } else {
      // no main: serve until SIGINT or all loops disarmed
      const waiter = setInterval(() => {
        if (!scheduler.isAnyRunning()) shutdown()
      }, 25)
      waiter.unref?.()
    }
  } catch (e) {
    reportRuntimeError(e)
    exitCode = 1
    shutdown()
  }

  await shutdownPromise
  try { await backend.stop() } catch { /* ignore */ }

  if (!opts.quietReport && scheduler.loops.size > 0) scheduler.printReport()
  return { exitCode }
}

function reportRuntimeError(e: unknown): void {
  const err = e as Error
  const msg = err.message ?? String(e)
  if (/stack space|call stack/i.test(msg)) {
    console.error(`runtime error: stack overflow (infinite recursion?)`)
  } else if (msg.startsWith("runtime error:")) {
    console.error(msg)
  } else {
    console.error(`runtime error: ${msg}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function printParseError(file: string, src: string, e: unknown): void {
  const err = e as { message: string; line?: number; col?: number }
  if (err.line !== undefined) {
    const lines = src.split("\n")
    const pad = String(err.line).padStart(4)
    const caret = " ".repeat(pad.length + 1 + (err.col ?? 1) - 1) + "^"
    console.error(`${file}:${err.line}:${err.col}: ${err.message}`)
    console.error(`    ${pad} | ${lines[err.line - 1] ?? ""}`)
    console.error(`    ${caret}`)
  } else {
    console.error(`${file}: ${err.message}`)
  }
}
