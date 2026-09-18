import * as Tool from "./tool"
import DESCRIPTION from "./monitor.txt"
import { ToolJsonSchema } from "./json-schema"
import { Monitor } from "@/monitor/monitor"
import { Session } from "@/session/session"
import { SessionID } from "../session/schema"
import { EffectBridge } from "@/effect/bridge"
import type { TaskPromptOps } from "./task"
import { Effect, Schema } from "effect"

const id = "monitor"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "stop", "status", "list"]).annotate({
    description: "start: watch a command. stop: kill a monitor. status: report a monitor. list: list monitors.",
  }),
  command: Schema.optional(Schema.String).annotate({
    description: "Shell command to run and watch (start only).",
  }),
  target_session: Schema.optional(Schema.String).annotate({
    description: "Session ID to notify. Defaults to the calling session.",
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description: "JS RegExp: stdout lines matching it notify the session (start only). Without it, only completion notifies.",
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "Working directory for the command. Defaults to the project directory.",
  }),
  monitor_id: Schema.optional(Schema.String).annotate({
    description: "Monitor ID (mon_...) for stop and status.",
  }),
})

function renderEvent(monitorID: string, command: string, body: string) {
  return [`<monitor id="${monitorID}" event="output">`, `<command>${command}</command>`, "<output>", body, "</output>", "</monitor>"].join("\n")
}

function renderExit(info: Monitor.Info) {
  return [
    `<monitor id="${info.id}" event="exit" status="${info.status}"${info.exitCode !== undefined ? ` exit_code="${info.exitCode}"` : ""}>`,
    `<command>${info.command}</command>`,
    "<tail>",
    ...info.tail,
    "</tail>",
    "</monitor>",
  ].join("\n")
}

export const MonitorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const monitor = yield* Monitor.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("MonitorTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: id,
        patterns: [params.action],
        always: ["*"],
        metadata: {
          action: params.action,
          monitor_id: params.monitor_id,
        },
      })
      // Single metadata shape across branches so the tool Def infers one Metadata type.
      const meta = { action: params.action, monitor_id: params.monitor_id }

      if (params.action === "list") {
        const all = yield* monitor.list()
        return {
          title: "monitors",
          metadata: meta,
          output:
            all.length === 0
              ? "No monitors running in this project."
              : all
                  .map((info) => `${info.id}: ${info.status} — ${info.command} (session ${info.sessionID})`)
                  .join("\n"),
        }
      }

      if (params.action === "status") {
        if (!params.monitor_id) return yield* Effect.fail(new Error("monitor status requires monitor_id"))
        const info = yield* monitor.status(params.monitor_id)
        if (!info) {
          return { title: "monitor status", metadata: meta, output: `Unknown monitor: ${params.monitor_id}` }
        }
        return {
          title: "monitor status",
          metadata: meta,
          output:
            [`id: ${info.id}`, `status: ${info.status}`, `command: ${info.command}`, `session: ${info.sessionID}`]
              .concat(info.exitCode !== undefined ? [`exit_code: ${info.exitCode}`] : [])
              .concat(info.tail.length > 0 ? ["tail:", ...info.tail] : [])
              .join("\n"),
        }
      }

      if (params.action === "stop") {
        if (!params.monitor_id) return yield* Effect.fail(new Error("monitor stop requires monitor_id"))
        const info = yield* monitor.stop(params.monitor_id)
        if (!info) return yield* Effect.fail(new Error(`Unknown monitor: ${params.monitor_id}`))
        return {
          title: "monitor stopped",
          metadata: meta,
          output: `Monitor ${info.id} stopped (was: ${info.command}). The session was not notified of the stop.`,
        }
      }

      // start
      if (!params.command) return yield* Effect.fail(new Error("monitor start requires command"))
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      const notify = ops?.notify
      if (!notify) return yield* Effect.fail(new Error("Monitor start requires promptOps with notify support"))
      const target = params.target_session ? SessionID.make(params.target_session) : ctx.sessionID
      yield* sessions.get(target).pipe(
        Effect.catchCause(() => Effect.fail(new Error(`Unknown session: ${params.target_session}`))),
      )
      const bridge = yield* EffectBridge.make()
      const deliver = (text: string) =>
        bridge.fork(notify({ sessionID: target, parts: [{ type: "text", synthetic: true, text }] }).pipe(Effect.ignore))
      let monitorID = "pending"
      const info = yield* monitor.start({
        command: params.command,
        sessionID: target,
        pattern: params.pattern,
        workdir: params.workdir,
        onOutput: (line) => {
          deliver(renderEvent(monitorID, params.command as string, line))
        },
        onExit: (finished) => {
          deliver(renderExit(finished))
        },
      })
      monitorID = info.id
      return {
        title: "monitor started",
        metadata: meta,
        output: [
          `Monitor ${info.id} watching: ${info.command}`,
          `Notifying session ${target}${params.pattern ? ` on lines matching ${params.pattern}` : " on completion"}.`,
          "Use monitor stop to kill it.",
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
