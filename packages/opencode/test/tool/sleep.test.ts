import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MAX_SLEEP_MS, SleepTool } from "../../src/tool/sleep"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
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
    ]),
  )

const it = testEffect(layer())

const seed = Effect.fn("SleepToolTest.seed")(function* () {
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

function contextOf(chat: { id: SessionID }, assistant: Pick<SessionV1.Assistant, "id">) {
  return {
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: {},
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.sleep", () => {
  it.instance("returns finished when nothing arrives before the deadline", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* SleepTool
      const def = yield* tool.init()
      const result = yield* def.execute({ duration_ms: 60 }, contextOf(chat, assistant))
      expect(result.metadata.woken).toBe(false)
      expect(result.output).toContain("no new input")
    }),
  )

  it.instance("wakes early when new session input arrives", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* SleepTool
      const def = yield* tool.init()
      const fiber = yield* def.execute({ duration_ms: 30_000 }, contextOf(chat, assistant)).pipe(Effect.forkChild)
      yield* Effect.sleep("100 millis")
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      const result = yield* Fiber.join(fiber)
      expect(result.metadata.woken).toBe(true)
      expect(result.output).toContain("New input arrived")
    }),
  )

  it.instance("rejects durations outside 1..MAX_SLEEP_MS", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* SleepTool
      const def = yield* tool.init()
      for (const duration_ms of [0, -5, MAX_SLEEP_MS + 1]) {
        const exit = yield* def.execute({ duration_ms }, contextOf(chat, assistant)).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("expected duration failure")
        expect(String(Cause.squash(exit.cause))).toContain("duration_ms")
      }
    }),
  )
})
