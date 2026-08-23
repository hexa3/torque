// Dimensional analysis core.
//
// Every unit-typed value carries its value converted to a canonical SI-ish
// base plus a dimension signature (exponents over L=length, M=mass, T=time,
// A=angle). Addition requires identical signatures; multiplication/division
// compose signatures. This catches `1m + 1deg` at runtime with precise
// messages.

export const BASE_DIMS = ["L", "M", "T", "A"] as const

export type DimMap = Record<string, number> // e.g. { L: 1, T: -2 }

export function dimsKey(d: DimMap): string {
  let k = ""
  for (const base of BASE_DIMS) {
    const e = d[base] ?? 0
    if (e !== 0) k += `${base}${e}`
  }
  return k === "" ? "-" : k // "-" == dimensionless
}

export function mulDims(a: DimMap, b: DimMap): DimMap {
  const out: DimMap = {}
  for (const base of BASE_DIMS) {
    const e = (a[base] ?? 0) + (b[base] ?? 0)
    if (e !== 0) out[base] = e
  }
  return out
}

export function divDims(a: DimMap, b: DimMap): DimMap {
  const out: DimMap = {}
  for (const base of BASE_DIMS) {
    const e = (a[base] ?? 0) - (b[base] ?? 0)
    if (e !== 0) out[base] = e
  }
  return out
}

export interface UnitDef {
  name: string
  dims: DimMap
  scale: number          // multiply literal by this to reach canonical units
                         // (canonical length=m, mass=kg, time=s, angle=rad)
}

function u(name: string, scale: number, dims: DimMap): UnitDef {
  return { name, scale, dims }
}

export const UNITS: Record<string, UnitDef> = {
  m: u("m", 1, { L: 1 }),
  mm: u("mm", 1e-3, { L: 1 }),
  cm: u("cm", 1e-2, { L: 1 }),
  km: u("km", 1e3, { L: 1 }),
  inch: u("inch", 0.0254, { L: 1 }),
  in: u("in", 0.0254, { L: 1 }),
  ft: u("ft", 0.3048, { L: 1 }),

  rad: u("rad", 1, { A: 1 }),
  deg: u("deg", Math.PI / 180, { A: 1 }),
  rev: u("rev", Math.PI * 2, { A: 1 }),

  s: u("s", 1, { T: 1 }),
  ms: u("ms", 1e-3, { T: 1 }),
  us: u("us", 1e-6, { T: 1 }),
  min: u("min", 60, { T: 1 }),

  kg: u("kg", 1, { M: 1 }),
  g: u("g", 1e-3, { M: 1 }),

  hz: u("hz", 1, { T: -1 }),

  N: u("N", 1, { L: 1, M: 1, T: -2 }),
  Nm: u("Nm", 1, { L: 2, M: 1, T: -2 }),

  "%": u("%", 0.01, {}),   // percent is dimensionless, scaled to plain units
}

export interface UnitVal {
  canon: number        // value in canonical units
  key: string          // dimension signature key
  dims: DimMap
  hint?: string        // original unit name for display, e.g. "mm"
}

export function makeUnitVal(value: number, unitName: string): UnitVal {
  const def = UNITS[unitName]
  if (!def) throw new Error(`unknown unit '${unitName}'`)
  return { canon: value * def.scale, key: dimsKey(def.dims), dims: { ...def.dims }, hint: unitName === "%" ? undefined : unitName }
}

export function rawUnitVal(canon: number, dims: DimMap): UnitVal {
  return { canon, key: dimsKey(dims), dims }
}

// Friendly names for common signatures, used in error messages and printing.
const DIM_NAMES: Array<{ key: string; name: string; unit: string }> = [
  { key: "L1", name: "Length", unit: "m" },
  { key: "A1", name: "Angle", unit: "rad" },
  { key: "T1", name: "Duration", unit: "s" },
  { key: "M1", name: "Mass", unit: "kg" },
  { key: "T-1", name: "Frequency", unit: "hz" },
  { key: "L1T-1", name: "Velocity", unit: "m/s" },
  { key: "A1T-1", name: "AngularVelocity", unit: "rad/s" },
  { key: "L1M1T-2", name: "Force", unit: "N" },
  { key: "L2M1T-2", name: "Torque", unit: "Nm" },
]

export function describeDims(key: string): string {
  if (key === "-") return "number"
  const hit = DIM_NAMES.find(d => d.key === key)
  if (hit) return hit.name
  return "quantity<" + key + ">"
}

export function canonicalUnitName(key: string): string {
  const hit = DIM_NAMES.find(d => d.key === key)
  if (hit) return hit.unit
  return key
}

export function formatUnitVal(v: UnitVal): string {
  const num = trimNum(v.canon)
  if (v.hint && UNITS[v.hint]) return `${trimNum(v.canon / UNITS[v.hint].scale)} ${v.hint}`
  if (v.key === "-") return String(num)
  return `${num} ${canonicalUnitName(v.key)}`
}

export function trimNum(n: number): string {
  if (!isFinite(n)) return String(n)
  if (Number.isInteger(n)) return String(n)
  const r = Math.round(n * 1000) / 1000
  return String(r)
}
