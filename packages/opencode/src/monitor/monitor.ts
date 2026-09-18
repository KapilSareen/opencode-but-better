import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "../session/schema"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { Cause, Clock, Context, Effect, Fiber, Layer, Scope, Stream, SynchronizedRef } from "effect"
import { ulid } from "ulid"

export type Status = "running" | "completed" | "error" | "killed"

export interface Info {
  readonly id: string
  readonly command: string
  readonly sessionID: SessionID
  readonly pattern?: string
  readonly status: Status
  readonly exitCode?: number
  readonly tail: string[]
  readonly startedAt: number
  readonly completedAt?: number
}

export interface StartInput {
  readonly command: string
  readonly sessionID: SessionID
  readonly pattern?: string
  readonly workdir?: string
  readonly onOutput: (line: string) => void
  readonly onExit: (info: Info) => void
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Info, Error>
  readonly stop: (id: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly status: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Monitor") {}

const TAIL_LINES = 50
const DRAIN_GRACE = "2 seconds"

interface Active {
  readonly info: Info
  readonly fiber: Fiber.Fiber<void>
  readonly matcher: RegExp | undefined
  readonly onOutput: (line: string) => void
  readonly onExit: (info: Info) => void
}

interface Data {
  readonly monitors: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  readonly scope: Scope.Scope
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Captured once: methods close over it so their types stay R=never.
    // The spawner is provided by the ambient platform layer (same as shell/project).
    const spawner = yield* ChildProcessSpawner
    const state = yield* InstanceState.make<Data>(
      Effect.fn("Monitor.state")(function* () {
        const scope = yield* Scope.Scope
        const monitors = yield* SynchronizedRef.make(new Map<string, Active>())
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const all = yield* SynchronizedRef.get(monitors)
            yield* Effect.forEach(all.values(), (active) => Fiber.interrupt(active.fiber), { discard: true })
          }),
        )
        return { monitors, scope }
      }),
    )

    const snapshot = Effect.fn("Monitor.snapshot")(function* (id: string) {
      const data = yield* InstanceState.get(state)
      return (yield* SynchronizedRef.get(data.monitors)).get(id)?.info
    })

    const update = Effect.fn("Monitor.update")(function* (id: string, next: (info: Info) => Info) {
      const data = yield* InstanceState.get(state)
      yield* SynchronizedRef.update(data.monitors, (all) => {
        const active = all.get(id)
        if (!active) return all
        const copy = new Map(all)
        copy.set(id, { ...active, info: next(active.info) })
        return copy
      })
    })

    const pushLine = Effect.fn("Monitor.pushLine")(function* (id: string, line: string) {
      const data = yield* InstanceState.get(state)
      const active = (yield* SynchronizedRef.get(data.monitors)).get(id)
      if (!active || active.info.status !== "running") return
      const tail = [...active.info.tail, line].slice(-TAIL_LINES)
      yield* SynchronizedRef.update(data.monitors, (all) => {
        const current = all.get(id)
        if (!current) return all
        const copy = new Map(all)
        copy.set(id, { ...current, info: { ...current.info, tail } })
        return copy
      })
      if (active.matcher?.test(line)) {
        yield* Effect.sync(() => {
          try {
            active.onOutput(line)
          } catch {
            // Subscriber bugs must not kill the monitor loop.
          }
        })
      }
    })

    // Killing only the direct child orphans grandchildren (e.g. `sh -c "sleep 30"`
    // leaves sleep holding stdout open), which hangs exitCode forever. Monitors
    // spawn detached (own process group on posix) and teardown kills the group.
    const killTree = Effect.fn("Monitor.killTree")(function* (handle: ChildProcessHandle) {
      if (process.platform !== "win32") {
        yield* Effect.sync(() => {
          try {
            process.kill(-(handle.pid as number), "SIGTERM")
          } catch {
            // Already dead.
          }
        })
        yield* handle.exitCode.pipe(Effect.timeoutOption("3 seconds"), Effect.ignore)
        yield* Effect.sync(() => {
          try {
            process.kill(-(handle.pid as number), "SIGKILL")
          } catch {
            // Already dead.
          }
        })
      }
      yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
    })

    const run = Effect.fn("Monitor.run")(function* (id: string, input: StartInput, matcher: RegExp | undefined) {
      const cwd = input.workdir ?? (yield* InstanceState.directory)
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh"
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(input.command, [], {
              shell,
              cwd,
              stdin: "ignore",
              detached: process.platform !== "win32",
            }),
          )
          yield* Effect.addFinalizer(() => killTree(handle))
          let buffer = ""
          const flush = (text: string) =>
            Effect.gen(function* () {
              buffer += text
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""
              for (const line of lines) yield* pushLine(id, line)
            })
          const consumer = yield* Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) => flush(chunk)).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (buffer.length > 0) {
                  const rest = buffer
                  buffer = ""
                  yield* pushLine(id, rest)
                }
              }),
            ),
            Effect.forkScoped,
          )
          const code = yield* handle.exitCode
          // The pipe may hold a final chunk after exit; give the consumer a
          // grace period, then finish with whatever tail we have. A leaked
          // grandchild holding stdout open must not hang the monitor.
          yield* Fiber.join(consumer).pipe(Effect.timeoutOption(DRAIN_GRACE), Effect.ignore)
          const completedAt = yield* Clock.currentTimeMillis
          const data = yield* InstanceState.get(state)
          const active = (yield* SynchronizedRef.get(data.monitors)).get(id)
          if (!active || active.info.status !== "running") return
          const finished: Info = {
            ...active.info,
            status: code === 0 ? "completed" : "error",
            exitCode: code,
            completedAt,
          }
          yield* SynchronizedRef.update(data.monitors, (all) => new Map(all).set(id, { ...active, info: finished }))
          yield* Effect.sync(() => {
            try {
              active.onExit(finished)
            } catch {
              // ignore subscriber bugs
            }
          })
        }),
      )
    })

    // The supervised fiber never fails outward: unexpected crashes are recorded
    // on the monitor and delivered via onExit like a normal error exit.
    const failMonitor = Effect.fn("Monitor.fail")(function* (id: string, cause: Cause.Cause<unknown>) {
      const data = yield* InstanceState.get(state)
      const active = (yield* SynchronizedRef.get(data.monitors)).get(id)
      if (!active || active.info.status !== "running") return
      const completedAt = yield* Clock.currentTimeMillis
      const failed: Info = {
        ...active.info,
        status: "error",
        tail: [...active.info.tail, `monitor crashed: ${Cause.pretty(cause)}`].slice(-TAIL_LINES),
        completedAt,
      }
      yield* SynchronizedRef.update(data.monitors, (all) => new Map(all).set(id, { ...active, info: failed }))
      yield* Effect.sync(() => {
        try {
          active.onExit(failed)
        } catch {
          // ignore subscriber bugs
        }
      })
    })

    const start: Interface["start"] = Effect.fn("Monitor.start")(function* (input: StartInput) {
      const matcher = input.pattern
        ? yield* Effect.try({
            try: () => new RegExp(input.pattern as string),
            catch: () => new Error(`Invalid monitor pattern: ${input.pattern}`),
          })
        : undefined
      const data = yield* InstanceState.get(state)
      const id = `mon_${ulid()}`
      const info: Info = {
        id,
        command: input.command,
        sessionID: input.sessionID,
        pattern: input.pattern,
        status: "running",
        tail: [],
        startedAt: Date.now(),
      }
      const fiber = yield* run(id, input, matcher).pipe(
        Effect.catchCause((cause) => failMonitor(id, cause)),
        Effect.forkIn(data.scope),
      )
      yield* SynchronizedRef.update(data.monitors, (all) =>
        new Map(all).set(id, { info, fiber, matcher, onOutput: input.onOutput, onExit: input.onExit }),
      )
      return info
    })

    const stop: Interface["stop"] = Effect.fn("Monitor.stop")(function* (id: string) {
      const data = yield* InstanceState.get(state)
      const active = (yield* SynchronizedRef.get(data.monitors)).get(id)
      if (!active) return undefined
      if (active.info.status !== "running") return active.info
      const completedAt = yield* Clock.currentTimeMillis
      const killed: Info = { ...active.info, status: "killed", completedAt }
      yield* SynchronizedRef.update(data.monitors, (all) => new Map(all).set(id, { ...active, info: killed }))
      yield* Fiber.interrupt(active.fiber)
      return killed
    })

    const list: Interface["list"] = Effect.fn("Monitor.list")(function* () {
      const data = yield* InstanceState.get(state)
      return [...(yield* SynchronizedRef.get(data.monitors)).values()].map((active) => active.info)
    })

    const status: Interface["status"] = Effect.fn("Monitor.status")(function* (id: string) {
      return yield* snapshot(id)
    })

    return Service.of({ start, stop, list, status })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [CrossSpawnSpawner.node] })

export * as Monitor from "./monitor"
