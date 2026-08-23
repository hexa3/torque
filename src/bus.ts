// In-process message bus: topics with typed payloads, queued subscribers,
// serialized handler dispatch per subscriber. No external broker required.

import type { TopicDecl } from "./ast.ts"
import { checkType } from "./types.ts"
import type { TorqueValue } from "./values.ts"

export interface Subscription {
  path: string
  subscriber: string          // description, e.g. "on /filtered"
  deliver(msg: TorqueValue): Promise<void>
}

interface SubQueue {
  sub: Subscription
  queue: TorqueValue[]
  draining: boolean
  received: number
  dropped: number
}

export interface PublishStats {
  published: number
}

export class Bus {
  topics = new Map<string, TopicDecl>()
  private subs = new Map<string, SubQueue[]>()
  published = 0

  declare(decl: TopicDecl) {
    this.topics.set(decl.path, decl)
  }

  subscribe(sub: Subscription) {
    let arr = this.subs.get(sub.path)
    if (!arr) { arr = []; this.subs.set(sub.path, arr) }
    const q: SubQueue = { sub, queue: [], draining: false, received: 0, dropped: 0 }
    arr.push(q)
    return q
  }

  subscriptionsFor(path: string): SubQueue[] {
    return this.subs.get(path) ?? []
  }

  publish(path: string, value: TorqueValue): void {
    this.published++
    const decl = this.topics.get(path)
    if (decl) {
      // Payload dimension/type check against the declaration.
      try {
        value = checkType(decl.typeName, value, `payload of /${path}`)
      } catch (e) {
        throw new Error(`publish(/${path}) rejected: ${(e as Error).message}`)
      }
    }
    const subs = this.subs.get(path)
    if (!subs || subs.length === 0) return
    for (const q of subs) {
      q.received++
      // Backpressure: bound queue so a slow consumer cannot grow memory.
      if (q.queue.length >= 64) {
        q.queue.shift()
        q.dropped++
      }
      q.queue.push(value)
      this.pump(q)
    }
  }

  private pump(q: SubQueue) {
    if (q.draining) return
    q.draining = true
    const step = (): void => {
      // Drain at most a few messages per event-loop turn to avoid starving timers.
      let n = 0
      while (q.queue.length > 0 && n < 4) {
        const m = q.queue.shift()!
        n++
        q.sub.deliver(m).catch(err => {
          console.error(`[bus] handler for /${q.sub.path} failed: ${err.message}`)
        })
      }
      if (q.queue.length > 0) {
        setImmediate(step)
      } else {
        q.draining = false
      }
    }
    setImmediate(step)
  }
}
