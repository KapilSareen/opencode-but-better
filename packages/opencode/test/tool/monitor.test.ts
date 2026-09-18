import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Monitor } from "../../src/monitor/monitor"
import { MonitorTool } from "../../src/tool/monitor"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Cause } from "effect"

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
      Monitor.node,
    ]),
  )

const it = testEffect(layer())

const seed = Effect.fn("MonitorToolTest.seed")(function* () {
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

function stubOps(notified: SessionPrompt.PromptInput[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: () => Effect.never,
    notify: (input) =>
      Effect.sync(() => {
        notified.push(input)
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
}

function contextOf(chat: { id: SessionID }, assistant: Pick<SessionV1.Assistant, "id">, promptOps: TaskPromptOps) {
  return {
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function texts(inputs: SessionPrompt.PromptInput[]) {
  return inputs.flatMap((input) =>
    input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  )
}

describe("tool.monitor", () => {
  it.instance("delivers pattern-matched lines then an exit notice", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const notified: SessionPrompt.PromptInput[] = []
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { action: "start", command: "printf 'alpha\\nWATCHME\\nomega\\n'", pattern: "WATCHME" },
        contextOf(chat, assistant, stubOps(notified)),
      )
      expect(result.output).toContain("mon_")
      yield* pollWithTimeout(
        Effect.sync(() => (notified.length >= 2 ? (true as const) : undefined)),
        "monitor never delivered output + exit",
      )
      const bodies = (inputs: SessionPrompt.PromptInput[]) =>
        texts(inputs).map((text) => text.slice(text.indexOf("<output>\n") + "<output>\n".length, text.indexOf("\n</output>")))
      const outputEvents = notified.filter((input) => texts([input]).join("\n").includes('event="output"'))
      const exitEvents = notified.filter((input) => texts([input]).join("\n").includes('event="exit"'))
      expect(outputEvents).toHaveLength(1)
      expect(bodies(outputEvents).join("\n")).toBe("WATCHME")
      expect(exitEvents).toHaveLength(1)
      expect(texts(exitEvents).join("\n")).toContain('status="completed"')
    }),
  )

  it.instance("without a pattern only completion notifies, with tail", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const notified: SessionPrompt.PromptInput[] = []
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      yield* def.execute(
        { action: "start", command: "printf 'one\\ntwo\\n'" },
        contextOf(chat, assistant, stubOps(notified)),
      )
      yield* pollWithTimeout(
        Effect.sync(() => (notified.length >= 1 ? (true as const) : undefined)),
        "monitor never delivered exit",
      )
      // Give a stray extra delivery a chance to appear; there must be exactly one.
      yield* Effect.sleep("300 millis")
      expect(notified).toHaveLength(1)
      const all = texts(notified).join("\n")
      expect(all).toContain('event="exit"')
      expect(all).toContain("one")
      expect(all).toContain("two")
    }),
  )

  it.instance("stop kills a running monitor and status reflects it", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const notified: SessionPrompt.PromptInput[] = []
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const ctx = contextOf(chat, assistant, stubOps(notified))
      const started = yield* def.execute({ action: "start", command: "sleep 30" }, ctx)
      const id = started.output.match(/mon_[A-Z0-9]+/)?.[0]
      expect(id).toBeDefined()
      if (!id) throw new Error("monitor id not found")
      const running = yield* def.execute({ action: "status", monitor_id: id }, ctx)
      expect(running.output).toContain("status: running")
      const stopped = yield* def.execute({ action: "stop", monitor_id: id }, ctx)
      expect(stopped.output).toContain("stopped")
      const after = yield* def.execute({ action: "status", monitor_id: id }, ctx)
      expect(after.output).toContain("status: killed")
      const listed = yield* def.execute({ action: "list" }, ctx)
      expect(listed.output).toContain(id)
      expect(listed.output).toContain("killed")
    }),
  )

  it.instance("rejects invalid patterns and unknown monitors", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const notified: SessionPrompt.PromptInput[] = []
      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const ctx = contextOf(chat, assistant, stubOps(notified))
      const bad = yield* def
        .execute({ action: "start", command: "echo hi", pattern: "([invalid" }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(bad)).toBe(true)
      if (Exit.isSuccess(bad)) throw new Error("expected pattern failure")
      expect(String(Cause.squash(bad.cause))).toContain("Invalid monitor pattern")
      const stopMissing = yield* def.execute({ action: "stop", monitor_id: "mon_missing" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(stopMissing)).toBe(true)
      const statusMissing = yield* def.execute({ action: "status", monitor_id: "mon_missing" }, ctx)
      expect(statusMissing.output).toContain("Unknown monitor")
    }),
  )

  it.instance("reports nonzero exits as errors with tail", () =>
    Effect.gen(function* () {
      const monitor = yield* Monitor.Service
      const { chat } = yield* seed()
      const exits: Monitor.Info[] = []
      const info = yield* monitor.start({
        command: "echo boom; exit 3",
        sessionID: chat.id,
        onOutput: () => {},
        onExit: (finished) => {
          exits.push(finished)
        },
      })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* monitor.status(info.id)
          return current?.status !== "running" ? (true as const) : undefined
        }),
        "monitor never exited",
      )
      const final = yield* monitor.status(info.id)
      expect(final?.status).toBe("error")
      expect(final?.exitCode).toBe(3)
      expect(final?.tail.join("\n")).toContain("boom")
      expect(exits).toHaveLength(1)
    }),
  )
})
