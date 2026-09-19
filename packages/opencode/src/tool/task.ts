import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync } from "node:fs"
import os from "os"
import path from "path"
import { ulid } from "ulid"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  /**
   * Detached completion delivery: durably records the notification as a user
   * message, then ensures the parent drains it without parking behind a busy
   * run. Optional so older providers fall back to prompt().
   */
  notify?: (input: SessionPrompt.PromptInput) => Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Prefer background=true for independent work that can run while you continue elsewhere; use foreground only when you need the result before continuing.",
  "You will be notified automatically when a background task finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep or duplicate this task's work — avoid working with the same files or topics it is using.",
  "To check progress, use background tail sparingly; the child may also send milestone notes via notify_parent.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep or duplicate this task's work — avoid working with the same files or topics it is using. Check progress with background tail sparingly.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

// Foreground budget before a task upgrades to background instead of hanging
// the parent. A stuck child (e.g. infinite 429 retry) must not park the
// parent's tool fiber forever; completion still notifies via inject().
export const FOREGROUND_TASK_TIMEOUT_MS = 10 * 60 * 1000

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  isolation: Schema.optional(Schema.Literals(["off", "worktree"])).annotate({
    description:
      'Isolation mode. Set "worktree" to run the agent in a temporary git worktree with an isolated copy of the repository: its edits do not touch your working tree, the worktree is removed if the agent makes no changes, and its path is returned when it does. Omit to run in the shared working directory so the agent edits your files directly.',
  }),
}

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    const spawner = yield* ChildProcessSpawner

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      // Fork default: background subagents are always available, no experimental flag.
      const runInBackground = params.background === true

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === "background")
          ? []
          : [{ permission: "background" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === "monitor")
          ? []
          : [{ permission: "monitor" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const git = Effect.fn("TaskTool.worktreeGit")(function* (args: string[], cwd: string) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }))
            const output = yield* Stream.mkString(Stream.decodeText(handle.stdout))
            const errors = yield* Stream.mkString(Stream.decodeText(handle.stderr))
            const code = yield* handle.exitCode
            return { output: output.trim(), errors: errors.trim(), code }
          }),
        )
      })

      const setupWorktree = Effect.fn("TaskTool.setupWorktree")(function* (
        agentName: string,
        opts?: { explicit?: boolean },
      ) {
        const parentDir = yield* InstanceState.directory
        const top = yield* git(["rev-parse", "--show-toplevel"], parentDir)
        if (top.code !== 0 || !top.output) {
          // Fork default is worktree isolation; outside git there is nothing to
          // isolate with, so fall back to the shared directory unless the agent
          // explicitly demanded a worktree.
          if (!opts?.explicit) {
            yield* Effect.logWarning("worktree isolation unavailable, sharing parent directory", {
              agent: agentName,
              directory: parentDir,
              error: top.errors || "rev-parse failed",
            })
            return undefined
          }
          return yield* Effect.fail(
            new Error(
              `Agent "${agentName}" requires isolation "worktree", but the project is not a git repository (${top.errors || "rev-parse failed"}). Set isolation to "off" to run in the shared directory.`,
            ),
          )
        }
        const dir = path.join(os.tmpdir(), `opencode-agent-${ulid().toLowerCase()}`)
        const added = yield* git(["worktree", "add", "--detach", dir, "HEAD"], top.output)
        if (added.code !== 0) {
          return yield* Effect.fail(
            new Error(`Failed to create worktree for agent "${agentName}": ${added.errors || added.output}`),
          )
        }
        return dir
      })

      // Returns the kept directory when it has uncommitted changes, undefined
      // when it was removed. Never fails: cleanup problems keep the directory
      // and let the caller report it.
      const cleanupWorktree = Effect.fn("TaskTool.cleanupWorktree")(function* (dir: string) {
        const parentDir = yield* InstanceState.directory
        const top = yield* git(["rev-parse", "--show-toplevel"], parentDir).pipe(
          Effect.orElseSucceed(() => ({ output: parentDir, errors: "", code: 0 as const })),
        )
        const status = yield* git(["-C", dir, "status", "--porcelain"], top.output).pipe(
          Effect.orElseSucceed(() => ({ output: "", errors: "status failed", code: 1 as const })),
        )
        if (status.code !== 0) {
          const gone = yield* Effect.sync(() => !existsSync(dir))
          if (gone) return undefined
          yield* Effect.logWarning("worktree status failed, keeping directory", { dir, error: status.errors })
          return dir
        }
        if (status.output.length > 0) return dir
        const removed = yield* git(["worktree", "remove", "--force", dir], top.output).pipe(
          Effect.orElseSucceed(() => ({ output: "", errors: "remove failed", code: 1 as const })),
        )
        if (removed.code !== 0) {
          yield* Effect.logWarning("worktree remove failed, keeping directory", { dir, error: removed.errors })
          return dir
        }
        return undefined
      })

      // Isolation is opt-in. The main agent chooses per spawn with the
      // `isolation` parameter; an agent's configured default applies when the
      // parameter is omitted, otherwise the subagent shares the working
      // directory so its edits land in your repo. Resumed tasks reuse the
      // worktree recorded on the child session.
      const requestedIsolation = params.isolation ?? next.isolation ?? "off"
      const isolated = requestedIsolation === "worktree"
      const explicitIsolation = requestedIsolation === "worktree"
      const existingWorktree =
        isolated && session?.metadata && typeof session.metadata === "object"
          ? (session.metadata as Record<string, unknown>).worktree
          : undefined
      const worktreeDir =
        isolated && typeof existingWorktree === "string" && existingWorktree.length > 0
          ? existingWorktree
          : isolated
            ? yield* setupWorktree(next.name, { explicit: explicitIsolation })
            : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          ...(worktreeDir ? { metadata: { worktree: worktreeDir } } : {}),
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      // All child-session operations run under the child's directory so a
      // worktree-isolated drain joins the same runner/loop as its notifications.
      // This is a lightweight ambient override (same project, different cwd),
      // not a full project load: no new layer dependencies, no extra teardown.
      const parentCtx = yield* InstanceState.context
      const inChildContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        worktreeDir
          ? effect.pipe(
              Effect.provideService(
                InstanceRef,
                worktreeDir === parentCtx.directory ? parentCtx : { ...parentCtx, directory: worktreeDir, worktree: worktreeDir },
              ),
            )
          : effect
      const cancelChild = inChildContext(ops.cancel(nextSession.id))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const run = inChildContext(
          ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            variant: next.model ? undefined : variant,
            agent: next.name,
            parts,
          }),
        )
        // Capture the outcome first so worktree cleanup runs on success,
        // failure, and interruption alike, then re-raise.
        const exit = yield* run.pipe(Effect.exit)
        const keptDir = worktreeDir
          ? yield* cleanupWorktree(worktreeDir).pipe(Effect.catchCause(() => Effect.succeed(worktreeDir)))
          : undefined
        if (keptDir) yield* Effect.logWarning("isolated subagent worktree kept", { dir: keptDir, task: nextSession.id })
        const result = yield* exit
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        if (keptDir) return `${text}\n\nNote: worktree kept at ${keptDir} (has uncommitted changes).`
        return text
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const input: SessionPrompt.PromptInput = {
          sessionID: ctx.sessionID,
          agent: currentParent.agent ?? ctx.agent,
          variant,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: renderOutput({
                sessionID: nextSession.id,
                state,
                summary:
                  state === "completed"
                    ? `Background task completed: ${params.description}`
                    : `Background task failed: ${params.description}`,
                text,
              }),
            },
          ],
        }
        // Preferred path writes the message durably, then drains detached: a
        // busy parent picks it up on its next reload, an idle parent starts a
        // fresh drain. The legacy prompt() path parks behind ensureRunning
        // when busy and may never drain after the parent exits (lost notice).
        if (ops.notify) {
          yield* ops.notify(input).pipe(Effect.ignore)
          return
        }
        yield* ops.prompt(input).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => cancelChild)),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: worktreeDir ? `${BACKGROUND_STARTED}\nWorking directory: ${worktreeDir}` : BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = cancelChild

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const outcome = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            ).pipe(Effect.timeoutOption(FOREGROUND_TASK_TIMEOUT_MS))
            if (Option.isNone(outcome)) {
              // Foreground budget exhausted (e.g. child stuck retrying): upgrade
              // to background instead of hanging the parent forever. The child
              // keeps running and completion still notifies via inject().
              yield* background.promote(nextSession.id).pipe(Effect.ignore)
              yield* notify(nextSession.id)
              return backgroundResult()
            }
            const result = outcome.value
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    // Fork default: background mode is always described and always available.
    return {
      description: [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n"),
      parameters: Parameters,
      jsonSchema: undefined,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
