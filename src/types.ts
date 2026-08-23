// Named-type registry: maps Torque type names to runtime checks/coercions.
// Used for typed variable annotations, function params/returns, and topic
// payload declarations.

import { isUnitVal, isVec3, isPose, isTransform, isFrame } from "./values.ts"
import type { TorqueValue } from "./values.ts"
import { describeDims } from "./units.ts"

const DIM_TYPES: Record<string, string> = {
  Length: "L1",
  Angle: "A1",
  Duration: "T1",
  Mass: "M1",
  Frequency: "T-1",
  Velocity: "L1T-1",
  AngularVelocity: "A1T-1",
  Force: "L1M1T-2",
  Torque: "L2M1T-2",
}

const SCALAR_ALIASES = new Set(["number", "f64", "f32", "int", "i32"])
const BOOL_ALIASES = new Set(["Bool", "bool", "boolean"])
const STRING_ALIASES = new Set(["String", "str"])

export function checkType(typeName: string, v: TorqueValue, what: string): TorqueValue {
  const dimKey = DIM_TYPES[typeName]
  if (dimKey) {
    if (!isUnitVal(v)) {
      throw new Error(`type error: ${what} expects ${typeName}, got ${describe(typeof v === "number" ? "-" : String(v))}`)
    }
    if (v.key !== dimKey) {
      throw new Error(`type error: ${what} expects ${typeName}, got ${describeDims(v.key)}`)
    }
    return v
  }
  if (SCALAR_ALIASES.has(typeName)) {
    if (typeof v === "number") return v
    if (isUnitVal(v) && v.key === "-") return v.canon
    throw new Error(`type error: ${what} expects ${typeName}, got ${describe("val")}`)
  }
  if (BOOL_ALIASES.has(typeName)) {
    if (typeof v === "boolean") return v
    throw new Error(`type error: ${what} expects ${typeName}, got ${typeof v}`)
  }
  if (STRING_ALIASES.has(typeName)) {
    if (typeof v === "string") return v
    throw new Error(`type error: ${what} expects ${typeName}, got ${typeof v}`)
  }
  if (typeName === "Vec3") {
    if (isVec3(v)) return v
    throw new Error(`type error: ${what} expects Vec3`)
  }
  if (typeName === "Pose") {
    if (isPose(v)) return v
    throw new Error(`type error: ${what} expects Pose`)
  }
  if (typeName === "Transform3" || typeName === "Transform") {
    if (isTransform(v)) return v
    throw new Error(`type error: ${what} expects Transform3`)
  }
  if (typeName === "Frame") {
    if (isFrame(v)) return v
    throw new Error(`type error: ${what} expects Frame`)
  }
  if (typeName === "Any") return v
  // Array types like [f64]
  const arrMatch = /^\[\s*(\w+)\s*\]$/.exec(typeName)
  if (arrMatch) {
    if (!Array.isArray(v)) throw new Error(`type error: ${what} expects ${typeName}`)
    for (let i = 0; i < v.length; i++) checkType(arrMatch[1], v[i], `${what}[${i}]`)
    return v
  }
  throw new Error(`unknown type '${typeName}' in ${what}`)
}

export function describe(hint: string): string {
  if (hint === "-") return "number"
  return hint
}
