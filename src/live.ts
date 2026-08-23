// Live tuning: change `live` variables while loops are running.
//
// Two entry paths:
//   - stdin REPL: `set kp 8`, `get kp`, `vars`, `stats`, `help`, `quit`
//   - --tune "kp=8@1s" flags: timed automated changes (used by tests/CI)
//
// Assignments reuse the Torque parser+evaluator, so `set kp 2*0.5+1`
// works, and typed slots (`live x: Angle = ...`) stay type-checked.

import { createInterface } from "node:readline"
import type { Interpreter } from "./interpreter.ts"
import { parseSource } from "./front.ts"
import { checkType } from "./types.ts"
import { formatVal } from "./values.ts"
import type { TorqueValue } from "./values.ts"
import type { Scheduler } from "./scheduler.ts"

export class LiveTuner {
  private rl: ReturnType<typeof createInterface> | null = null
  private tuneTimers: NodeJS.Timeout[] = []
  private interp: Interpreter
  private scheduler: Scheduler
  // Serialized command handling: readline can deliver buffered lines faster
  // than async handlers resolve, and `set x 1` followed by `get x` must
  // observe the new value even when stdin is a pipe/script.
  private chain: Promise<void> = Promise.resolve()

  constructor(interp: Interpreter, scheduler: Scheduler) {
    this.interp = interp
    this.scheduler = scheduler
  }

  startRepl() {
    if (this.rl !== null) return
    this.rl = createInterface({ input: process.stdin, terminal: false })
    this.rl.on("line", line => {
      this.chain = this.chain.then(() => this.handleLine(line)).catch(() => { /* keep serving */ })
    })
    this.rl.on("close", () => { /* stdin closed; keep running */ })
  }

  stopRepl() {
    if (this.rl !== null) {
      try { this.rl.close() } catch { /* ignore */ }
      this.rl = null
    }
    for (const t of this.tuneTimers) clearTimeout(t)
    this.tuneTimers = []
  }

  /** Schedule "--tune name=expr@time" entries. */
  startTunes(tunes: string[]) {
    for (const spec of tunes) {
      const m = /^([^=@]+)=([^@]+)@(.+)$/.exec(spec.trim())
      if (!m) {
        console.error(`[tune] bad spec '${spec}' — expected name=expr@duration`)
        continue
      }
      const [, name, exprSrc, when] = m
      let delayMs: number
      try {
        delayMs = parseDurationMs(when)
      } catch (e) {
        console.error(`[tune] ${(e as Error).message}`)
        continue
      }
      const t = setTimeout(() => {
        void this.applySet(name.trim(), exprSrc.trim()).then(() => {
          console.log(`[tune] @${when}: set ${name.trim()} -> ${formatVal(this.safeGet(name.trim()))}`)
        }).catch((e: unknown) => {
          console.error(`[tune] failed: ${(e as Error).message}`)
        })
      }, delayMs)
      t.unref?.()
      this.tuneTimers.push(t)
    }
  }

  async handleLine(line: string): Promise<void> {
    const text = line.trim()
    if (!text) return
    try {
      if (text === "help") {
        console.log("commands: set <var> [=] <expr> | get <var> | vars | stats | quit")
        return
      }
      if (text === "quit" || text === "exit") {
        process.kill(process.pid, "SIGINT")
        return
      }
      if (text === "vars") {
        if (this.interp.liveNames.size === 0) console.log("(no live variables)")
        for (const n of this.interp.liveNames) {
          const t = this.interp.typedSlots.get(n)
          console.log(`${n} = ${formatVal(this.safeGet(n))}${t ? `  : ${t}` : ""}`)
        }
        return
      }
      if (text === "stats") {
        for (const l of this.scheduler.reportLines()) console.log(l)
        return
      }
      const getM = /^get\s+(\w+)$/.exec(text)
      if (getM) {
        console.log(`${getM[1]} = ${formatVal(this.safeGet(getM[1]))}`)
        return
      }
      const body = text.startsWith("set ") ? text.slice(4).trim() : text
      const setM = /^(\w+)\s*=?\s*([\s\S]+)$/.exec(body)
      if (setM && setM[2].trim() !== "") {
        await this.applySet(setM[1], setM[2])
        console.log(`[repl] ${setM[1]} = ${formatVal(this.safeGet(setM[1]))}`)
        return
      }
      console.log(`[repl] unknown command: ${text} (try 'help')`)
    } catch (e) {
      console.error(`[repl] ${(e as Error).message}`)
    }
  }

  async applySet(name: string, exprSrc: string): Promise<void> {
    const v = await evalSnippet(exprSrc, this.interp)
    assignVar(this.interp, name, v)
  }

  private safeGet(name: string): unknown {
    return this.interp.globals.has(name) ? this.interp.globals.get(name) : "<undefined>"
  }
}

/** Evaluate a standalone Torque expression against program globals. */
export async function evalSnippet(src: string, interp: Interpreter): Promise<TorqueValue> {
  const program = parseSource(`__snippet__ = ${src}`)
  const stmt = program.stmts[0]
  if (!stmt || stmt.kind !== "assign") throw new Error("internal: snippet must be an expression")
  return interp.evalSnippetExpr(stmt.value)
}

export function assignVar(interp: Interpreter, name: string, value: TorqueValue): void {
  const typeName = interp.typedSlots.get(name)
  const checked = typeName ? checkType(typeName, value, `assignment to '${name}'`) : value
  if (!interp.globals.setExisting(name, checked)) {
    throw new Error(`no variable named '${name}'`)
  }
}

function parseDurationMs(spec: string): number {
  const m = /^([\d.]+)(us|ms|s|m)?\s*$/.exec(spec.trim())
  if (!m) throw new Error(`bad duration '${spec}'`)
  const n = Number(m[1])
  switch (m[2]) {
    case undefined:
    case "s":
      return n * 1000
    case "ms":
      return n
    case "us":
      return n / 1000
    case "m":
      return n * 60_000
    default:
      throw new Error(`bad duration '${spec}'`)
  }
}
