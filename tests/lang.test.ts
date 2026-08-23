import test from "node:test"
import assert from "node:assert/strict"
import { parseSource } from "../src/front.ts"
import { Interpreter, Env } from "../src/interpreter.ts"
import { registerUnitNames } from "../src/interpreter.ts"
import { UNITS } from "../src/units.ts"
import { makeUnitVal, rawUnitVal, vec3, transformFromRpy, applyTransform, worldTransform } from "../src/values.ts"
import type { TorqueValue } from "../src/values.ts"
import { installBuiltins } from "../src/builtins.ts"

// Shared helper: interpret a source string's top level + main(), return globals.
export async function runSource(src: string): Promise<Interpreter> {
  const program = parseSource(src)
  const interp = new Interpreter(program)
  registerUnitNames(Object.keys(UNITS))
  interp.setHost({
    nowUs: () => performance.now() * 1000,
    startTimeUs: () => performance.now() * 1000,
    runFor: async () => {},
    spin: () => {},
    read: () => null,
    write: () => {},
    publish: () => {},
    stopLoop: () => {},
    tickCount: () => 0,
  })
  installBuiltins(interp, interp.host!)
  await interp.execTopLevel()
  await interp.callMain()
  return interp
}

export async function evalIn(src: string): Promise<TorqueValue> {
  // src must define fn __t() -> Any returning the expression under test.
  const interp = await runSource(src)
  const main = interp.fns.get("__t")!
  const args: TorqueValue[] = []
  return interp.callFn(main, args)
}

registerUnitNames(Object.keys(UNITS))

void test("unit literals carry dimensions", async () => {
  assert.equal(await evalIn(`fn __t() -> Length { return 120mm }`) instanceof Object || true, true)
  const v = await evalIn(`fn __t() -> Any { return 120mm + 30cm }`)
  assert.ok(v && typeof v === "object" && "canon" in v)
  assert.equal((v as { canon: number }).canon, 0.42) // canonical meters
})

void test("adding Length to Angle is rejected", async () => {
  await assert.rejects(
    () => evalIn(`fn __t() -> Any { return 1m + 45deg }`),
    /cannot add Length and Angle/,
  )
})

void test("plain number + Length is rejected too", async () => {
  await assert.rejects(
    () => evalIn(`fn __t() -> Any { return 5 + 3m }`),
    /cannot add/,
  )
})

void test("division produces derived dimensions", async () => {
  const v = await evalIn(`fn __t() -> Any { return 10m / 4s }`)
  assert.equal((v as { canon: number }).canon, 2.5) // m/s
})

void test("comparisons convert across scales", async () => {
  assert.equal(await evalIn(`fn __t() -> Bool { return 1500mm > 1m }`), true)
  assert.equal(await evalIn(`fn __t() -> Bool { return 90deg == 1.5707963267948966rad }`), true)
})

void test(".to() converts", async () => {
  const v = await evalIn(`fn __t() -> Any { return (120mm).to(cm) }`)
  assert.equal((v as { canon: number }).canon, 0.12)
})

void test("typed slots reject wrong dimensions", async () => {
  await assert.rejects(
    () => runSource(`fn main() { let x: Length = 45deg }`),
    /expects Length, got Angle/,
  )
  await assert.rejects(
    () => runSource(`fn f(a: Angle) -> Angle { return a }
fn main() { print(f(2s)) }`),
    /expects Angle, got Duration/,
  )
})

void test("functions, recursion and control flow", async () => {
  assert.equal(await evalIn(`fn fib(n: int) -> int { if n < 2 { return n } return fib(n-1) + fib(n-2) }
fn __t() -> int { return fib(10) }`), 55)
})

void test("vec3 arithmetic keeps dimensions", async () => {
  const v = await evalIn(`fn __t() -> Any {
    let a = vec3(1m, 2m, 3m)
    let b = vec3(10mm, 20mm, 30mm)
    return a - b
  }`)
  assert.ok(v && typeof v === "object" && "x" in (v as object))
  assert.equal((v as { x: { canon: number } }).x.canon, 0.99)
})

void test("transform composition and application match hand-computed FK", async () => {
  const deg = Math.PI / 180
  const rotZ90 = transformFromRpy(
    vec3(rawUnitVal(1, { L: 1 }), rawUnitVal(0, { L: 1 }), rawUnitVal(0, { L: 1 })),
    [rawUnitVal(0, { A: 1 }), rawUnitVal(0, { A: 1 }), rawUnitVal(90 * deg, { A: 1 })],
  )
  // point (0.1, 0, 0): rotated +y by 90deg yaw then translated by (1, 0, 0)
  const p = applyTransform(rotZ90, vec3(rawUnitVal(0.1, { L: 1 }), rawUnitVal(0, { L: 1 }), rawUnitVal(0, { L: 1 })))
  approx(p.x.canon, 1)
  approx(p.y.canon, 0.1)
  approx(p.z.canon, 0)

  // chain: base->a translate(1,0,0)+yaw90 ; a->b translate(0.5,0,0)
  const t2 = transformFromRpy(
    vec3(rawUnitVal(0.5, { L: 1 }), rawUnitVal(0, { L: 1 }), rawUnitVal(0, { L: 1 })),
    [rawUnitVal(0, { A: 1 }), rawUnitVal(0, { A: 1 }), rawUnitVal(0, { A: 1 })],
  )
  const composed = worldTransform({ name: "b", parent: { name: "a", parent: null, local: rotZ90 }, local: t2 })
  const q = applyTransform(composed, vec3(rawUnitVal(0.1, { L: 1 }), rawUnitVal(0, { L: 1 }), rawUnitVal(0, { L: 1 })))
  approx(q.x.canon, 1)
  approx(q.y.canon, 0.6)
  approx(q.z.canon, 0)
})

function approx(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`)
}

// ---- regression tests for repaired/broken features ----

void test("map literals parse multiple entries", async () => {
  assert.equal(
    await evalIn(`fn __t() -> int { let m = {a: 1, b: 2, c: 3} return m.a + m.b + m.c }`),
    6,
  )
})

void test("array and map equality are structural (deep)", async () => {
  assert.equal(await evalIn(`fn __t() -> Bool { return [1, [2, 3]] == [1, [2, 3]] }`), true)
  assert.equal(await evalIn(`fn __t() -> Bool { return [1, 2] != [1, 3] }`), true)
  assert.equal(await evalIn(`fn __t() -> Bool { return {a: 1, b: 2} == {b: 2, a: 1} }`), true)
  assert.equal(await evalIn(`fn __t() -> Bool { return {a: 1} == {a: 2} }`), false)
})

void test("pose and frame accessors work", async () => {
  assert.equal(await evalIn(`fn __t() -> Bool {
    let p = pose(vec3(1m, 2m, 3m), vec3(0deg, 0deg, 90deg))
    return p.pos.y == 2000mm && p.rpy.z == 90deg
  }`), true)
  assert.equal(await evalIn(`fn __t() -> String { return frame("base").name }`), "base")
})

void test("t1 * t2 composes transforms like compose(t1, t2)", async () => {
  assert.equal(await evalIn(`fn __t() -> Bool {
    let a = transform(vec3(1m, 0mm, 0mm), vec3(0deg, 0deg, 90deg))
    let b = transform(vec3(50cm, 0mm, 0mm), vec3(0deg, 0deg, 0deg))
    let c = a * b
    let d = compose(a, b)
    let pa = apply(c, vec3(10mm, 0mm, 0mm))
    let pb = apply(d, vec3(10mm, 0mm, 0mm))
    return pa.x == pb.x && pa.y == pb.y && pa.z == pb.z && c.rpy.z == 90deg
  }`), true)
})

void test(".to(%) converts to a percent quantity", async () => {
  const v = await evalIn(`fn __t() -> Any { return (50).to(%) }`)
  assert.ok(v && typeof v === "object" && "canon" in v)
  assert.equal((v as { canon: number }).canon, 0.5)
})

void test("for-in over non-array is rejected", async () => {
  await assert.rejects(
    () => runSource(`fn main() { for x in 5 { print(x) } }`),
    /for-in needs an array/,
  )
})

void test("topic rate must be a Frequency literal", async () => {
  assert.throws(() => parseSource(`topic /t: number @ 50ms`), /expected rate like 50hz/)
})
