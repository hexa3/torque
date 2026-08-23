// Tree-walking interpreter for Torque. Fully async so that `run_for` can
// suspend main and let the scheduler/bus pump the event loop.

import type { Program, Expr, Stmt, FnDecl } from "./ast.ts"
import { TorqueSyntaxError } from "./tokens.ts"
import {
  makeBuiltin, vec3, vadd, vsub, vscale, vneg, vlen, vdot,
  uadd, usub, umul, udiv, uneg, ucmp, ueq, convert, formatVal,
  transformFromRpy, composeTransform, applyTransform, worldTransform,
  rawUnitVal, makeUnitVal, isUnitVal, isVec3, isFrame, isTransform, isPose,
} from "./values.ts"
import type {
  TorqueValue, BuiltinVal, UnitVal, Vec3Val, FrameVal, TransformVal, PoseVal,
} from "./values.ts"
import { describeDims } from "./units.ts"
import { checkType } from "./types.ts"

export class BreakSignal { }
export class ContinueSignal { }
export class ReturnSignal {
  value: TorqueValue
  constructor(value: TorqueValue) { this.value = value }
}

export class Env {
  vars = new Map<string, TorqueValue>()
  parent: Env | null
  constructor(parent: Env | null) { this.parent = parent }

  lookup(name: string): Env | null {
    let e: Env | null = this
    while (e !== null) {
      if (e.vars.has(name)) return e
      e = e.parent
    }
    return null
  }
  get(name: string): TorqueValue {
    const e = this.lookup(name)
    if (e === null) throw new Error(`runtime error: undefined variable '${name}'`)
    return e.vars.get(name)!
  }
  has(name: string): boolean {
    return this.lookup(name) !== null
  }
  setExisting(name: string, v: TorqueValue): boolean {
    const e = this.lookup(name)
    if (e === null) return false
    e.vars.set(name, v)
    return true
  }
  define(name: string, v: TorqueValue) {
    this.vars.set(name, v)
  }
}

export interface LoopContext {
  name: string
  tick: number
}

export interface RuntimeHost {
  nowUs(): number
  runFor(d: UnitVal | number): Promise<void>
  spin(d: UnitVal | number): void
  read(channel: string): TorqueValue
  write(channel: string, value: TorqueValue): void
  publish(path: string, value: TorqueValue): void
  stopLoop(name?: string): void
  tickCount(): number
  startTimeUs(): number
}

export class Interpreter {
  globals = new Env(null)
  fns: Map<string, FnDecl>
  liveNames = new Set<string>()
  typedSlots = new Map<string, string>() // global var -> declared type
  currentLoop: LoopContext | null = null
  host: RuntimeHost | null = null

  program: Program

  constructor(program: Program) {
    this.program = program
    this.fns = program.fns
  }

  setHost(host: RuntimeHost) {
    this.host = host
  }

  // ---- program execution ----

  async execTopLevel() {
    await this.execStmts(this.program.stmts, this.globals)
  }

  async callMain() {
    const main = this.fns.get("main")
    if (!main) return
    await this.callFn(main, [])
  }

  async callFn(decl: FnDecl, args: TorqueValue[]): Promise<TorqueValue> {
    if (args.length !== decl.params.length) {
      throw new Error(`runtime error: function '${decl.name}' expects ${decl.params.length} args, got ${args.length}`)
    }
    const env = new Env(this.globals)
    for (let i = 0; i < args.length; i++) {
      const p = decl.params[i]
      const checked = checkType(p.typeName, args[i], `argument '${p.name}' of '${decl.name}'`)
      env.define(p.name, checked)
    }
    try {
      await this.execStmts(decl.body, env)
    } catch (e) {
      if (e instanceof ReturnSignal) {
        if (decl.retTypeName) {
          return checkType(decl.retTypeName, e.value ?? null, `return value of '${decl.name}'`)
        }
        return e.value ?? null
      }
      throw e
    }
    if (decl.retTypeName && decl.retTypeName !== "void") {
      // Falling off the end without return.
      throw new Error(`runtime error: function '${decl.name}' must return ${decl.retTypeName}`)
    }
    return null
  }

  // Evaluate an expression (from REPL/tuner snippets) against globals.
  async evalSnippetExpr(e: Expr): Promise<TorqueValue> {
    return this.evalExpr(e, this.globals)
  }

  // ---- statements ----

  async execStmts(stmts: Stmt[], env: Env): Promise<void> {
    for (const s of stmts) {
      await this.execStmt(s, env)
    }
  }

  async execStmt(s: Stmt, env: Env): Promise<void> {
    switch (s.kind) {
      case "let": {
        let v = await this.evalExpr(s.init, env)
        if (s.typeName) v = checkType(s.typeName, v, `initializer of '${s.name}'`)
        env.define(s.name, v)
        if (s.isLive) this.liveNames.add(s.name)
        if (env === this.globals && s.typeName) this.typedSlots.set(s.name, s.typeName)
        return
      }
      case "assign": {
        let v = await this.evalExpr(s.value, env)
        const t = s.target
        if (t.kind === "ident") {
          if (s.op !== "=") {
            const cur = env.get(t.name)
            v = applyCompound(s.op, cur, v)
          }
          // typed slot check for globals with annotations
          const tn = this.typedSlots.get(t.name)
          if (tn) v = checkType(tn, v, `assignment to '${t.name}'`)
          if (!env.setExisting(t.name, v)) {
            throw new Error(`runtime error: assignment to undeclared variable '${t.name}'`)
          }
          return
        }
        if (t.kind === "index") {
          const obj = await this.evalExpr(t.obj, env)
          const idxV = await this.evalExpr(t.index, env)
          const idx = typeof idxV === "number" ? idxV : NaN
          if (!Array.isArray(obj)) throw new Error("runtime error: index target must be an array")
          if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) {
            throw new Error(`runtime error: index ${idxV} out of bounds [0..${obj.length})`)
          }
          if (s.op !== "=") v = applyCompound(s.op, obj[idx], v)
          obj[idx] = v
          return
        }
        if (t.kind === "member") {
          const obj = await this.evalExpr(t.obj, env)
          if (obj instanceof Map) {
            if (s.op !== "=") v = applyCompound(s.op, obj.get(t.name) ?? null, v)
            obj.set(t.name, v)
            return
          }
          throw new Error(`runtime error: cannot assign to member '${t.name}' of this value`)
        }
        throw new Error("runtime error: invalid assignment target")
      }
      case "if": {
        const c = await this.evalExpr(s.cond, env)
        if (truthy(c)) {
          await this.execStmts(s.then, new Env(env))
        } else if (s.else) {
          await this.execStmts(s.else, new Env(env))
        }
        return
      }
      case "while": {
        while (truthy(await this.evalExpr(s.cond, env))) {
          try {
            await this.execStmts(s.body, new Env(env))
          } catch (e) {
            if (e instanceof BreakSignal) break
            if (!(e instanceof ContinueSignal)) throw e
          }
        }
        return
      }
      case "for": {
        const it = await this.evalExpr(s.iter, env)
        if (!Array.isArray(it)) {
          throw new Error(`type error: for-in needs an array, got ${typeNameOf(it)}`)
        }
        const items = it
        for (const item of items) {
          const bodyEnv = new Env(env)
          bodyEnv.define(s.varName, item)
          try {
            await this.execStmts(s.body, bodyEnv)
          } catch (e) {
            if (e instanceof BreakSignal) break
            if (!(e instanceof ContinueSignal)) throw e
          }
        }
        return
      }
      case "return":
        throw new ReturnSignal(s.value ? await this.evalExpr(s.value, env) : null)
      case "break":
        throw new BreakSignal()
      case "continue":
        throw new ContinueSignal()
      case "exprstmt":
        await this.evalExpr(s.expr, env)
        return
    }
  }

  // ---- expressions ----

  async evalExpr(e: Expr, env: Env): Promise<TorqueValue> {
    switch (e.kind) {
      case "num": {
        if (e.unit === undefined) return e.value
        if (e.unit === "%") return e.value * 0.01
        return makeUnitVal(e.value, e.unit)
      }
      case "str": return e.value
      case "bool": return e.value
      case "nil": return null
      case "ident": {
        const v = env.get(e.name)
        if (isBuiltin(v)) return v
        return v
      }
      case "topicref": return "/" + e.path
      case "unary": {
        const v = await this.evalExpr(e.expr, env)
        if (e.op === "-") {
          if (typeof v === "number") return -v
          if (isUnitVal(v)) return uneg(v)
          if (isVec3(v)) return vneg(v)
          throw new Error("type error: unary minus needs a numeric value")
        }
        return !truthy(v)
      }
      case "binary": return this.evalBinary(e, env)
      case "member": return this.evalMember(e.obj, e.name, env)
      case "index": {
        const obj = await this.evalExpr(e.obj, env)
        const idx = await this.evalExpr(e.index, env)
        if (Array.isArray(obj)) {
          const i = typeof idx === "number" ? idx : NaN
          if (!Number.isInteger(i) || i < 0 || i >= obj.length) {
            throw new Error(`runtime error: index ${formatVal(idx)} out of bounds [0..${obj.length})`)
          }
          return obj[i]
        }
        if (obj instanceof Map) {
          const k = String(idx)
          if (!obj.has(k)) throw new Error(`runtime error: no key '${k}' in map`)
          return obj.get(k)!
        }
        throw new Error("runtime error: only arrays and maps are indexable")
      }
      case "arraylit": {
        const items: TorqueValue[] = []
        for (const it of e.items) items.push(await this.evalExpr(it, env))
        return items
      }
      case "maplit": {
        const m = new Map<string, TorqueValue>()
        for (const [k, ve] of e.entries) m.set(k, await this.evalExpr(ve, env))
        return m
      }
      case "call": return this.evalCall(e, env)
    }
  }

  private async evalBinary(e: Extract<Expr, { kind: "binary" }>, env: Env): Promise<TorqueValue> {
    const op = e.op
    if (op === "&&") {
      const l = await this.evalExpr(e.l, env)
      return truthy(l) ? truthy(await this.evalExpr(e.r, env)) : false
    }
    if (op === "||") {
      const l = await this.evalExpr(e.l, env)
      return truthy(l) ? true : truthy(await this.evalExpr(e.r, env))
    }
    const l = await this.evalExpr(e.l, env)
    const r = await this.evalExpr(e.r, env)

    switch (op) {
      case "+":
        if (typeof l === "number" && typeof r === "number") return l + r
        if (isUnitVal(l) && isUnitVal(r)) return uadd(l, r)
        if (typeof l === "string") return l + formatVal(r)
        if (typeof r === "string") return formatVal(l) + r
        if (isVec3(l) && isVec3(r)) return vadd(l, r)
        throw new Error(`type error: cannot add ${typeNameOf(l)} and ${typeNameOf(r)}`)
      case "-":
        if (typeof l === "number" && typeof r === "number") return l - r
        if (isUnitVal(l) && isUnitVal(r)) return usub(l, r)
        if (isVec3(l) && isVec3(r)) return vsub(l, r)
        throw new Error(`type error: cannot subtract ${typeNameOf(r)} from ${typeNameOf(l)}`)
      case "*":
        if (typeof l === "number" && typeof r === "number") return l * r
        if (isUnitVal(l) && isUnitVal(r)) return umul(l, r)
        if (isUnitVal(l) && typeof r === "number") return umul(l, rawUnitVal(r, {}))
        if (typeof l === "number" && isUnitVal(r)) return umul(rawUnitVal(l, {}), r)
        if (isVec3(l) && typeof r === "number") return vscale(l, r)
        if (typeof l === "number" && isVec3(r)) return vscale(r, l)
        if (isVec3(l) && isUnitVal(r) && r.key === "-") return vscale(l, r.canon)
        if (isUnitVal(l) && l.key === "-" && isVec3(r)) return vscale(r, l.canon)
        if (isTransform(l) && isTransform(r)) return composeTransform(l, r)
        throw new Error(`type error: cannot multiply ${typeNameOf(l)} and ${typeNameOf(r)}`)
      case "/":
        if (typeof l === "number" && typeof r === "number") {
          if (r === 0) throw new Error("runtime error: division by zero")
          return l / r
        }
        if (isUnitVal(l) && isUnitVal(r)) return udiv(l, r)
        if (isUnitVal(l) && typeof r === "number") return udiv(l, rawUnitVal(r, {}))
        if (isVec3(l) && typeof r === "number") return vscale(l, 1 / r)
        throw new Error(`type error: cannot divide ${typeNameOf(l)} by ${typeNameOf(r)}`)
      case "%":
        if (typeof l === "number" && typeof r === "number") return ((l % r) + r) % r
        throw new Error(`type error: modulo needs plain numbers`)
      case "==":
        if (isUnitVal(l) && isUnitVal(r)) return ueq(l, r)
        return deepEq(l, r)
      case "!=":
        if (isUnitVal(l) && isUnitVal(r)) return !ueq(l, r)
        return !deepEq(l, r)
      case "<": case ">": case "<=": case ">=":
        if (typeof l === "number" && typeof r === "number") {
          switch (op) {
            case "<": return l < r
            case ">": return l > r
            case "<=": return l <= r
            case ">=": return l >= r
          }
        }
        if (isUnitVal(l) && isUnitVal(r)) return ucmp(l, r, op)
        throw new Error(`type error: cannot compare ${typeNameOf(l)} with ${typeNameOf(r)}`)
    }
    throw new Error(`internal: unknown operator ${op}`)
  }

  private async evalMember(objE: Expr, name: string, env: Env): Promise<TorqueValue> {
    const obj = await this.evalExpr(objE, env)
    // unit conversion sugar: (45).deg / x.mm / t.s
    if (isUnitVal(obj) && isUnitName(name)) {
      return convert(obj, name)
    }
    if (typeof obj === "number" && isUnitName(name)) {
      return makeUnitVal(obj, name)
    }
    if (isVec3(obj)) {
      if (name === "x") return obj.x
      if (name === "y") return obj.y
      if (name === "z") return obj.z
      if (name === "len") return vlen(obj)
    } else if (isPose(obj)) {
      if (name === "pos") return obj.pos
      if (name === "rpy") return vec3(obj.rpy[0], obj.rpy[1], obj.rpy[2])
    } else if (isTransform(obj)) {
      if (name === "trans") return obj.trans
      if (name === "rpy") return vec3(obj.rpy[0], obj.rpy[1], obj.rpy[2])
    } else if (isFrame(obj)) {
      if (name === "name") return obj.name
      if (name === "parent") return obj.parent
    }
    if (obj instanceof Map) {
      if (!obj.has(name)) throw new Error(`runtime error: map has no key '${name}'`)
      return obj.get(name)!
    }
    if (typeof obj === "string" && name === "len") return obj.length
    throw new Error(`type error: no member '${name}' on ${typeNameOf(obj)}`)
  }

  private async evalCall(e: Extract<Expr, { kind: "call" }>, env: Env): Promise<TorqueValue> {
    // Method-style conversions: x.to(mm)
    if (e.callee.kind === "member" && e.callee.name === "to") {
      const obj = await this.evalExpr(e.callee.obj, env)
      if (e.args.length !== 1) throw new Error("type error: .to(unit) takes one unit argument")
      const arg = e.args[0]
      let unitName: string
      if (arg.kind === "ident") unitName = arg.name
      else if (arg.kind === "member" && arg.name === "%") unitName = "%"
      else if (arg.kind === "num" && arg.unit) unitName = arg.unit
      else throw new Error("type error: .to(unit) expects a unit name like mm or deg")
      if (isUnitVal(obj)) return convert(obj, unitName)
      if (typeof obj === "number") return makeUnitVal(obj, unitName)
      throw new Error("type error: .to(unit) applies to quantities")
    }

    // Direct call by name: user functions are checked before env values.
    if (e.callee.kind === "ident" && this.fns.has(e.callee.name)) {
      const args0: TorqueValue[] = []
      for (const a of e.args) args0.push(await this.evalExpr(a, env))
      return this.callFn(this.fns.get(e.callee.name)!, args0)
    }

    const calleeV = await this.evalExpr(e.callee, env)
    const args: TorqueValue[] = []
    for (const a of e.args) args.push(await this.evalExpr(a, env))
    if (isBuiltin(calleeV)) {
      return calleeV.call(args)
    }
    throw new Error(`runtime error: cannot call ${typeNameOf(calleeV)}${e.callee.kind === "ident" ? ` ('${e.callee.name}')` : ""}`)
  }
}

// ---------- helpers ----------

function isBuiltin(v: TorqueValue): v is BuiltinVal {
  return typeof v === "object" && v !== null && "builtin" in (v as object) && "call" in (v as object)
}

export function truthy(v: TorqueValue): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (isUnitVal(v)) return v.canon !== 0
  return v !== null && v !== undefined
}

function deepEq(a: TorqueValue, b: TorqueValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEq(x, b[i]))
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEq(v, b.get(k)!)) return false
    }
    return true
  }
  return a === b
}

export function typeNameOf(v: TorqueValue): string {
  if (typeof v === "number") return "number"
  if (typeof v === "boolean") return "Bool"
  if (typeof v === "string") return "String"
  if (v === null || v === undefined) return "nil"
  if (isUnitVal(v)) return describeDims(v.key)
  if (isVec3(v)) return "Vec3"
  if (isTransform(v)) return "Transform3"
  if (isFrame(v)) return "Frame"
  if (Array.isArray(v)) return "array"
  if (v instanceof Map) return "map"
  if ("pos" in (v as object)) return "Pose"
  return typeof v
}

function applyCompound(op: string, cur: TorqueValue, v: TorqueValue): TorqueValue {
  switch (op) {
    case "+=": return compoundBinary("+", cur, v)
    case "-=": return compoundBinary("-", cur, v)
    case "*=": return compoundBinary("*", cur, v)
    case "/=": return compoundBinary("/", cur, v)
  }
  throw new Error(`internal: bad compound op ${op}`)
}

function compoundBinary(op: string, l: TorqueValue, r: TorqueValue): TorqueValue {
  if (op === "+") {
    if (typeof l === "number" && typeof r === "number") return l + r
    if (isUnitVal(l) && isUnitVal(r)) return uadd(l, r)
    if (typeof l === "string") return l + formatVal(r)
  }
  if (op === "-") {
    if (typeof l === "number" && typeof r === "number") return l - r
    if (isUnitVal(l) && isUnitVal(r)) return usub(l, r)
  }
  if (op === "*") {
    if (typeof l === "number" && typeof r === "number") return l * r
    if (isUnitVal(l) && isUnitVal(r)) return umul(l, r)
    if (isVec3(l) && typeof r === "number") return vscale(l, r)
    if (typeof l === "number" && isVec3(r)) return vscale(r, l)
  }
  if (op === "/") {
    if (typeof l === "number" && typeof r === "number") {
      if (r === 0) throw new Error("runtime error: division by zero")
      return l / r
    }
    if (isUnitVal(l) && isUnitVal(r)) return udiv(l, r)
  }
  throw new Error(`type error: bad operands for ${op}`)
}

const UNIT_NAME_CACHE = new Set<string>()
export function registerUnitNames(names: string[]) {
  for (const n of names) UNIT_NAME_CACHE.add(n)
}
export function isUnitName(n: string): boolean {
  return UNIT_NAME_CACHE.has(n)
}
