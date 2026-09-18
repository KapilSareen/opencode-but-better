import * as Tool from "./tool"
import DESCRIPTION from "./background.txt"
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID } from "../session/schema"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import type { TaskPromptOps } from "./task"
import { Effect, Schema } from "effect"

const id = "background"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["status", "send", "kill", "list", "tail", "detach"]).annotate({
    description:
      "status: report child state. send: message a running child. kill: stop a running child. list: list this session's child tasks. tail: read the child's recent activity. detach: move a running foreground task to background and return immediately.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "Child task session ID (the sessionId from the task tool result). Required for status, send, kill, tail unless name is given.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description:
      "Child task name (the description given at spawn). Alternative to task_id for status, send, kill, tail.",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "Message to deliver into the running child task (send only).",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "How many recent child messages to read (tail only, default 10).",
  }),
})

const OUTPUT_LIMIT = 4000

function tail(text: string | undefined) {
  if (!text) return ""
  if (text.length <= OUTPUT_LIMIT) return text
  return text.slice(-OUTPUT_LIMIT) + `\n[truncated to last ${OUTPUT_LIMIT} chars]`
}

function snip(text: string, limit = 500) {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= limit) return flat
  return flat.slice(0, limit) + "…"
}

function renderStatus(info: BackgroundJob.Info) {
  const lines = [`task_id: ${info.id}`, `status: ${info.status}`, `title: ${info.title ?? ""}`]
  if (info.status === "completed") lines.push(`output:\n${tail(info.output)}`)
  if (info.status === "error") lines.push(`error: ${info.error ?? "unknown error"}`)
  return lines.join("\n")
}

export const BackgroundTool = Tool.define(
  id,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("BackgroundTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: id,
        patterns: [params.action],
        always: ["*"],
        metadata: {
          action: params.action,
          task_id: params.task_id,
          name: params.name,
        },
      })

      // Single metadata shape across branches so the tool Def infers one Metadata type.
      const meta = { action: params.action, task_id: params.task_id }
      if (params.action === "list") {
        const jobs = yield* background.list()
        const mine = jobs.filter((job) => job.metadata?.parentSessionId === ctx.sessionID)
        return {
          title: "background tasks",
          metadata: meta,
          output:
            mine.length === 0
              ? "No background tasks for this session."
              : mine.map((job) => `${job.id}: ${job.status}${job.title ? ` — ${job.title}` : ""}`).join("\n"),
        }
      }

      // Resolve by task_id or by spawn name (job title / session title / id).
      // Only direct child tasks of the calling session resolve.
      const resolveChild = Effect.fn("BackgroundTool.resolveChild")(function* () {
        if (params.task_id) {
          const direct = yield* sessions
            .get(SessionID.make(params.task_id))
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (!direct || direct.parentID !== ctx.sessionID) {
            return yield* Effect.fail(
              new Error(
                `Unknown child task: ${params.task_id}. Only direct child tasks of this session can be controlled.`,
              ),
            )
          }
          return direct
        }
        if (!params.name) {
          return yield* Effect.fail(new Error(`background ${params.action} requires task_id or name`))
        }
        const mine = (yield* background.list()).filter((entry) => entry.metadata?.parentSessionId === ctx.sessionID)
        const byJob = mine.filter((entry) => entry.id === params.name || entry.title === params.name)
        if (byJob.length > 1) {
          return yield* Effect.fail(
            new Error(
              `Ambiguous child task name "${params.name}". Candidates:\n${byJob.map((entry) => `  ${entry.id}: ${entry.status} — ${entry.title ?? ""}`).join("\n")}`,
            ),
          )
        }
        if (byJob.length === 1 && byJob[0]) {
          const match = yield* sessions
            .get(SessionID.make(byJob[0].id))
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (match) return match
        }
        const kids = yield* sessions.children(ctx.sessionID)
        const byTitle = kids.filter((kid) => kid.id === params.name || kid.title === params.name)
        if (byTitle.length > 1) {
          return yield* Effect.fail(
            new Error(
              `Ambiguous child task name "${params.name}". Candidates:\n${byTitle.map((kid) => `  ${kid.id}: ${kid.title}`).join("\n")}`,
            ),
          )
        }
        if (byTitle.length === 1 && byTitle[0]) return byTitle[0]
        const known = mine
          .map((entry) => entry.title ?? entry.id)
          .concat(kids.map((kid) => kid.title))
          .filter((title, index, all) => title.length > 0 && all.indexOf(title) === index)
        return yield* Effect.fail(
          new Error(
            `Unknown child task: "${params.name}". Only direct child tasks of this session can be controlled.` +
              (known.length > 0 ? ` Known: ${known.join("; ")}` : " No child tasks found."),
          ),
        )
      })
      const child = yield* resolveChild()
      const job = yield* background.get(child.id)

      const childProgress = Effect.fn("BackgroundTool.progress")(function* (sessionID: SessionID, limit: number) {
        const msgs = yield* sessions.messages({ sessionID, limit }).pipe(Effect.catchCause(() => Effect.succeed([])))
        let toolUseCount = 0
        let input = 0
        let output = 0
        let reasoning = 0
        let cost = 0
        const recent: string[] = []
        for (const msg of msgs) {
          if (msg.info.role === "assistant") {
            input += msg.info.tokens.input ?? 0
            output += msg.info.tokens.output ?? 0
            reasoning += msg.info.tokens.reasoning ?? 0
            cost += msg.info.cost ?? 0
          }
          for (const part of msg.parts) {
            if (part.type === "tool") {
              toolUseCount++
              recent.push(`${part.tool}(${part.state.status})`)
            }
          }
        }
        return { toolUseCount, tokens: input + output + reasoning, cost, recent: recent.slice(-5) }
      })

      if (params.action === "tail") {
        // Pull path (child -> parent on demand): the child's transcript is
        // durable, so recent activity is readable any time without disturbing
        // the running child.
        const msgs = yield* sessions.messages({ sessionID: child.id, limit: params.limit ?? 10 }).pipe(
          Effect.catchCause(() => Effect.succeed([])),
        )
        const lines: string[] = []
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (part.type === "text" && part.text.trim().length > 0) {
              lines.push(`${msg.info.role}: ${snip(part.text)}`)
            } else if (part.type === "tool") {
              lines.push(`${msg.info.role}: [${part.tool} ${part.state.status}]`)
            }
          }
        }
        return {
          title: "task activity",
          metadata: meta,
          output: lines.slice(-40).join("\n") || "(no activity yet)",
        }
      }

      if (params.action === "status") {
        const progress = yield* childProgress(child.id, 50)
        const progressText = [
          `progress: ${progress.toolUseCount} tool calls, ${progress.tokens} tokens, $${progress.cost.toFixed(4)} cost`,
          ...(progress.recent.length > 0 ? [`recent: ${progress.recent.join(", ")}`] : []),
        ].join("\n")
        if (!job) {
          return {
            title: "task status",
            metadata: meta,
            output: `task_id: ${child.id}\nstatus: unknown (no job record — it finished before restart or was never backgrounded)\n${progressText}`,
          }
        }
        return {
          title: "task status",
          metadata: meta,
          output: `${renderStatus(job)}\n${progressText}`,
        }
      }

      if (params.action === "send") {
        if (!params.message) return yield* Effect.fail(new Error("background send requires message"))
        if (!job || job.status !== "running") {
          return yield* Effect.fail(
            new Error(
              `Task ${child.id} is not running (status: ${job?.status ?? "unknown"}).${job && job.status !== "running" ? ` Final state:\n${renderStatus(job)}` : ""}`,
            ),
          )
        }
        const notify = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (!notify?.notify) return yield* Effect.fail(new Error("Background send requires promptOps with notify support"))
        const input = {
          sessionID: child.id,
          agent: child.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: [`<task-message from="${ctx.sessionID}">`, params.message, "</task-message>"].join("\n"),
            },
          ],
        } as const
        // Worktree-isolated children drain under their own directory; deliver
        // there so the notice joins the running drain instead of starting a
        // concurrent one.
        const childWorktree =
          child.metadata && typeof child.metadata === "object"
            ? (child.metadata as Record<string, unknown>).worktree
            : undefined
        if (typeof childWorktree === "string" && childWorktree.length > 0) {
          const parentCtx = yield* InstanceState.context
          yield* notify.notify(input).pipe(
            Effect.provideService(InstanceRef, {
              ...parentCtx,
              directory: childWorktree,
              worktree: childWorktree,
            }),
          )
        } else {
          yield* notify.notify(input)
        }
        return {
          title: "message sent",
          metadata: meta,
          output: `Message delivered to running task ${child.id}. It will pick it up at its next step.`,
        }
      }

      if (params.action === "detach") {
        // Model-initiated mid-turn backgrounding (the Ctrl+B equivalent):
        // promote the running foreground task so this call returns immediately
        // with background state. The child's completion still notifies via the
        // promotion hook, exactly like the timeout upgrade path.
        if (!job || job.status !== "running") {
          return yield* Effect.fail(
            new Error(`Task ${child.id} is not running (status: ${job?.status ?? "unknown"}). Nothing to detach.`),
          )
        }
        if (job.metadata?.background === true) {
          return {
            title: "task detached",
            metadata: meta,
            output: `Task ${child.id} is already running in the background.`,
          }
        }
        yield* background.promote(child.id).pipe(Effect.ignore)
        return {
          title: "task detached",
          metadata: meta,
          output: [
            `Task ${child.id} moved to the background. You will be notified automatically when it finishes.`,
            "DO NOT duplicate this task's work — avoid working with the same files or topics it is using.",
          ].join("\n"),
        }
      }

      // kill
      if (!job || job.status !== "running") {
        return {
          title: "task kill",
          metadata: meta,
          output: `Task ${child.id} is not running (status: ${job?.status ?? "unknown"}). Nothing to kill.`,
        }
      }
      // Cancelling the job interrupts its fiber; runTask's onInterrupt cascades
      // into ops.cancel(childID) so the child session drain stops too.
      const cancelled = yield* background.cancel(child.id)
      return {
        title: "task killed",
        metadata: { action: params.action, task_id: child.id },
        output: `Task ${child.id} killed (status: ${cancelled?.status ?? "cancelled"}).`,
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
