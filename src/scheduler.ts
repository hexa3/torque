// Fixed-tick loop scheduler.
//
// Each armed loop gets a drift-corrected timer chain: the next tick is
// scheduled at an absolute deadline (period * k), not "now + period", so
// ticks do not accumulate jitter. Every tick's execution time is measured;
// if it exceeds the declared deadline, a throttled warning is emitted and
// the overrun is counted. A final report summarizes determinism.

import type { LoopDecl } from "./ast.ts"
import type { Interpreter } from "./interpreter.ts"
import { Env, ReturnSignal } from "./interpreter.ts"
import { isUnitVal } from "./values.ts"
import { rawUnitVal } from "./values.ts"
import type { UnitVal } from "./values.ts"

export interface LoopStats {
  name: string
  hz: number
  deadlineUs: number
  ticks: number
  overruns: number
  missed: number
  totalTickUs: number
  maxTickUs: number
  errors: number
  armedAtMs?: number
  disarmedAtMs?: number
}

export class ScheduledLoop {
  private nextAtUs = 0
  private timer: NodeJS.Timeout | null = null
  readonly periodUs: number
  readonly deadlineUs: number
  stats: LoopStats
  running = false
  private lastWarnAtMs = 0
  readonly decl: LoopDecl
  private interp: Interpreter
  private onFatal: (loopName: string, err: Error) => void

  constructor(
    decl: LoopDecl,
    interp: Interpreter,
    onFatal: (loopName: string, err: Error) => void,
    hz: number,
    deadlineUs: number,
  ) {
    this.decl = decl
    this.interp = interp
    this.onFatal = onFatal
    this.periodUs = 1e6 / hz
    this.deadlineUs = deadlineUs
    this.stats = {
      name: decl.name, hz, deadlineUs,
      ticks: 0, overruns: 0, missed: 0,
      totalTickUs: 0, maxTickUs: 0, errors: 0,
    }
  }

  arm() {
    if (this.running) return
    this.running = true
    this.stats.armedAtMs = Date.now()
    this.nextAtUs = nowUs()
    this.schedule()
  }

  disarm() {
    this.running = false
    this.stats.disarmedAtMs = Date.now()
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private schedule() {
    const delayMs = Math.max(0, (this.nextAtUs - nowUs()) / 1000)
    this.timer = setTimeout(() => {
      this.tick().catch(err => this.onFatal(this.decl.name, err))
    }, delayMs)
  }

  private async tick() {
    if (!this.running) return
    const t0 = nowUs()

    const ctx = { name: this.decl.name, tick: this.stats.ticks }
    const prev = this.interp.currentLoop
    this.interp.currentLoop = ctx
    const env = new Env(this.interp.globals)
    // Loop-scoped implicit variables available to the body.
    env.define("tick", this.stats.ticks)
    try {
      await this.interp.execStmts(this.decl.body, env)
    } catch (e) {
      if (!(e instanceof ReturnSignal)) {
        this.stats.errors++
        this.onFatal(this.decl.name, e as Error)
        this.disarm()
        return
      }
    } finally {
      this.interp.currentLoop = prev
    }

    const dtUs = nowUs() - t0
    this.stats.ticks++
    this.stats.totalTickUs += dtUs
    if (dtUs > this.stats.maxTickUs) this.stats.maxTickUs = dtUs

    if (dtUs > this.deadlineUs) {
      this.stats.overruns++
      const wall = Date.now()
      if (wall - this.lastWarnAtMs > 250) {
        this.lastWarnAtMs = wall
        console.error(
          `[overrun] loop '${this.decl.name}' tick took ${Math.round(dtUs)}us ` +
          `(deadline ${Math.round(this.deadlineUs)}us) — ${this.stats.overruns} overrun(s) so far`,
        )
      }
    }

    // Drift-corrected next tick; resync if we fell hopelessly behind.
    this.nextAtUs += this.periodUs
    const lateUs = nowUs() - this.nextAtUs
    if (lateUs > 0) {
      const missed = Math.floor(lateUs / this.periodUs)
      if (missed > 0) this.stats.missed += missed
      this.nextAtUs = nowUs()
    }
    if (this.running) this.schedule()
  }
}

function nowUs(): number {
  return performance.now() * 1000
}

export class Scheduler {
  loops = new Map<string, ScheduledLoop>()
  private interp: Interpreter
  private program: import("./ast.ts").Program

  constructor(interp: Interpreter, program: import("./ast.ts").Program) {
    this.interp = interp
    this.program = program
  }

  async buildLoops(): Promise<string[]> {
    const problems: string[] = []
    for (const decl of this.program.loops) {
      const hzV = await this.interp.evalExpr(decl.freqExpr, this.interp.globals)
      if (!isUnitVal(hzV) || hzV.key !== "T-1") {
        problems.push(`loop '${decl.name}': frequency must look like 50hz`)
        continue
      }
      const hz = hzV.canon
      let deadlineUs = (1e6 / hz) * 0.5 // default: half the period
      if (decl.deadlineExpr) {
        const dV = await this.interp.evalExpr(decl.deadlineExpr, this.interp.globals)
        if (!isUnitVal(dV) || dV.key !== "T1") {
          problems.push(`loop '${decl.name}': deadline must be a Duration like 2ms`)
          continue
        }
        deadlineUs = dV.canon * 1e6
      }
      const loop = new ScheduledLoop(decl, this.interp, (_n, err) => {
        console.error(`[fatal] loop '${_n}' disarmed after error: ${err.message}`)
      }, hz, deadlineUs)
      this.loops.set(decl.name, loop)
    }
    return problems
  }

  armAll() {
    for (const l of this.loops.values()) l.arm()
  }

  stopAll() {
    for (const l of this.loops.values()) l.disarm()
  }

  stop(name?: string) {
    if (name === undefined) { this.stopAll(); return }
    this.loops.get(name)?.disarm()
  }

  isAnyRunning(): boolean {
    for (const l of this.loops.values()) if (l.running) return true
    return false
  }

  reportLines(): string[] {
    const lines: string[] = []
    lines.push("── loop report " + "─".repeat(46))
    lines.push(
      [pad("loop", 12), padL("hz", 6), padL("deadline", 10), padL("ticks", 7),
        padL("overruns", 9), padL("missed", 7), padL("max-tick", 10), padL("achieved-hz", 12)].join(" "),
    )
    for (const s of [...this.loops.values()].map(l => l.stats)) {
      let achieved = 0
      if (s.ticks > 1 && s.armedAtMs !== undefined) {
        const wallS = Math.max(((s.disarmedAtMs ?? Date.now()) - s.armedAtMs) / 1000, 1e-6)
        achieved = (s.ticks - 1) / wallS
      }
      lines.push(
        [
          pad(s.name, 12),
          padL(fmtNum(s.hz), 6),
          padL(Math.round(s.deadlineUs) + "us", 10),
          padL(String(s.ticks), 7),
          padL(String(s.overruns), 9),
          padL(String(s.missed), 7),
          padL(Math.round(s.maxTickUs) + "us", 10),
          padL(fmtNum(achieved), 12),
        ].join(" "),
      )
    }
    lines.push("─".repeat(62))
    return lines
  }

  printReport() {
    for (const line of this.reportLines()) console.log(line)
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s
}
function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100)
}
