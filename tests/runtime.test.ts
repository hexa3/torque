import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const ROOT = new URL("..", import.meta.url).pathname
const CLI = new URL("../src/cli.ts", import.meta.url).pathname
const EX = (f: string) => new URL(`../examples/${f}`, import.meta.url).pathname

async function torque(args: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await run(process.execPath, [CLI, ...args], { cwd: ROOT, timeout: timeoutMs })
    return { stdout: r.stdout, stderr: r.stderr, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), code: err.code ?? 1 }
  }
}

void test("CLI: units example computes and prints", async () => {
  const r = await torque(["run", EX("01_units.tq")])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /420 mm/)
  assert.match(r.stdout, /5 m\/s/)
})

void test("CLI: dimensional error aborts with exit code 1", async () => {
  const r = await torque(["run", EX("02_unit_error.tq")])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /cannot add Length and Angle/)
})

void test("CLI: well-behaved loop achieves ~declared rate with zero overruns", async () => {
  const r = await torque(["run", EX("04_blink.tq"), "--for", "400ms"])
  assert.equal(r.code, 0)
  // 400ms at 50hz ≈ 20 ticks
  assert.match(r.stdout, /heartbeat\s+50\s+2000us\s+(\d\d)\s+0\s+0/)
  const m = /heartbeat\s+50\s+2000us\s+(\d+)/.exec(r.stdout)
  assert.ok(m, "report row present")
  const ticks = Number(m![1])
  assert.ok(ticks >= 15 && ticks <= 25, `expected ~20 ticks, got ${ticks}`)
}, 20000)

void test("CLI: overrun loop triggers warnings and counts overruns", async () => {
  const r = await torque(["run", EX("05_overrun.tq"), "--for", "250ms"], 15000)
  assert.equal(r.code, 0)
  assert.match(r.stderr, /\[overrun\] loop 'too_slow' tick took \d+us \(deadline 500us\)/)
  assert.match(r.stdout, /too_slow\s+200\s+500us\s+\d+\s+[1-9]\d*/)   // overruns >= 10ish
}, 20000)

void test("CLI: alloc lint rejects array allocation inside armed loop (exit 2)", async () => {
  const r = await torque(["run", EX("11_alloc_lint.tq")])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /dynamic allocation 'array literal' inside armed loop/)
})

void test("CLI: check passes a clean file", async () => {
  const r = await torque(["check", EX("07_arm_sim.tq")])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /OK/)
})

void test("CLI: tool export emits Anthropic/MCP schema for annotated fns", async () => {
  const r = await torque(["tools", EX("08_tools.tq")])
  assert.equal(r.code, 0)
  const tools = JSON.parse(r.stdout)
  assert.ok(Array.isArray(tools) && tools.length === 3, "three #[tool] functions")
  const moveTo = tools.find((t: { name: string }) => t.name === "move_to")
  assert.equal(moveTo.description.includes("end-effector"), true)
  // Anthropic spelling
  assert.equal(moveTo.input_schema.type, "object")
  assert.equal(moveTo.input_schema.properties.x.type, "number")
  assert.equal(moveTo.input_schema.properties.x.description.includes("Length"), true)
  assert.deepEqual(moveTo.input_schema.required, ["x", "y", "z"])
  // MCP spelling mirrors it
  assert.deepEqual(moveTo.inputSchema.properties, moveTo.input_schema.properties)
  const setSpeed = tools.find((t: { name: string }) => t.name === "set_speed")
  assert.equal(setSpeed.input_schema.properties.s.type, "number")
})

void test("CLI: live tuning changes loop behavior mid-run (--tune)", async () => {
  const r = await torque(["run", EX("09_live.tq"), "--tune", "kp=8@600ms"], 20000)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\[tune\] @600ms: set kp -> 8/)
  // Before tune: sin values are small (slow phase); after: large jumps
  const lines = r.stdout.split("\n").filter(l => l.startsWith("[osc]"))
  assert.ok(lines.length > 8, "several samples before and after")
  const early = lines.slice(2, 5).map(l => Math.abs(Number(/= (-?[\d.]+)/.exec(l)![1])))
  const late = lines.slice(-3).map(l => Math.abs(Number(/= (-?[\d.]+)/.exec(l)![1])))
  assert.ok(Math.max(...late) > 0.7 * Math.max(0.934, ...early), `late samples should jump (${late})`)
}, 25000)

void test("CLI: same arm source runs on sim backend end-to-end with FK telemetry", async () => {
  const r = await torque(["run", EX("07_arm_sim.tq"), "--for", "1200ms"], 20000)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\[control\] -> waypoint 1/)
  assert.match(r.stdout, /\[ee\] [\d.]+ mm/)          // forward kinematics output
  assert.match(r.stdout, /control\s+50\s+4000us/)  // loop report row
}, 25000)

// ---- serial backend over a real kernel PTY pair (socat), if available ----
import { spawn, execSync } from "node:child_process"
import fs from "node:fs"

function socatAvailable(): boolean {
  try { execSync("which socat", { stdio: "ignore" }); return true } catch { return false }
}

void test("serial backend: same arm source drives bytes through a PTY pair", { skip: !socatAvailable() ? "socat not installed" : false }, async t => {
  // Set up pty pair (detached so the test runner never waits on it)
  const p0 = `/tmp/opencode/tq_s0`, p1 = `/tmp/opencode/tq_s1`
  for (const p of [p0, p1]) { try { fs.unlinkSync(p) } catch {} }
  const socat = spawn("socat", ["-d", "-d", `pty,raw,echo=0,link=${p0}`, `pty,raw,echo=0,link=${p1}`],
    { stdio: "ignore", detached: true })
  socat.unref()
  await new Promise(r => setTimeout(r, 700))
  if (!fs.existsSync(p0)) { process.kill(-socat.pid!, "SIGKILL"); t.skip("pty pair did not appear"); return }

  t.after(() => { try { process.kill(-socat.pid!, "SIGKILL") } catch {} })

  // Fake firmware on the far side: parse T commands, emit A feedback.
  const fakeScript = `
import os, time
fd = os.open("${p1}", os.O_RDWR | os.O_NONBLOCK)
buf = b""
angles = [0.0, 0.0, 0.0]
deadline = time.time() + 6
while time.time() < deadline:
    try:
        data = os.read(fd, 512)
        if data:
            buf += data
            while b"\\n" in buf:
                line, buf = buf.split(b"\\n", 1)
                parts = line.decode(errors="replace").split()
                if len(parts) == 3 and parts[0] == "T":
                    ch, us = int(parts[1]), int(parts[2])
                    ang = ((us - 500) / 2000 * 2 - 1) * 90
                    angles[ch] += max(-45, min(45, ang - angles[ch]))
                    os.write(fd, ("A %d %d\\n" % (ch, int(angles[ch] * 100))).encode())
    except OSError:
        pass
    time.sleep(0.005)
`
  fs.writeFileSync("/tmp/opencode/fake_fw.py", fakeScript)
  const py = spawn("python3", ["/tmp/opencode/fake_fw.py"], { stdio: "ignore", detached: true })
  py.unref()
  await new Promise(r => setTimeout(r, 300))
  t.after(() => { try { py.kill() } catch {} })
  await new Promise(r => setTimeout(r, 300))

  // THE SAME example file that ran on the sim backend now talks serial.
  const r = await torque(["run", EX("07_arm_sim.tq"), "--backend", "serial", "--port", p0, "--for", "1500ms"], 20000)
  assert.equal(r.code, 0, `serial run failed: ${r.stderr}`)
  assert.match(r.stdout, /\[control\] -> waypoint/, "control loop ran against serial backend")
  assert.match(r.stdout, /\[ee\] [\d.]+ mm/, "feedback from fake firmware flowed back through the bus")
}, 30000)
