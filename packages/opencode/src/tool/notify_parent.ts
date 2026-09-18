import * as Tool from "./tool"
import DESCRIPTION from "./notify_parent.txt"
import { ToolJsonSchema } from "./json-schema"
import { Session } from "@/session/session"
import type { TaskPromptOps } from "./task"
import { Effect, Schema } from "effect"

const id = "notify_parent"

export const Parameters = Schema.Struct({
  message: Schema.String.annotate({
    description: "Milestone, blocker, or early result for the parent session.",
  }),
})

export const NotifyParentTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const run = Effect.fn("NotifyParentTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: id,
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      })
      const self = yield* sessions.get(ctx.sessionID)
      if (!self.parentID) {
        return yield* Effect.fail(new Error("notify_parent is only available to child tasks spawned by the task tool"))
      }
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops?.notify) return yield* Effect.fail(new Error("notify_parent requires promptOps with notify support"))
      // Child -> parent push. Same durable + detached-drain path as completion
      // notices: the parent picks it up at its next reload boundary. This never
      // interrupts either side and never blocks the child.
      yield* ops.notify({
        sessionID: self.parentID,
        agent: self.agent,
        parts: [
          {
            type: "text",
            synthetic: true,
            text: [`<task-progress from="${ctx.sessionID}">`, params.message, "</task-progress>"].join("\n"),
          },
        ],
      })
      return {
        title: "parent notified",
        metadata: {},
        output: "Progress note delivered to the parent session. Keep running.",
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
