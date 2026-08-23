// Builtin functions exposed to Torque programs.

import type { Interpreter, RuntimeHost } from "./interpreter.ts"
import {
  makeBuiltin, vec3, vadd, vsub, vlen, vdot, umul, usub, udiv,
  formatVal, transformFromRpy, composeTransform, applyTransform, worldTransform,
  rawUnitVal, isUnitVal, isVec3, isFrame, isTransform,
} from "./values.ts"
import type { TorqueValue, UnitVal, Vec3Val, TransformVal, PoseVal, FrameVal } from "./values.ts"
import type { FnDecl } from "./ast.ts"

function num(v: TorqueValue, what: string): number {
  if (typeof v === "number") return v
  if (isUnitVal(v) && v.key === "-") return v.canon
  throw new Error(`type error: ${what} expects a plain number`)
}

export function installBuiltins(interp: Interpreter, host: NonNullable<Interpreter["host"]>) {
  const g = interp.globals
  const def = (name: string, fn: (args: TorqueValue[]) => TorqueValue) => {
    g.define(name, makeBuiltin(name, args => fn(args)))
  }
  const defAsync = (name: string, fn: (args: TorqueValue[]) => Promise<TorqueValue>) => {
    g.define(name, makeBuiltin(name, args => fn(args)))
  }

  // ---- output ----
  def("print", args => {
    console.log(args.map(a => formatVal(a)).join(" "))
    return null
  })

  // ---- trigonometry (unit-aware: angles in, numbers out) ----
  const angle1 = (name: string, f: (x: number) => number) => def(name, args => {
    const a = args[0]
    if (!isUnitVal(a) || a.key !== "A1") throw new Error(`type error: ${name}() expects an Angle like 30deg`)
    return f(a.canon)
  })
  angle1("sin", Math.sin)
  angle1("cos", Math.cos)
  angle1("tan", Math.tan)
  def("atan2", args => {
    const y = num(args[0], "atan2"), x = num(args[1], "atan2")
    return rawUnitVal(Math.atan2(y, x), { A: 1 })
  })

  // ---- scalar math ----
  def("abs", args => {
    const a = args[0]
    if (typeof a === "number") return Math.abs(a)
    if (isUnitVal(a)) return rawUnitVal(Math.abs(a.canon), a.dims)
    if (isVec3(a)) return vlen(a)
    throw new Error("type error: abs() expects a number or quantity")
  })
  def("sqrt", args => {
    const a = num(args[0], "sqrt")
    if (a < 0) throw new Error("runtime error: sqrt of negative")
    return Math.sqrt(a)
  })
  def("pow", args => Math.pow(num(args[0], "pow"), num(args[1], "pow")))
  def("floor", args => Math.floor(num(args[0], "floor")))
  def("ceil", args => Math.ceil(num(args[0], "ceil")))
  def("round", args => Math.round(num(args[0], "round")))
  def("min", args => reduceAll(args, "min"))
  def("max", args => reduceAll(args, "max"))
  def("clamp", args => {
    const [v, lo, hi] = args
    if (typeof v === "number" && typeof lo === "number" && typeof hi === "number") {
      return Math.min(hi, Math.max(lo, v))
    }
    if (isUnitVal(v) && isUnitVal(lo) && isUnitVal(hi)) {
      if (!(v.key === lo.key && lo.key === hi.key)) throw new Error("type error: clamp() arguments must share dimensions")
      const c = v.canon < lo.canon ? lo : v.canon > hi.canon ? hi : v
      return rawUnitVal(c.canon, c.dims)
    }
    throw new Error("type error: clamp(v, lo, hi)")
  })
  def("rand", () => Math.random())

  // ---- arrays / strings / maps ----
  def("len", args => {
    const a = args[0]
    if (Array.isArray(a)) return a.length
    if (a instanceof Map) return a.size
    if (typeof a === "string") return a.length
    throw new Error("type error: len() expects an array, map or string")
  })
  def("push", args => {
    const [arr, ...vals] = args
    if (!Array.isArray(arr)) throw new Error("type error: push() expects an array")
    for (const v of vals) arr.push(v)
    return arr.length
  })
  def("pop", args => {
    const arr = args[0]
    if (!Array.isArray(arr)) throw new Error("type error: pop() expects an array")
    return arr.length > 0 ? arr.pop()! : null
  })
  def("str", args => formatVal(args[0]))
  def("num", args => {
    const n = Number(args[0])
    if (Number.isNaN(n)) throw new Error(`runtime error: num(${formatVal(args[0])}) is not a number`)
    return n
  })
  def("keys", args => {
    const m = args[0]
    if (!(m instanceof Map)) throw new Error("type error: keys() expects a map")
    return [...m.keys()]
  })

  // ---- time ----
  def("now", () => rawUnitVal((host.nowUs() - host.startTimeUs()) / 1e6, { T: 1 }))
  defAsync("run_for", async args => { await host.runFor(args[0]); return null })
  def("spin", args => { host.spin(args[0]); return null })
  def("tick_count", () => host.tickCount())

  // ---- control ----
  def("stop", args => {
    host.stopLoop(typeof args[0] === "string" ? args[0] : undefined)
    return null
  })

  // ---- geometry ----
  def("vec3", args => {
    if (args.length !== 3) throw new Error("type error: vec3(x, y, z)")
    const asU = args.map(a => isUnitVal(a) ? a : typeof a === "number" ? rawUnitVal(a, {}) : null)
    if (asU.some(a => a === null)) throw new Error("type error: vec3 components must be numeric")
    return vec3(asU[0]!, asU[1]!, asU[2]!)
  })
  def("transform", args => {
    const [trans, rpy] = args
    if (!isVec3(trans)) throw new Error("type error: transform(translation: Vec3<Length>, rpy: Vec3<Angle>)")
    if (trans.x.key !== "L1") throw new Error("type error: translation must be Length")
    if (!isVec3(rpy) || rpy.x.key !== "A1") throw new Error("type error: rotation must be Vec3 of Angle (roll, pitch, yaw)")
    return transformFromRpy(trans, [rpy.x, rpy.y, rpy.z])
  })
  def("compose", args => {
    const [a, b] = args
    if (!isTransform(a) || !isTransform(b)) throw new Error("type error: compose(t1, t2)")
    return composeTransform(a, b)
  })
  def("apply", args => {
    const [t, p] = args
    if (!isTransform(t) || !isVec3(p)) throw new Error("type error: apply(transform, point)")
    return applyTransform(t, p)
  })
  def("pose", args => {
    const [pos, rpy] = args
    if (!isVec3(pos) || pos.x.key !== "L1") throw new Error("type error: pose(pos: Vec3<Length>, rpy: Vec3<Angle>)")
    if (!isVec3(rpy) || rpy.x.key !== "A1") throw new Error("type error: pose rotation must be Vec3 of Angle")
    return { pos, rpy: [rpy.x, rpy.y, rpy.z] } as PoseVal
  })
  def("frame", args => {
    const name = args[0]
    if (typeof name !== "string") throw new Error("type error: frame(name[, parent[, local_transform]])")
    const parent = args.length > 1 ? args[1] : null
    if (parent !== null && !isFrame(parent)) throw new Error("type error: frame parent must be a Frame")
    const local = args.length > 2 ? args[2] : null
    if (local !== null && !isTransform(local)) throw new Error("type error: frame local must be a Transform3")
    const f: FrameVal = { name, parent: parent as FrameVal | null, local: local as TransformVal | null }
    return f
  })
  def("place", args => {
    const [f, t] = args
    if (!isFrame(f) || !isTransform(t)) throw new Error("type error: place(frame, transform)")
    f.local = t
    return null
  })
  def("world_transform", args => {
    if (!isFrame(args[0])) throw new Error("type error: world_transform(frame)")
    return worldTransform(args[0])
  })
  def("dot", args => {
    if (!isVec3(args[0]) || !isVec3(args[1])) throw new Error("type error: dot(a, b)")
    return vdot(args[0], args[1])
  })
  def("cross", args => {
    if (!isVec3(args[0]) || !isVec3(args[1])) throw new Error("type error: cross(a, b)")
    const a = args[0], b = args[1]
    const c = (x: UnitVal, y: UnitVal) => umul(x, y)
    return vec3(
      usub(c(a.y, b.z), c(a.z, b.y)),
      usub(c(a.z, b.x), c(a.x, b.z)),
      usub(c(a.x, b.y), c(a.y, b.x)),
    )
  })

  // ---- backend I/O & pub/sub ----
  def("read", args => {
    if (typeof args[0] !== "string") throw new Error("type error: read(channel: String)")
    return host.read(args[0])
  })
  def("write", args => {
    if (typeof args[0] !== "string") throw new Error("type error: write(channel: String, value)")
    host.write(args[0], args[1])
    return null
  })
  def("publish", args => {
    let path = args[0]
    if (typeof path !== "string") throw new Error("type error: publish(/topic, value)")
    if (!path.startsWith("/")) throw new Error("type error: topic paths start with '/'")
    host.publish(path.slice(1), args[1])
    return null
  })
}

function reduceAll(args: TorqueValue[], mode: "min" | "max"): TorqueValue {
  if (args.length === 0) throw new Error(`type error: ${mode}() needs arguments`)
  if (args.every(a => typeof a === "number")) {
    return mode === "min" ? Math.min(...(args as number[])) : Math.max(...(args as number[]))
  }
  if (args.every(isUnitVal)) {
    const key = (args[0] as UnitVal).key
    if (!args.every(a => (a as UnitVal).key === key)) throw new Error(`type error: ${mode}() arguments must share dimensions`)
    let best = args[0] as UnitVal
    for (const a of args as UnitVal[]) {
      if (mode === "min" ? a.canon < best.canon : a.canon > best.canon) best = a
    }
    return rawUnitVal(best.canon, best.dims)
  }
  throw new Error(`type error: ${mode}() over mixed types`)
}
