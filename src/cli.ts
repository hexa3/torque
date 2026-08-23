// Torque CLI.
//
//   torque run   FILE.tq [options]   execute a program
//   torque check FILE.tq              parse + allocation lint only
//   torque ast    FILE.tq             dump AST as JSON
//   torque tools  FILE.tq             export #[tool] JSON schemas
//
// Options for `run`:
//   --backend sim|serial   execution backend (default sim)
//   --port PATH            serial device path (e.g. /dev/ttyUSB0 or a socat PTY)
//   --for DUR              hard wall-clock cap (e.g. 2s, 500ms)
//   --tune name=expr@DUR   timed live-variable change, repeatable
//   --quiet                suppress the final loop report

import { runProgram } from "./runtime.ts"
import { parseSource } from "./front.ts"
import { checkProgram } from "./checker.ts"
import { toolDefinitions } from "./tools.ts"

function usage(exitCode: number): never {
  console.log(`Torque — real-time robotics control language

usage:
  torque run FILE.tq [--backend sim|serial] [--port /dev/ttyUSB0]
                     [--for 2s] [--tune kp=8@1s]... [--quiet]
  torque check FILE.tq
  torque ast FILE.tq
  torque tools FILE.tq

examples:
  torque run examples/07_arm_sim.tq --for 3s
  torque run examples/07_arm_sim.tq --backend serial --port /dev/ttyUSB0 --for 3s
  torque check examples/11_alloc_lint.tq
  torque tools examples/08_tools.tq`)
  process.exit(exitCode)
}

interface ParsedArgs {
  command: string
  file?: string
  backend: "sim" | "serial"
  port?: string
  forSeconds?: number
  tunes: string[]
  quiet: boolean
}

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === "-h" || command === "--help" || command === "help") usage(0)

const opts: ParsedArgs = { command, backend: "sim", tunes: [], quiet: false }

for (let i = 1; i < args.length; i++) {
  const a = args[i]
  if (a === "--backend") {
    const v = args[++i]
    if (v !== "sim" && v !== "serial") {
      console.error(`--backend must be 'sim' or 'serial', got '${v}'`)
      process.exit(1)
    }
    opts.backend = v
  } else if (a === "--port") {
    opts.port = args[++i]
  } else if (a === "--for") {
    const v = args[++i]
    const m = /^([\d.]+)(ms|us|s|m)?$/.exec(v ?? "")
    if (!m) { console.error(`bad --for duration '${v}'`); process.exit(1) }
    const n = Number(m[1])
    const mult = m[2] === "ms" ? 1e-3 : m[2] === "us" ? 1e-6 : m[2] === "m" ? 60 : 1
    opts.forSeconds = n * mult
  } else if (a === "--tune") {
    opts.tunes.push(args[++i])
  } else if (a === "--quiet" || a === "-q") {
    opts.quiet = true
  } else if (a.startsWith("--")) {
    console.error(`unknown option '${a}'`)
    process.exit(1)
  } else {
    if (opts.file !== undefined) { console.error("unexpected extra argument"); process.exit(1) }
    opts.file = a
  }
}

if (opts.file === undefined && command !== "help") {
  console.error("missing FILE argument")
  usage(1)
}

async function main() {
  switch (command) {
    case "run": {
      const result = await runProgram({
        file: opts.file!,
        backend: opts.backend,
        port: opts.port,
        forSeconds: opts.forSeconds,
        tunes: opts.tunes,
        quietReport: opts.quiet,
      })
      process.exitCode = result.exitCode
      break
    }
    case "check": {
      try {
        const prog = parseSource((await import("node:fs")).readFileSync(opts.file!, "utf8"))
        const c = checkProgram(prog)
        if (c.errors.length > 0) {
          for (const e of c.errors) console.error(`[alloc-lint] error ${opts.file}:${e.line}:${e.col}: ${e.message}`)
          console.error(`${opts.file}: FAILED (${c.errors.length} error${c.errors.length === 1 ? "" : "s"})`)
          process.exitCode = 2
        } else {
          for (const w of c.warnings) console.error(`[alloc-lint] warn  ${opts.file}:${w.line}:${w.col}: ${w.message}`)
          console.log(`${opts.file}: OK`)
        }
      } catch (e) {
        console.error(`${opts.file}: ${(e as Error).message}`)
        process.exitCode = 1
      }
      break
    }
    case "ast": {
      try {
        const prog = parseSource((await import("node:fs")).readFileSync(opts.file!, "utf8"))
        console.log(JSON.stringify(prog, (_, v) => v instanceof Map ? Object.fromEntries(v) : v, 2))
      } catch (e) {
        console.error(`${opts.file}: ${(e as Error).message}`)
        process.exitCode = 1
      }
      break
    }
    case "tools": {
      try {
        const prog = parseSource((await import("node:fs")).readFileSync(opts.file!, "utf8"))
        const defs = toolDefinitions(prog)
        console.log(JSON.stringify(defs, null, 2))
        process.exitCode = defs.length > 0 ? 0 : 1
        if (defs.length === 0) console.error("(no #[tool]-annotated functions found)")
      } catch (e) {
        console.error(`${opts.file}: ${(e as Error).message}`)
        process.exitCode = 1
      }
      break
    }
    default:
      console.error(`unknown command '${command}'`)
      usage(1)
  }
}

void main()
