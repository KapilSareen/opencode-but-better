import * as Tool from "./tool"
import DESCRIPTION from "./sleep.txt"
import { ToolJsonSchema } from "./json-schema"
import { Session } from "@/session/session"
import { Effect, Schema } from "effect"

const id = "sleep"

export const Parameters = Schema.Struct({
  duration_ms: Schema.Number.annotate({
    description: "How long to wait at most, in milliseconds (max 600000). Returns early when new session input arrives.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "What you are waiting for (shown in the result).",
  }),
})

export const MAX_SLEEP_MS = 600_000
const POLL_MS = 1_000

export const SleepTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const run = Effect.fn("SleepTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: id,
        patterns: ["*"],
        always: ["*"],
        metadata: params.reason ? { reason: params.reason } : {},
      })
      if (!Number.isFinite(params.duration_ms) || params.duration_ms <= 0 || params.duration_ms > MAX_SLEEP_MS) {
        return yield* Effect.fail(
          new Error(`sleep duration_ms must be between 1 and ${MAX_SLEEP_MS} (got ${params.duration_ms})`),
        )
      }
      const baseline = yield* sessions
        .messages({ sessionID: ctx.sessionID, limit: 50 })
        .pipe(
          Effect.map((msgs) => msgs.findLast((msg) => msg.info.role === "user")?.info.id),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      const aborted = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) return resume(Effect.void)
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })
      const deadline = Date.now() + params.duration_ms
      let woken = false
      let interrupted = false
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now()
        const outcome = yield* Effect.raceFirst(
          Effect.sleep(`${Math.min(remaining, POLL_MS)} millis`).pipe(Effect.as("tick" as const)),
          aborted.pipe(Effect.as("abort" as const)),
        )
        if (outcome === "abort") {
          interrupted = true
          break
        }
        const latest = yield* sessions
          .messages({ sessionID: ctx.sessionID, limit: 50 })
          .pipe(
            Effect.map((msgs) => msgs.findLast((msg) => msg.info.role === "user")?.info.id),
            Effect.catchCause(() => Effect.succeed(baseline)),
          )
        if (latest !== baseline) {
          woken = true
          break
        }
      }
      const elapsed = Math.min(params.duration_ms, Math.max(0, Date.now() - (deadline - params.duration_ms)))
      return {
        title: woken ? "woken by new input" : interrupted ? "sleep interrupted" : "sleep finished",
        metadata: { woken, elapsed_ms: elapsed },
        output: woken
          ? `New input arrived in session ${ctx.sessionID} after ${elapsed}ms. Continue with the new messages.`
          : interrupted
            ? `Sleep interrupted after ${elapsed}ms.`
            : `Slept ${elapsed}ms with no new input${params.reason ? ` (waiting for: ${params.reason})` : ""}.`,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
