import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "../session/schema"
import { Clock, Context, Effect, Fiber, Layer, Scope, SynchronizedRef } from "effect"
import { ulid } from "ulid"

// Minimal 5-field cron (local time): minute hour day-of-month month day-of-week.
// Each field supports * | */n | a-b | a-b/n | lists thereof. Day-of-month and
// day-of-week follow standard cron OR semantics.
export interface CronFields {
  readonly minute: ReadonlySet<number>
  readonly hour: ReadonlySet<number>
  readonly dayOfMonth: ReadonlySet<number>
  readonly month: ReadonlySet<number>
  readonly dayOfWeek: ReadonlySet<number>
}

const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
}

function parseField(field: string, min: number, max: number): ReadonlySet<number> | undefined {
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const stepSplit = part.split("/")
    if (stepSplit.length > 2) return undefined
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1
    if (!Number.isInteger(step) || step < 1) return undefined
    const range = stepSplit[0] ?? ""
    let from: number
    let to: number
    if (range === "" || range === "*") {
      from = min
      to = max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return undefined
      from = a
      to = b
    } else {
      const value = Number(range)
      if (!Number.isInteger(value)) return undefined
      from = value
      to = value
    }
    if (from < min || to > max || from > to) return undefined
    for (let value = from; value <= to; value += step) out.add(value)
  }
  if (out.size === 0) return undefined
  return out
}

export function parseCronExpression(expression: string): CronFields | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  const parsedMinute = parseField(minute, ...RANGES.minute)
  const parsedHour = parseField(hour, ...RANGES.hour)
  const parsedDayOfMonth = parseField(dayOfMonth, ...RANGES.dayOfMonth)
  const parsedMonth = parseField(month, ...RANGES.month)
  const parsedDayOfWeek = parseField(dayOfWeek, ...RANGES.dayOfWeek)
  if (!parsedMinute || !parsedHour || !parsedDayOfMonth || !parsedMonth || !parsedDayOfWeek) return undefined
  return {
    minute: parsedMinute,
    hour: parsedHour,
    dayOfMonth: parsedDayOfMonth,
    month: parsedMonth,
    dayOfWeek: parsedDayOfWeek,
  }
}

function matchesAt(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false
  if (!fields.hour.has(date.getHours())) return false
  if (!fields.month.has(date.getMonth() + 1)) return false
  const domStar = fields.dayOfMonth.size === 31
  const dowStar = fields.dayOfWeek.size === 7
  const dom = fields.dayOfMonth.has(date.getDate())
  const dow = fields.dayOfWeek.has(date.getDay())
  // Standard cron: dom and dow are ORed unless one side is unrestricted.
  if (domStar && dowStar) return true
  if (domStar) return dow
  if (dowStar) return dom
  return dom || dow
}

// Next fire strictly after fromMs, scanning minute by minute up to a year out.
// Undefined when the schedule never matches.
export function nextCronRun(fields: CronFields, fromMs: number): number | undefined {
  let cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const limit = fromMs + 366 * 24 * 60 * 60_000
  while (cursor <= limit) {
    if (matchesAt(fields, new Date(cursor))) return cursor
    cursor += 60_000
  }
  return undefined
}

export type Status = "active" | "completed" | "cancelled"

export interface Info {
  readonly id: string
  readonly schedule: string
  readonly message: string
  readonly sessionID: SessionID
  readonly once: boolean
  readonly status: Status
  readonly nextFireAt?: number
  readonly fireCount: number
  readonly createdAt: number
}

export interface StartInput {
  readonly schedule: string
  readonly message: string
  readonly sessionID: SessionID
  readonly once?: boolean
  readonly onFire: (info: Info) => void
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Info, Error>
  readonly stop: (id: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly status: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Cron") {}

export const MAX_JOBS = 20

interface Active {
  readonly info: Info
  readonly fiber: Fiber.Fiber<void>
  readonly fields: CronFields
  readonly onFire: (info: Info) => void
}

interface Data {
  readonly crons: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  readonly scope: Scope.Scope
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<Data>(
      Effect.fn("Cron.state")(function* () {
        const scope = yield* Scope.Scope
        const crons = yield* SynchronizedRef.make(new Map<string, Active>())
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const all = yield* SynchronizedRef.get(crons)
            yield* Effect.forEach(all.values(), (active) => Fiber.interrupt(active.fiber), { discard: true })
          }),
        )
        return { crons, scope }
      }),
    )

    const snapshot = Effect.fn("Cron.snapshot")(function* (id: string) {
      const data = yield* InstanceState.get(state)
      return (yield* SynchronizedRef.get(data.crons)).get(id)?.info
    })

    const run = Effect.fn("Cron.run")(function* (id: string, input: StartInput, fields: CronFields) {
      while (true) {
        const data = yield* InstanceState.get(state)
        const active = (yield* SynchronizedRef.get(data.crons)).get(id)
        if (!active || active.info.status !== "active") return
        const next = nextCronRun(fields, Date.now())
        if (next === undefined) {
          yield* SynchronizedRef.update(data.crons, (all) => {
            const current = all.get(id)
            if (!current) return all
            const copy = new Map(all)
            copy.set(id, { ...current, info: { ...current.info, status: "completed" as const } })
            return copy
          })
          return
        }
        const delay = Math.max(0, next - Date.now())
        yield* SynchronizedRef.update(data.crons, (all) => {
          const current = all.get(id)
          if (!current) return all
          const copy = new Map(all)
          copy.set(id, { ...current, info: { ...current.info, nextFireAt: next } })
          return copy
        })
        yield* Effect.sleep(`${delay} millis`)
        const latest = yield* snapshot(id)
        if (!latest || latest.status !== "active") return
        const fired: Info = { ...latest, fireCount: latest.fireCount + 1 }
        if (input.once) {
          yield* SynchronizedRef.update(data.crons, (all) => {
            const current = all.get(id)
            if (!current) return all
            const copy = new Map(all)
            copy.set(id, { ...current, info: { ...fired, status: "completed" as const, nextFireAt: undefined } })
            return copy
          })
          yield* Effect.sync(() => {
            try {
              active.onFire({ ...fired, status: "completed" })
            } catch {
              // ignore subscriber bugs
            }
          })
          return
        }
        yield* SynchronizedRef.update(data.crons, (all) => {
          const current = all.get(id)
          if (!current) return all
          const copy = new Map(all)
          copy.set(id, { ...current, info: { ...fired, nextFireAt: undefined } })
          return copy
        })
        yield* Effect.sync(() => {
          try {
            active.onFire(fired)
          } catch {
            // ignore subscriber bugs
          }
        })
      }
    })

    const start: Interface["start"] = Effect.fn("Cron.start")(function* (input: StartInput) {
      const fields = parseCronExpression(input.schedule)
      if (!fields) {
        return yield* Effect.fail(
          new Error(`Invalid cron expression '${input.schedule}'. Expected 5 fields: minute hour day-of-month month day-of-week.`),
        )
      }
      if (nextCronRun(fields, Date.now()) === undefined) {
        return yield* Effect.fail(
          new Error(`Cron expression '${input.schedule}' never matches a calendar date in the next year.`),
        )
      }
      const data = yield* InstanceState.get(state)
      if ((yield* SynchronizedRef.get(data.crons)).size >= MAX_JOBS) {
        return yield* Effect.fail(new Error(`Too many scheduled jobs (max ${MAX_JOBS}). Delete one first.`))
      }
      const id = `cron_${ulid()}`
      const info: Info = {
        id,
        schedule: input.schedule,
        message: input.message,
        sessionID: input.sessionID,
        once: input.once ?? false,
        status: "active",
        fireCount: 0,
        createdAt: Date.now(),
      }
      const fiber = yield* run(id, input, fields).pipe(Effect.forkIn(data.scope))
      yield* SynchronizedRef.update(data.crons, (all) =>
        new Map(all).set(id, { info, fiber, fields, onFire: input.onFire }),
      )
      return info
    })

    const stop: Interface["stop"] = Effect.fn("Cron.stop")(function* (id: string) {
      const data = yield* InstanceState.get(state)
      const active = (yield* SynchronizedRef.get(data.crons)).get(id)
      if (!active) return undefined
      if (active.info.status !== "active") return active.info
      const cancelled: Info = { ...active.info, status: "cancelled", nextFireAt: undefined }
      yield* SynchronizedRef.update(data.crons, (all) => new Map(all).set(id, { ...active, info: cancelled }))
      yield* Fiber.interrupt(active.fiber)
      return cancelled
    })

    const list: Interface["list"] = Effect.fn("Cron.list")(function* () {
      const data = yield* InstanceState.get(state)
      return [...(yield* SynchronizedRef.get(data.crons)).values()].map((active) => active.info)
    })

    const status: Interface["status"] = Effect.fn("Cron.status")(function* (id: string) {
      return yield* snapshot(id)
    })

    return Service.of({ start, stop, list, status })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as Cron from "./cron"
