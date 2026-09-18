import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Layer } from "effect"
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
import { Cron } from "../../src/cron/cron"
import { nextCronRun, parseCronExpression } from "../../src/cron/cron"
import { CronTool } from "../../src/tool/cron"
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

describe("cron expression", () => {
  test("parses wildcards, steps, ranges, and lists", () => {
    expect(parseCronExpression("*/15 9-17 * * 1-5")?.minute.has(30)).toBe(true)
    expect(parseCronExpression("*/15 9-17 * * 1-5")?.minute.has(31)).toBe(false)
    expect(parseCronExpression("*/15 9-17 * * 1-5")?.hour.has(8)).toBe(false)
    expect(parseCronExpression("0 0 1 1 *")?.month.has(1)).toBe(true)
    expect(parseCronExpression("0,30 * * * *")?.minute.has(30)).toBe(true)
  })

  test("rejects malformed expressions", () => {
    expect(parseCronExpression("* * * *")).toBeUndefined()
    expect(parseCronExpression("61 * * * *")).toBeUndefined()
    expect(parseCronExpression("*/0 * * * *")).toBeUndefined()
    expect(parseCronExpression("a b c d e")).toBeUndefined()
    expect(parseCronExpression("0 0 30 2 *")).toBeDefined()
  })

  test("computes the next run across boundaries", () => {
    // 2026-09-18 is a Friday. 10:04 local -> next 10:05 weekday match.
    const from = new Date(2026, 8, 18, 10, 4, 30).getTime()
    const fields = parseCronExpression("5 10 * * 1-5")!
    expect(new Date(nextCronRun(fields, from)!).getMinutes()).toBe(5)
    // Sundays are excluded by the weekday restriction.
    const sunday = new Date(2026, 8, 20, 9, 0, 0).getTime()
    const next = new Date(nextCronRun(parseCronExpression("0 9 * * 1-5")!, sunday)!)
    expect(next.getDay()).toBe(1)
    expect(next.getHours()).toBe(9)
  })

  test("returns undefined for impossible dates", () => {
    // Feb 30 never occurs.
    expect(nextCronRun(parseCronExpression("0 0 30 2 *")!, Date.now())).toBeUndefined()
  })
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
      Cron.node,
    ]),
  )

const it = testEffect(layer())

const seed = Effect.fn("CronToolTest.seed")(function* () {
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

describe("tool.cron", () => {
  it.instance("creates, lists, and deletes a job", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const notified: SessionPrompt.PromptInput[] = []
      const tool = yield* CronTool
      const def = yield* tool.init()
      const ctx = contextOf(chat, assistant, stubOps(notified))
      const created = yield* def.execute(
        { action: "create", schedule: "*/5 * * * *", message: "standup time" },
        ctx,
      )
      expect(created.output).toContain("cron_")
      const listed = yield* def.execute({ action: "list" }, ctx)
      expect(listed.output).toContain("*/5 * * * *")
      const cron = yield* Cron.Service
      const id = (yield* cron.list())[0]?.id
      expect(id).toBeDefined()
      const status = yield* def.execute({ action: "status", cron_id: id }, ctx)
      expect(status.output).toContain("status: active")
      const deleted = yield* def.execute({ action: "delete", cron_id: id }, ctx)
      expect(deleted.output).toContain("deleted")
      const gone = yield* def.execute({ action: "status", cron_id: id }, ctx)
      expect(gone.output).toContain("status: cancelled")
      const missing = yield* def.execute({ action: "status", cron_id: "cron_missing" }, ctx)
      expect(missing.output).toContain("Unknown job")
    }),
  )

  it.instance("rejects invalid and impossible schedules", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const notified: SessionPrompt.PromptInput[] = []
      const tool = yield* CronTool
      const def = yield* tool.init()
      const ctx = contextOf(chat, assistant, stubOps(notified))
      for (const schedule of ["not a cron", "0 0 30 2 *"]) {
        const exit = yield* def.execute({ action: "create", schedule, message: "x" }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error(`expected rejection for ${schedule}`)
      }
    }),
  )

  it.instance(
    "fires a one-shot at the next minute boundary and notifies",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const notified: SessionPrompt.PromptInput[] = []
        const tool = yield* CronTool
        const def = yield* tool.init()
        const ctx = contextOf(chat, assistant, stubOps(notified))
        const now = new Date(Date.now() + 65_000)
        const schedule = `${now.getMinutes()} ${now.getHours()} * * *`
        const created = yield* def.execute({ action: "create", schedule, message: "ping", once: true }, ctx)
        expect(created.output).toContain("cron_")
        yield* pollWithTimeout(
          Effect.sync(() => (notified.length >= 1 ? (true as const) : undefined)),
          "cron never fired",
          "100 seconds",
        )
        const texts = notified.flatMap((input) =>
          input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        expect(texts.join("\n")).toContain("ping")
        const cron = yield* Cron.Service
        const id = (yield* cron.list())[0]?.id
        const status = yield* cron.status(id!)
        expect(status?.status).toBe("completed")
      }),
    120_000,
  )
})
