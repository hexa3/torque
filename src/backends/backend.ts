// Backend abstraction: same Torque source runs against any backend.
// Channels are string-keyed; values are Torque runtime values.

import type { TorqueValue } from "../values.ts"

export interface Backend {
  readonly kind: string
  start(): Promise<void>
  stop(): Promise<void>
  read(channel: string): TorqueValue
  write(channel: string, value: TorqueValue): void
}

export const CHANNELS_DOC = [
  'read("angles") -> Vec3<Angle>       current joint angles',
  'read("angle<i>") -> Angle           single joint angle',
  'write("targets", Vec3<Angle>)      command joint target angles',
]
