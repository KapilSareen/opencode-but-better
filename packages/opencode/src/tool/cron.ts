import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { ToolJsonSchema } from "./json-schema"
import { Cron } from "@/cron/cron"
import { Session } from "@/session/session"
import { SessionID } from "../session/schema"
import { EffectBridge } from "@/effect/bridge"
import type { TaskPromptOps } from "./task"
import { Effect, Schema } from "effect"

const id = "cron"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "list", "status", "delete"]).annotate({
    description: "create: schedule a cron message. list: list jobs. status: report one job. delete: remove a job.",
  }),
  schedule: Schema.optional(Schema.String).annotate({
    description: '5-field cron in local time: "minute hour day-of-month month day-of-week" (create only).',
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "Message delivered into the session on each fire (create only).",
  }),
  target_session: Schema.optional(Schema.String).annotate({
    description: "Session ID to notify. Defaults to the calling session.",
  }),
  once: Schema.optional(Schema.Boolean).annotate({
    description: "Fire a single time at the next match, then stop (create only).",
  }),
  cron_id: Schema.optional(Schema.String).annotate({
    description: "Job ID (cron_...) for status and delete.",
  }),
})

function renderEvent(info: Cron.Info) {
  return [
    `<cron id="${info.id}" schedule="${info.schedule}" fire="${info.fireCount}">`,
    info.message,
    "</cron>",
  ].join("\n")
}

export const CronTool = Tool.define(
  id,
  Effect.gen(function* () {
    const cron = yield* Cron.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("CronTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: id,
        patterns: [params.action],
        always: ["*"],
        metadata: {
          action: params.action,
          cron_id: params.cron_id,
        },
      })
      // Single metadata shape across branches so the tool Def infers one Metadata type.
      const meta = { action: params.action, cron_id: params.cron_id }

      if (params.action === "list") {
        const all = yield* cron.list()
        return {
          title: "scheduled jobs",
          metadata: meta,
          output:
            all.length === 0
              ? "No scheduled jobs."
              : all
                  .map(
                    (info) =>
                      `${info.id}: ${info.status} — "${info.schedule}"${info.nextFireAt ? ` next ${new Date(info.nextFireAt).toLocaleString()}` : ""} (session ${info.sessionID}, fired ${info.fireCount}x)`,
                  )
                  .join("\n"),
        }
      }

      if (params.action === "status") {
        if (!params.cron_id) return yield* Effect.fail(new Error("cron status requires cron_id"))
        const info = yield* cron.status(params.cron_id)
        if (!info) return { title: "job status", metadata: meta, output: `Unknown job: ${params.cron_id}` }
        return {
          title: "job status",
          metadata: meta,
          output: [
            `id: ${info.id}`,
            `status: ${info.status}`,
            `schedule: ${info.schedule}`,
            `session: ${info.sessionID}`,
            `fired: ${info.fireCount}x`,
            ...(info.nextFireAt ? [`next: ${new Date(info.nextFireAt).toLocaleString()}`] : []),
            `message: ${info.message}`,
          ].join("\n"),
        }
      }

      if (params.action === "delete") {
        if (!params.cron_id) return yield* Effect.fail(new Error("cron delete requires cron_id"))
        const info = yield* cron.stop(params.cron_id)
        if (!info) return yield* Effect.fail(new Error(`Unknown job: ${params.cron_id}`))
        return { title: "job deleted", metadata: meta, output: `Scheduled job ${info.id} deleted.` }
      }

      // create
      if (!params.schedule) return yield* Effect.fail(new Error("cron create requires schedule"))
      if (!params.message) return yield* Effect.fail(new Error("cron create requires message"))
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      const notify = ops?.notify
      if (!notify) return yield* Effect.fail(new Error("Cron create requires promptOps with notify support"))
      const target = params.target_session ? SessionID.make(params.target_session) : ctx.sessionID
      yield* sessions.get(target).pipe(
        Effect.catchCause(() => Effect.fail(new Error(`Unknown session: ${params.target_session}`))),
      )
      const bridge = yield* EffectBridge.make()
      const info = yield* cron.start({
        schedule: params.schedule,
        message: params.message,
        sessionID: target,
        once: params.once,
        onFire: (fired) => {
          bridge.fork(notify({ sessionID: target, parts: [{ type: "text", synthetic: true, text: renderEvent(fired) }] }).pipe(Effect.ignore))
        },
      })
      return {
        title: "job scheduled",
        metadata: meta,
        output: [
          `Scheduled job ${info.id}: "${info.schedule}"${info.once ? " (once)" : ""}`,
          `Notifying session ${target} on each fire. Use cron delete to remove it.`,
        ].join("\n"),
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
