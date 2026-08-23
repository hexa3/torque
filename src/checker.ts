// Static checks run before any Torque program executes.
//
// The headline check is the allocation lint ("memory safety by
// convention"): once a loop is ARMED its body may not dynamically
// allocate. This is a best-effort syntactic + transitive analysis, NOT a
// full escape/borrow analysis — documented honestly as such.
//
// Flagged inside armed loop bodies:
//   - array literals [...]           (heap array allocation)
//   - map literals {...}             (hash map allocation)
//   - push()/pop() calls             (grow/shrink arrays)
//   - str() and string concatenation with '+' (string allocs)
//   - user-function calls whose own bodies contain any of the above
//
// Explicitly allowed: vec3/transform/pose/frame constructors (fixed size),
// print() (debug aid; warned about at most once per program), all scalar
// math, read/write/publish of existing values.

import type { Program, Stmt, Expr } from "./ast.ts"

export interface LintIssue {
  message: string
  line: number
  col: number
  kind: "error" | "warn"
}

const PURE_FIXED_BUILTINS = new Set([
  "vec3", "transform", "compose", "apply", "pose", "frame", "place",
  "world_transform", "dot", "cross", "sin", "cos", "tan", "atan2", "abs",
  "sqrt", "pow", "floor", "ceil", "round", "min", "max", "clamp", "rand",
  "read", "write", "publish", "now", "tick_count", "len", "stop", "num",
  "spin", "run_for", "keys",
])

class AllocFinder {
  issues: LintIssue[] = []
  private visitingFns = new Set<string>()
  private program: Program
  private bodyOverride: Stmt[] | null
  private loopName: string

  constructor(program: Program, bodyOverride: Stmt[] | null, loopName: string) {
    this.program = program
    this.bodyOverride = bodyOverride
    this.loopName = loopName
  }

  find(): LintIssue[] {
    this.scanStmts(this.bodyOverride ?? this.loopBody())
    return this.issues
  }

  private loopBody(): Stmt[] {
    const loop = this.program.loops.find(l => l.name === this.loopName)
    return loop ? loop.body : []
  }

  private scanStmts(stmts: Stmt[]) {
    for (const s of stmts) this.scanStmt(s)
  }

  private scanStmt(s: Stmt) {
    switch (s.kind) {
      case "let": this.scanExpr(s.init); break
      case "assign": this.scanExpr(s.value); break
      case "if":
        this.scanExpr(s.cond); this.scanStmts(s.then)
        if (s.else) this.scanStmts(s.else)
        break
      case "while": this.scanExpr(s.cond); this.scanStmts(s.body); break
      case "for": this.scanExpr(s.iter); this.scanStmts(s.body); break
      case "return": if (s.value) this.scanExpr(s.value); break
      case "exprstmt": this.scanExpr(s.expr); break
      default: break
    }
  }

  private scanExpr(e: Expr) {
    switch (e.kind) {
      case "arraylit":
        this.error(e.pos?.line ?? 0, e.pos?.col ?? 0, "dynamic allocation 'array literal' inside armed loop; preallocate outside the loop and assign by index")
        for (const it of e.items) this.scanExpr(it)
        break
      case "maplit":
        this.error(e.pos?.line ?? 0, e.pos?.col ?? 0, "dynamic allocation 'map literal' inside armed loop")
        for (const [, v] of e.entries) this.scanExpr(v)
        break
      case "binary":
        if (e.op === "+" && (couldBeString(e.l) || couldBeString(e.r))) {
          this.error(e.pos?.line ?? 0, e.pos?.col ?? 0, "string concatenation ('+') allocates inside armed loop; pass multiple args to print() instead")
        }
        this.scanExpr(e.l); this.scanExpr(e.r)
        break
      case "call": {
        const calleeName = e.callee.kind === "ident" ? e.callee.name : null
        if (calleeName === "push" || calleeName === "pop") {
          this.error(e.pos?.line ?? 0, e.pos?.col ?? 0, `'${calleeName}()' resizes an array inside armed loop`)
        } else if (calleeName === "str") {
          this.error(e.pos?.line ?? 0, e.pos?.col ?? 0, "'str()' allocates a string inside armed loop")
        } else if (calleeName === "print") {
          // Allowed but flagged as a warning once.
          this.warn(e.pos?.line ?? 0, e.pos?.col ?? 0, "print() may allocate; fine for debugging, avoid in hard-real-time deployments")
        } else if (calleeName !== null && !PURE_FIXED_BUILTINS.has(calleeName)) {
          const fn = this.program.fns.get(calleeName)
          if (!fn && !this.program.fns.has(calleeName)) {
            this.warn(e.pos?.line ?? 0, e.pos?.col ?? 0, `call to '${calleeName}' is not a known builtin or function`)
          }
          if (fn && !this.visitingFns.has(calleeName)) {
            this.visitingFns.add(calleeName)
            const sub = new AllocFinder(this.program, fn.body, this.loopName)
            for (const issue of sub.find()) {
              if (issue.kind === "error") {
                this.error(issue.line, issue.col, `'${calleeName}' allocates when called from armed loop (transitive via '${calleeName}'): ${issue.message}`)
              }
            }
          }
        }
        for (const a of e.args) this.scanExpr(a)
        break
      }
      case "unary": this.scanExpr(e.expr); break
      case "index": this.scanExpr(e.obj); this.scanExpr(e.index); break
      case "member": this.scanExpr(e.obj); break
      default: break
    }
  }

  private error(line: number, col: number, message: string) {
    this.issues.push({ kind: "error", message, line, col })
  }
  private warn(line: number, col: number, message: string) {
    this.issues.push({ kind: "warn", message, line, col })
  }
}

function couldBeString(e: Expr): boolean {
  if (e.kind === "str") return true
  if (e.kind === "call" && e.callee.kind === "ident" && (e.callee.name === "str")) return true
  return false
}

export interface CheckResult {
  errors: LintIssue[]
  warnings: LintIssue[]
}

export function checkProgram(program: Program): CheckResult {
  const errors: LintIssue[] = []
  const warnings: LintIssue[] = []

  for (const loop of program.loops) {
    const finder = new AllocFinder(program, loop.body, loop.name)
    let printedPrintWarning = false
    for (const issue of finder.find()) {
      if (issue.kind === "error") errors.push(issue)
      else {
        // Only one print() warning per loop keeps output sane.
        if (issue.message.startsWith("print()")) {
          if (printedPrintWarning) continue
          printedPrintWarning = true
          warnings.push({ ...issue, message: `${issue.message} (further print() uses in '${loop.name}' not repeated)` })
        } else {
          warnings.push(issue)
        }
      }
    }
  }

  return { errors, warnings }
}
