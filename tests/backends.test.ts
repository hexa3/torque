import test from "node:test"
import assert from "node:assert/strict"
import { SimBackend } from "../src/backends/sim.ts"
import { SerialBackend, angleToPulseUs, pulseUsToAngle } from "../src/backends/serial.ts"
import type { SerialTransport } from "../src/backends/serial.ts"
import { Bus } from "../src/bus.ts"
import { vec3, rawUnitVal, formatVal } from "../src/values.ts"

const deg = (d: number) => rawUnitVal(d * Math.PI / 180, { A: 1 })

void test("sim backend: joints slew toward targets at a bounded rate", async () => {
  const sim = new SimBackend()
  await sim.start()
  sim.write("targets", vec3(deg(0), deg(0), deg(0)))
  const before = sim.read("angles") as { x: { canon: number } }
  assert.equal(before.x.canon, 0)

  // Command a big jump; immediately reading should show only partial progress.
  sim.write("targets", vec3(deg(90), deg(90), deg(90)))
  const early = sim.read("angles") as { x: { canon: number } }
  const earlyDeg = (early.x.canon * 180) / Math.PI
  assert.ok(earlyDeg >= 0 && earlyDeg < 45, `expected partial slew, got ${earlyDeg}`)

  // Polling like a control loop does (every 20ms), it converges well within
  // 700ms at the modeled slew rate (~162 deg/s).
  let lateDeg = 0
  for (let i = 0; i < 35; i++) {
    await new Promise(r => setTimeout(r, 20))
    const a = sim.read("angles") as { x: { canon: number } }
    lateDeg = (a.x.canon * 180) / Math.PI
  }
  assert.ok(lateDeg > 85, `expected convergence to ~90deg while polling, got ${lateDeg}`)
})

void test("sim backend rejects wrong channels and wrong payload dims", async () => {
  const sim = new SimBackend()
  await sim.start()
  assert.throws(() => sim.read("bogus"), /unknown read channel/)
  assert.throws(() => sim.write("bogus", null as never), /unknown write channel/)
  assert.throws(
    () => sim.write("targets", vec3(rawUnitVal(1, {}), rawUnitVal(1, {}), rawUnitVal(1, {})) as never),
    /Vec3 of Angles/,
  )
})

void test("serial pulse mapping is exact at the rails and center", () => {
  assert.equal(angleToPulseUs(-Math.PI / 2), 500)
  assert.equal(angleToPulseUs(0), 1500)
  assert.equal(angleToPulseUs(Math.PI / 2), 2500)
  // clamps beyond range
  assert.equal(angleToPulseUs(Math.PI), 2500)
  // round trip
  for (const d of [-80, -30, 0, 15, 88]) {
    assert.ok(Math.abs(pulseUsToAngle(angleToPulseUs(d * Math.PI / 180)) * 180 / Math.PI - d) < 0.2)
  }
})

interface CapturingTransport extends SerialTransport {
  lines: string[]
  feed(line: string): void
}

function capturingTransport(): CapturingTransport {
  const listeners: Array<(l: string) => void> = []
  return {
    lines: [],
    write(bytes: string) { this.lines.push(...bytes.split("\n").filter(l => l.length > 0)) },
    onData(cb: (l: string) => void) { listeners.push(cb) },
    feed(line: string) { for (const cb of listeners) cb(line) },
    close() {},
  }
}

void test("serial backend encodes targets into PCA9685 protocol lines", async () => {
  const t = capturingTransport()
  const ser = new SerialBackend({ transport: t })
  await ser.start()
  ser.write("targets", vec3(deg(-90), deg(0), deg(90)))
  assert.deepEqual(t.lines, ["T 0 500", "T 1 1500", "T 2 2500"])
  await ser.stop()
})

void test("serial backend uses A-feedback when the device streams it", async () => {
  const t = capturingTransport()
  const ser = new SerialBackend({ transport: t })
  await ser.start()
  t.feed("A 0 4500")   // 4500 centi-degrees = 45deg
  t.feed("garbage")
  const angles = ser.read("angles") as { x: { canon: number } }
  assert.equal(Math.round((angles.x.canon * 180) / Math.PI), 45)
  await ser.stop()
})

void test("bus delivers published messages to subscribers in order", async () => {
  const bus = new Bus()
  bus.declare({ kind: "topicdecl", path: "cmd", typeName: "Any", pos: { line: 1, col: 1 } })
  const got: unknown[] = []
  let resolveDone: () => void
  const done = new Promise<void>(r => { resolveDone = r })
  bus.subscribe({
    path: "cmd",
    subscriber: "test",
    deliver: async m => {
      got.push(m)
      if (got.length === 3) resolveDone()
    },
  })
  bus.publish("cmd", 1)
  bus.publish("cmd", 2)
  bus.publish("cmd", 3)
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))])
  assert.deepEqual(got, [1, 2, 3])
})

void test("bus enforces declared payload types", () => {
  const bus = new Bus()
  bus.declare({ kind: "topicdecl", path: "angle_topic", typeName: "Angle", pos: { line: 1, col: 1 } })
  bus.subscribe({ path: "angle_topic", subscriber: "x", deliver: async () => {} })
  assert.throws(() => bus.publish("angle_topic", rawUnitVal(1, { L: 1 })), /expects Angle/)
  // matching dimension passes
  bus.publish("angle_topic", deg(10))
})

void test("formatting renders units readably", () => {
  const v = rawUnitVal(0.12, { L: 1 })
  v.hint = "mm"
  assert.equal(formatVal(v), "120 mm")
})
