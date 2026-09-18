import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { BackgroundTool } from "../../src/tool/background"
import { NotifyParentTool } from "../../src/tool/notify_parent"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"


afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
  )

const it = testEffect(layer())

const seed = Effect.fn("BackgroundToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function contextOf(chat: { id: SessionID }, assistant: Pick<SessionV1.Assistant, "id">, promptOps?: TaskPromptOps) {
  return {
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: promptOps ? { promptOps } : {},
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: () => Effect.never,
  }
}

describe("tool.background", () => {
  it.instance("lists only the calling session's child tasks", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat } = yield* seed()
      const other = yield* sessions.create({ title: "Other" })
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const foreign = yield* sessions.create({ parentID: other.id, title: "foreign" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        title: "mine",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: foreign.id,
        type: "task",
        title: "not mine",
        metadata: { parentSessionId: other.id, sessionId: foreign.id },
        run: Effect.never,
      })
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { action: "list" },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          extra: {},
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.output).toContain(child.id)
      expect(result.output).not.toContain(foreign.id)
    }),
  )

  it.instance("reports status with output when the child completes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        title: "worker",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.succeed("child output"),
      })
      const waited = yield* jobs.wait({ id: child.id, timeout: 5_000 })
      expect(waited.info?.status).toBe("completed")
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const result = yield* def.execute({ action: "status", task_id: child.id }, contextOf(chat, assistant))
      expect(result.output).toContain("status: completed")
      expect(result.output).toContain("child output")
    }),
  )

  it.instance("sends a message into a running child via ops.notify", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        title: "worker",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      const notified: SessionPrompt.PromptInput[] = []
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        notify: (input) =>
          Effect.sync(() => {
            notified.push(input)
            return {
              info: {
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: input.sessionID,
                time: { created: Date.now() },
                agent: "general",
                model: ref,
              },
              parts: [],
            } as SessionV1.WithParts
          }),
      }
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { action: "send", task_id: child.id, message: "focus on the cache path" },
        contextOf(chat, assistant, promptOps),
      )
      expect(result.output).toContain(child.id)
      yield* pollWithTimeout(
        Effect.sync(() => (notified.length === 1 ? (true as const) : undefined)),
        "send never called ops.notify",
      )
      expect(notified[0]?.sessionID).toBe(child.id)
      expect(notified[0]?.parts[0]?.type).toBe("text")
      if (notified[0]?.parts[0]?.type === "text") expect(notified[0].parts[0].text).toContain("focus on the cache path")
    }),
  )

  it.instance("send fails when the child already finished", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.succeed("done"),
      })
      yield* jobs.wait({ id: child.id, timeout: 5_000 })
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute({ action: "send", task_id: child.id, message: "too late" }, contextOf(chat, assistant, stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected send failure")
      expect(String(Cause.squash(exit.cause))).toContain("not running")
    }),
  )

  it.instance("kills a running child and reports nothing to kill when finished", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const running = yield* sessions.create({ parentID: chat.id, title: "running" })
      const done = yield* sessions.create({ parentID: chat.id, title: "done" })
      yield* jobs.start({
        id: running.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: running.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: done.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: done.id },
        run: Effect.succeed("finished"),
      })
      yield* jobs.wait({ id: done.id, timeout: 5_000 })
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const killed = yield* def.execute(
        { action: "kill", task_id: running.id },
        contextOf(chat, assistant, stubOps()),
      )
      expect(killed.output).toContain("killed")
      expect((yield* jobs.get(running.id))?.status).toBe("cancelled")
      const noop = yield* def.execute({ action: "kill", task_id: done.id }, contextOf(chat, assistant, stubOps()))
      expect(noop.output).toContain("Nothing to kill")
    }),
  )

  it.instance("detaches a running foreground task to background", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const foreground = yield* sessions.create({ parentID: chat.id, title: "foreground" })
      const done = yield* sessions.create({ parentID: chat.id, title: "done" })
      yield* jobs.start({
        id: foreground.id,
        type: "task",
        title: "foreground work",
        metadata: { parentSessionId: chat.id, sessionId: foreground.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: done.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: done.id },
        run: Effect.succeed("finished"),
      })
      yield* jobs.wait({ id: done.id, timeout: 5_000 })
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const ctx = contextOf(chat, assistant, stubOps())
      const detached = yield* def.execute({ action: "detach", task_id: foreground.id }, ctx)
      expect(detached.output).toContain("moved to the background")
      expect((yield* jobs.get(foreground.id))?.metadata?.background).toBe(true)
      expect((yield* jobs.get(foreground.id))?.status).toBe("running")
      const again = yield* def.execute({ action: "detach", task_id: foreground.id }, ctx)
      expect(again.output).toContain("already running in the background")
      const noop = yield* def.execute({ action: "detach", task_id: done.id }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(noop)).toBe(true)
    }),
  )

  it.instance("detaches by spawn name", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "named work (@general subagent)" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        title: "named work",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { action: "detach", name: "named work" },
        contextOf(chat, assistant, stubOps()),
      )
      expect(result.output).toContain("moved to the background")
      expect((yield* jobs.get(child.id))?.metadata?.background).toBe(true)
    }),
  )

  it.instance("rejects task_ids that are not direct children", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const other = yield* sessions.create({ title: "Other" })
      const foreign = yield* sessions.create({ parentID: other.id, title: "foreign" })
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute({ action: "status", task_id: foreign.id }, contextOf(chat, assistant, stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected rejection")
      expect(String(Cause.squash(exit.cause))).toContain("Unknown child task")
      const missing = yield* def
        .execute({ action: "status", task_id: "ses_missing" }, contextOf(chat, assistant, stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }),
  )

  it.instance("tails a child's recent activity without disturbing it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: child.id,
        agent: "general",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: child.id,
        mode: "general",
        agent: "general",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: child.id,
        type: "text",
        text: "working on the cache path",
      })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { action: "tail", task_id: child.id },
        contextOf(chat, assistant, stubOps()),
      )
      expect(result.output).toContain("working on the cache path")
      expect((yield* jobs.get(child.id))?.status).toBe("running")
    }),
  )

  it.instance("notify_parent delivers a child progress note into the parent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const kidAssistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: assistant.id,
        sessionID: child.id,
        mode: "general",
        agent: "general",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      })
      const delivered: SessionPrompt.PromptInput[] = []
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        notify: (input) =>
          Effect.sync(() => {
            delivered.push(input)
            return {
              info: {
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: input.sessionID,
                time: { created: Date.now() },
                agent: "build",
                model: ref,
              },
              parts: [],
            } as SessionV1.WithParts
          }),
      }
      const tool = yield* NotifyParentTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { message: "milestone: cache index done" },
        {
          sessionID: child.id,
          messageID: kidAssistant.id,
          agent: "general",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.output).toContain("Keep running")
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.sessionID).toBe(chat.id)
      const [part] = delivered[0]?.parts ?? []
      expect(part?.type).toBe("text")
      if (part?.type === "text") {
        expect(part.text).toContain("milestone: cache index done")
        expect(part.text).toContain(`from="${child.id}"`)
      }
    }),
  )

  it.instance("notify_parent rejects top-level sessions without a parent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* NotifyParentTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute({ message: "hello" }, contextOf(chat, assistant, stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected rejection")
      expect(String(Cause.squash(exit.cause))).toContain("only available to child tasks")
    }),
  )

  it.instance("kills a running child fiber without hanging the caller", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const started = yield* Deferred.make<void>()
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      })
      yield* Deferred.await(started)
      const tool = yield* BackgroundTool
      const def = yield* tool.init()
      const fiber = yield* def
        .execute({ action: "kill", task_id: child.id }, contextOf(chat, assistant, stubOps()))
        .pipe(Effect.forkChild)
      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain("killed")
    }),
  )
})
