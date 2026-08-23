// Runtime value model for Torque.
//
// Scalars are plain JS numbers (dimensionless). Unit-typed quantities are
// UnitVal. Geometry types (Vec3 / Transform3 / Pose / Frame) are fixed-size
// records over UnitVals — they never grow, which keeps armed loops
// allocation-light.

import { formatUnitVal, trimNum, UNITS, describeDims, makeUnitVal, rawUnitVal, dimsKey, mulDims, divDims } from "./units.ts"
import type { UnitVal, DimMap } from "./units.ts"

// ---------- scalar unit arithmetic ----------

export function uadd(a: UnitVal, b: UnitVal): UnitVal {
  if (a.key !== b.key) {
    throw new Error(`type error: cannot add ${describeDims(a.key)} and ${describeDims(b.key)}`)
  }
  const out = rawUnitVal(a.canon + b.canon, a.dims)
  out.hint = a.hint
  return out
}
export function usub(a: UnitVal, b: UnitVal): UnitVal {
  if (a.key !== b.key) {
    throw new Error(`type error: cannot subtract ${describeDims(b.key)} from ${describeDims(a.key)}`)
  }
  const out = rawUnitVal(a.canon - b.canon, a.dims)
  out.hint = a.hint
  return out
}
export function umul(a: UnitVal, b: UnitVal): UnitVal {
  const dims = mulDims(a.dims, b.dims)
  const out = rawUnitVal(a.canon * b.canon, dims)
  if (b.key === "-" && a.key !== "-") { out.hint = a.hint }        // Angle * 2 -> keep display
  else if (a.key === "-" && b.key !== "-") { out.hint = b.hint }
  return out
}
export function udiv(a: UnitVal, b: UnitVal): UnitVal {
  if (b.canon === 0) throw new Error("runtime error: division by zero")
  const dims = divDims(a.dims, b.dims)
  if (b.key === "-") {
    const out = rawUnitVal(a.canon / b.canon, a.dims)
    out.hint = a.hint
    return out
  }
  return rawUnitVal(a.canon / b.canon, dims)
}
export function uneg(a: UnitVal): UnitVal {
  return rawUnitVal(-a.canon, a.dims)
}
export function ucmp(a: UnitVal, b: UnitVal, op: string): boolean {
  if (a.key !== b.key) {
    throw new Error(`type error: cannot compare ${describeDims(a.key)} with ${describeDims(b.key)}`)
  }
  switch (op) {
    case "<": return a.canon < b.canon
    case ">": return a.canon > b.canon
    case "<=": return a.canon <= b.canon
    case ">=": return a.canon >= b.canon
  }
  throw new Error(`internal: bad comparison '${op}'`)
}
export function ueq(a: UnitVal, b: UnitVal): boolean {
  if (a.key !== b.key) return false
  return Math.abs(a.canon - b.canon) < 1e-12 * Math.max(1, Math.abs(a.canon))
}

export function convert(v: UnitVal, unitName: string): UnitVal {
  const def = UNITS[unitName]
  if (!def) throw new Error(`unknown unit '${unitName}'`)
  if (dimsKey(def.dims) !== v.key) {
    throw new Error(`type error: cannot convert ${describeDims(v.key)} to ${unitName}`)
  }
  const out = rawUnitVal(v.canon, v.dims)
  out.hint = unitName
  // canon stays canonical; hint only changes display
  return { ...out, canon: v.canon }
}

export function formatVal(v: unknown): string {
  if (typeof v === "number") return trimNum(v)
  if (typeof v === "boolean") return v ? "true" : "false"
  if (v === null || v === undefined) return "nil"
  if (typeof v === "string") return v
  if (isUnitVal(v)) return formatUnitVal(v)
  if (isVec3(v)) return `(${formatVal(v.x)}, ${formatVal(v.y)}, ${formatVal(v.z)})`
  if (isPose(v)) return `pose(pos=${formatVal(v.pos)}, rpy=${formatVal(v.rpy)})`
  if (isTransform(v)) return `transform(t=${formatVal(v.trans)}, rpy=${formatVal(v.rpy)})`
  if (isFrame(v)) return `frame(${v.name}${v.parent ? " <- " + v.parent.name : ""})`
  if (Array.isArray(v)) return "[" + v.map(formatVal).join(", ") + "]"
  if (v instanceof Map) {
    return "{" + [...v.entries()].map(([k, val]) => `${k}: ${formatVal(val)}`).join(", ") + "}"
  }
  return String(v)
}

// ---------- geometry ----------

export interface Vec3Val {
  x: UnitVal
  y: UnitVal
  z: UnitVal
  dims: DimMap
}

export type TorqueValue =
  | number | boolean | string | null
  | UnitVal | Vec3Val | PoseVal | TransformVal | FrameVal
  | TorqueValue[] | Map<string, TorqueValue>
  | BuiltinVal

export interface BuiltinVal {
  builtin: string                       // name, e.g. "sin"
  call: (args: TorqueValue[]) => TorqueValue
}

export function makeBuiltin(name: string, call: (args: TorqueValue[]) => TorqueValue): BuiltinVal {
  return { builtin: name, call }
}

export function vec3(x: UnitVal, y: UnitVal, z: UnitVal): Vec3Val {
  if (!(x.key === y.key && y.key === z.key)) {
    throw new Error("type error: vec3 components must share dimensions")
  }
  return { x, y, z, dims: x.dims }
}

function requireSameDims(a: Vec3Val, b: Vec3Val, what: string) {
  if (a.x.key !== b.x.key) {
    throw new Error(`type error: cannot ${what} vectors of different dimensions`)
  }
}

export function vadd(a: Vec3Val, b: Vec3Val): Vec3Val {
  requireSameDims(a, b, "add")
  return vec3(uadd(a.x, b.x), uadd(a.y, b.y), uadd(a.z, b.z))
}
export function vsub(a: Vec3Val, b: Vec3Val): Vec3Val {
  requireSameDims(a, b, "subtract")
  return vec3(usub(a.x, b.x), usub(a.y, b.y), usub(a.z, b.z))
}
export function vscale(v: Vec3Val, s: number): Vec3Val {
  return { x: umul(v.x, rawUnitVal(s, {})), y: umul(v.y, rawUnitVal(s, {})), z: umul(v.z, rawUnitVal(s, {})), dims: v.dims }
}
export function vneg(v: Vec3Val): Vec3Val {
  return vec3(uneg(v.x), uneg(v.y), uneg(v.z))
}
export function vlen(v: Vec3Val): UnitVal {
  const n = Math.hypot(v.x.canon, v.y.canon, v.z.canon)
  const out = rawUnitVal(n, v.x.dims)
  out.hint = v.x.hint
  return out
}
export function vdot(a: Vec3Val, b: Vec3Val): number {
  requireSameDims(a, b, "dot")
  return a.x.canon * b.x.canon + a.y.canon * b.y.canon + a.z.canon * b.z.canon
}

// ---------- transforms ----------

export interface TransformVal {
  r: [number, number, number, number, number, number, number, number, number] // row-major rotation matrix (canonical units assumed consistent)
  trans: Vec3Val            // translation (Length)
  rpy: [UnitVal, UnitVal, UnitVal] // original roll/pitch/yaw for display
}

const IDENT3: TransformVal["r"] = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export function transformFromRpy(trans: Vec3Val, rpy: [UnitVal, UnitVal, UnitVal]): TransformVal {
  const cr = Math.cos(rpy[0].canon), sr = Math.sin(rpy[0].canon)
  const cp = Math.cos(rpy[1].canon), sp = Math.sin(rpy[1].canon)
  const cy = Math.cos(rpy[2].canon), sy = Math.sin(rpy[2].canon)
  // R = Rz(yaw) * Ry(pitch) * Rx(roll)   (ZYX convention, aerospace-style)
  const r: TransformVal["r"] = [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
    -sp, cp * sr, cp * cr,
  ]
  return { r, trans, rpy }
}

export function composeTransform(a: TransformVal, b: TransformVal): TransformVal {
  // a ∘ b : first apply b, then a
  const r: number[] = new Array(9)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0
      for (let k = 0; k < 3; k++) s += a.r[i * 3 + k] * b.r[k * 3 + j]
      r[i * 3 + j] = s
    }
  }
  const bt = b.trans
  const rt = rotPoint(a.r, bt)
  const trans = vec3(
    rawUnitVal(rt[0] + a.trans.x.canon, a.trans.x.dims),
    rawUnitVal(rt[1] + a.trans.y.canon, a.trans.y.dims),
    rawUnitVal(rt[2] + a.trans.z.canon, a.trans.z.dims),
  )
  const yaw = Math.atan2(r[3], r[0])
  const pitch = Math.atan2(-r[6], Math.hypot(r[7], r[8]))
  const roll = Math.atan2(r[7], r[8])
  const rad = (x: number) => rawUnitVal(x, { A: 1 })
  return { r: r as never, trans, rpy: [rad(roll), rad(pitch), rad(yaw)] }
}

export function applyTransform(t: TransformVal, p: Vec3Val): Vec3Val {
  if (p.x.key !== "L1") throw new Error("type error: can only transform Length vectors through space")
  const rp = rotPoint(t.r, p)
  return vec3(
    rawUnitVal(rp[0] + t.trans.x.canon, t.trans.x.dims),
    rawUnitVal(rp[1] + t.trans.y.canon, t.trans.y.dims),
    rawUnitVal(rp[2] + t.trans.z.canon, t.trans.z.dims),
  )
}

function rotPoint(r: readonly number[], p: Vec3Val): [number, number, number] {
  const x = p.x.canon, y = p.y.canon, z = p.z.canon
  return [
    r[0] * x + r[1] * y + r[2] * z,
    r[3] * x + r[4] * y + r[5] * z,
    r[6] * x + r[7] * y + r[8] * z,
  ]
}

export const IDENTITY_TRANSFORM: TransformVal = {
  r: [...IDENT3] as never,
  trans: vec3(rawUnitVal(0, { L: 1 }), rawUnitVal(0, { L: 1 }), rawUnitVal(0, { L: 1 })),
  rpy: [
    rawUnitVal(0, { A: 1 }), rawUnitVal(0, { A: 1 }), rawUnitVal(0, { A: 1 }),
  ],
}

// ---------- pose & frames ----------

export interface PoseVal {
  pos: Vec3Val       // Length
  rpy: [UnitVal, UnitVal, UnitVal] // Angle
}

export interface FrameVal {
  name: string
  parent: FrameVal | null
  local: TransformVal | null   // transform relative to parent
}

export function worldTransform(f: FrameVal): TransformVal {
  const chain: FrameVal[] = []
  for (let cur: FrameVal | null = f; cur !== null; cur = cur.parent) chain.push(cur)
  let acc: TransformVal | null = null
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]
    if (node.local === null) continue
    acc = acc === null ? node.local : composeTransform(acc, node.local)
  }
  return acc ?? IDENTITY_TRANSFORM
}

// ---------- type predicates ----------

export function isUnitVal(v: unknown): v is UnitVal {
  return typeof v === "object" && v !== null && "canon" in (v as object) && "key" in (v as object)
}
export function isVec3(v: unknown): v is Vec3Val {
  return typeof v === "object" && v !== null && "x" in (v as object) && "y" in (v as object) && "z" in (v as object)
}
export function isPose(v: unknown): v is PoseVal {
  return typeof v === "object" && v !== null && "pos" in (v as object) && "rpy" in (v as object)
}
export function isTransform(v: unknown): v is TransformVal {
  return typeof v === "object" && v !== null && "r" in (v as object) && "trans" in (v as object)
}
export function isFrame(v: unknown): v is FrameVal {
  return typeof v === "object" && v !== null && "name" in (v as object) && "parent" in (v as object)
}

export { makeUnitVal, rawUnitVal, formatUnitVal, trimNum } from "./units.ts"
