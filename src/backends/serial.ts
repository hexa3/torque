// SerialBackend: drives a real (or virtual) serial port with the
// Torque/PCA9685 line protocol:
//
//   -> "T <channel> <pulse_us>\n"   command servo pulse on PCA9685 channel
//   <- "A <channel> <angle_cdeg>\n" optional feedback (centi-degrees)
//
// Angles map to pulses over [-90deg, +90deg] -> [500us, 2500us].
//
// If the device streams `A` feedback lines, read("angles") returns them;
// otherwise it returns the last commanded targets (open-loop echo), which
// is stated honestly — no invented sensor data.
//
// Transport is injectable so tests exercise identical code paths against
// an in-memory or loopback-socket transport instead of /dev/tty*.

import fs from "node:fs"
import { spawnSync } from "node:child_process"
import type { Backend } from "./backend.ts"
import { vec3, isVec3, isUnitVal, rawUnitVal, type TorqueValue, type Vec3Val } from "../values.ts"

export interface SerialTransport {
  write(bytes: string): void
  onData(cb: (line: string) => void): void
  close(): void
}

export interface SerialBackendOptions {
  path?: string
  baud?: number
  joints?: number
  transport?: SerialTransport   // overrides path (used by tests)
}

export const PULSE_MIN_US = 500
export const PULSE_MAX_US = 2500

export function angleToPulseUs(angleRad: number): number {
  // [-pi/2, +pi/2] -> [PULSE_MIN_US, PULSE_MAX_US]
  const frac = angleRad / (Math.PI / 2)
  const clamped = Math.max(-1, Math.min(1, frac))
  return Math.round(PULSE_MIN_US + ((clamped + 1) / 2) * (PULSE_MAX_US - PULSE_MIN_US))
}

export function pulseUsToAngle(pulseUs: number): number {
  const frac = ((pulseUs - PULSE_MIN_US) / (PULSE_MAX_US - PULSE_MIN_US)) * 2 - 1
  return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, frac * (Math.PI / 2)))
}

export class SerialBackend implements Backend {
  readonly kind = "serial"
  private fd: number | null = null
  private path: string
  private baud: number
  private nJoints: number
  private transport: SerialTransport | null
  private targetAngles: number[] = []
  private feedbackAngles: Array<number | null> = []
  private rxBuf = ""
  bytesWritten = 0
  linesSent = 0

  constructor(opts: SerialBackendOptions = {}) {
    this.path = opts.path ?? "/dev/ttyACM0"
    this.baud = opts.baud ?? 115200
    this.nJoints = opts.joints ?? 3
    this.transport = opts.transport ?? null
    this.targetAngles = new Array(this.nJoints).fill(0)
    this.feedbackAngles = new Array(this.nJoints).fill(null)
  }

  async start(): Promise<void> {
    if (this.transport !== null) {
      this.transport.onData(line => this.handleLine(line))
      return
    }
    let fd: number
    try {
      // O_NONBLOCK is essential: a blocking TTY read would freeze the
      // entire single-threaded runtime when no data is pending.
      fd = fs.openSync(this.path, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
    } catch (e) {
      throw new Error(
        `serial backend: cannot open '${this.path}': ${(e as Error).message}. ` +
        `Pass --port /dev/ttyUSB0 (or a socat PTY for testing).`,
      )
    }
    this.fd = fd
    try {
      // Best-effort raw-mode config; harmless if it fails (e.g. regular files,
      // ptys already configured).
      spawnSync("stty", ["-F", this.path, String(this.baud), "raw", "-echo"], { stdio: "ignore" })
    } catch { /* ignore */ }
    // Reader: poll the fd for feedback lines.
    const pump = (): void => {
      if (this.fd === null) return
      const buf = Buffer.alloc(256)
      let n = 0
      try {
        n = fs.readSync(this.fd, buf, 0, buf.length, null)
      } catch {
        n = 0 // EAGAIN etc. — nothing available right now
      }
      if (n > 0) {
        this.rxBuf += buf.toString("utf8", 0, n)
        let idx: number
        while ((idx = this.rxBuf.indexOf("\n")) >= 0) {
          const line = this.rxBuf.slice(0, idx).trim()
          this.rxBuf = this.rxBuf.slice(idx + 1)
          if (line) this.handleLine(line)
        }
      }
      setTimeout(pump, 20)
    }
    setTimeout(pump, 20)
  }

  async stop(): Promise<void> {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd) } catch { /* ignore */ }
      this.fd = null
    }
    this.transport?.close()
  }

  read(channel: string): TorqueValue {
    if (channel === "angles") {
      const parts = []
      for (let i = 0; i < this.nJoints; i++) parts.push(this.angleOf(i))
      // 3 joints keep the Vec3<Angle> shape programs expect; other counts
      // come back as a plain array of Angles.
      if (this.nJoints === 3) return vec3(parts[0], parts[1], parts[2])
      return parts
    }
    const m = /^angle([0-9]+)$/.exec(channel)
    if (m && Number(m[1]) < this.nJoints) return this.angleOf(Number(m[1]))
    throw new Error(`serial backend: unknown read channel '${channel}'`)
  }

  private angleOf(i: number): TorqueValue {
    const a = this.feedbackAngles[i] ?? this.targetAngles[i]
    return rawUnitVal(a, { A: 1 })
  }

  write(channel: string, value: TorqueValue): void {
    if (channel !== "targets") {
      throw new Error(`serial backend: unknown write channel '${channel}' (try "targets")`)
    }
    let comps: TorqueValue[]
    if (isVec3(value)) {
      if (!this.anglesOk(value)) throw new Error('serial backend: write("targets", ...) expects a Vec3 of Angles')
      comps = [value.x, value.y, value.z]
    } else if (Array.isArray(value)) {
      comps = value
    } else {
      throw new Error('serial backend: write("targets", ...) expects a Vec3 of Angles')
    }
    if (comps.length !== this.nJoints || !comps.every(c => isUnitVal(c) && c.key === "A1")) {
      throw new Error(`serial backend: expected ${this.nJoints} joint angles`)
    }
    for (let i = 0; i < this.nJoints; i++) {
      const rad = (comps[i] as { canon: number }).canon
      this.targetAngles[i] = rad
      this.send(`T ${i} ${angleToPulseUs(rad)}\n`)
    }
  }

  private anglesOk(v: Vec3Val): boolean {
    return [v.x, v.y, v.z].every(c => isUnitVal(c) && c.key === "A1")
  }

  private send(s: string): void {
    if (this.transport !== null) {
      this.transport.write(s)
      this.bytesWritten += s.length
      this.linesSent++
      return
    }
    if (this.fd !== null) {
      const n = fs.writeSync(this.fd, s)
      this.bytesWritten += n
      this.linesSent++
    }
  }

  /** Handle one protocol line from the device ("A <ch> <cdeg>" feedback). */
  handleLine(line: string): void {
    const m = /^A\s+(\d+)\s+(-?\d+)/.exec(line.trim())
    if (!m) return
    const ch = Number(m[1])
    if (ch < this.nJoints) {
      this.feedbackAngles[ch] = Number(m[2]) / 100 * (Math.PI / 180)
    }
  }

  /** Bytes that would be sent for a given Vec3 target — used by tests. */
  static encodeTargets(value: Vec3Val): string {
    let out = ""
    const comps = [value.x, value.y, value.z]
    for (let i = 0; i < comps.length; i++) {
      out += `T ${i} ${angleToPulseUs(comps[i].canon)}\n`
    }
    return out
  }
}
