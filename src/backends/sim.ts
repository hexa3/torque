// SimBackend: pure-software stand-in for the 3-DOF arm.
//
// Model: each joint slews toward its commanded target at a bounded rate
// (first-order-ish point follower). This gives control loops something
// genuinely dynamic to chase: commands do not take effect instantly and
// overshooting controllers will visibly oscillate.
//
// Channels match SerialBackend exactly, so one .tq source drives either.

import type { Backend } from "./backend.ts"
import { vec3, isVec3, isUnitVal, rawUnitVal, type TorqueValue, type Vec3Val } from "../values.ts"

interface Joint {
  angle: number   // radians
  target: number  // radians
}

const SLEW_RAD_S = Math.PI * 0.9 // rad/s max joint speed (~162 deg/s)

export class SimBackend implements Backend {
  readonly kind = "sim"
  private joints: Joint[] = [
    { angle: 0, target: 0 },
    { angle: 0, target: 0 },
    { angle: 0, target: 0 },
  ]
  private lastAdvanceUs = 0
  private startedAtUs = 0
  noiseStddevDeg = 0
  writes = 0

  async start(): Promise<void> {
    this.startedAtUs = nowUs()
    this.lastAdvanceUs = this.startedAtUs
  }

  async stop(): Promise<void> {}

  read(channel: string): TorqueValue {
    this.advance()
    if (channel === "angles") return this.anglesVec()
    if (/^angle[0-2]$/.test(channel)) {
      const i = Number(channel.slice(5))
      return this.jointAngle(i)
    }
    throw new Error(`sim backend: unknown read channel '${channel}' (try "angles")`)
  }

  write(channel: string, value: TorqueValue): void {
    if (channel !== "targets") {
      throw new Error(`sim backend: unknown write channel '${channel}' (try "targets")`)
    }
    let v: Vec3Val
    if (isVec3(value)) {
      v = value
    } else if (Array.isArray(value) && value.length === 3 && value.every(isUnitVal)) {
      v = vec3(value[0], value[1], value[2])
    } else {
      throw new Error('sim backend: write("targets", ...) expects a Vec3 of Angles')
    }
    for (const c of [v.x, v.y, v.z]) {
      if (!isUnitVal(c) || c.key !== "A1") {
        throw new Error('sim backend: write("targets", ...) expects a Vec3 of Angles')
      }
    }
    this.advance()
    this.joints[0].target = clampRad(v.x.canon)
    this.joints[1].target = clampRad(v.y.canon)
    this.joints[2].target = clampRad(v.z.canon)
    this.writes++
  }

  /** Move joints toward targets by as much as wall-clock time allows. */
  private advance() {
    const t = nowUs()
    let dtS = (t - this.lastAdvanceUs) / 1e6
    this.lastAdvanceUs = t
    if (dtS <= 0) return
    if (dtS > 0.25) dtS = 0.25 // cap catch-up after long pauses
    for (const j of this.joints) {
      const delta = j.target - j.angle
      const step = Math.sign(delta) * Math.min(Math.abs(delta), SLEW_RAD_S * dtS)
      j.angle += step
    }
  }

  private jointAngle(i: number): TorqueValue {
    let a = this.joints[i].angle
    if (this.noiseStddevDeg > 0) {
      a += gaussian() * (this.noiseStddevDeg * Math.PI / 180)
    }
    return rawUnitVal(a, { A: 1 })
  }

  private anglesVec(): Vec3Val {
    return vec3(
      this.jointAngle(0),
      this.jointAngle(1),
      this.jointAngle(2),
    )
  }
}

function clampRad(r: number): number {
  const lim = Math.PI
  return Math.max(-lim, Math.min(lim, r))
}

function gaussian(): number {
  // Box-Muller
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function nowUs(): number {
  return performance.now() * 1000
}
