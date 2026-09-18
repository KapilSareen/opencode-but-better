import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID } from "../../src/session/schema"
import { hasUnansweredInput } from "../../src/session/prompt"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function user(overrides?: Partial<SessionV1.User>): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID: "ses_test",
      time: { created: Date.now() },
      agent: "build",
      model: ref,
      ...overrides,
    } as SessionV1.User,
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text: "hello",
      },
    ],
  }
}

function assistant(parentID: string, finish?: string, tools?: SessionV1.ToolPart[]): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: parentID as SessionV1.Assistant["parentID"],
      sessionID: "ses_test",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      ...(finish ? { finish } : {}),
    } as SessionV1.Assistant,
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text: "done",
      },
      ...(tools ?? []),
    ],
  }
}

function toolPart(status: "running" | "error", interrupted = false): SessionV1.ToolPart {
  const messageID = MessageID.ascending()
  return {
    id: PartID.ascending(),
    messageID,
    sessionID: "ses_test",
    type: "tool",
    callID: "call-1",
    tool: "read",
    state: {
      status,
      input: {},
      ...(status === "error"
        ? { error: "boom", ...(interrupted ? { metadata: { interrupted: true } } : {}) }
        : {}),
      time: { start: Date.now() },
    },
  } as SessionV1.ToolPart
}

describe("hasUnansweredInput", () => {
  test("fresh user message with no assistant needs a drain", () => {
    expect(hasUnansweredInput([user()])).toBe(true)
  })

  test("answered user message needs nothing", () => {
    const first = user()
    expect(hasUnansweredInput([first, assistant(first.info.id, "stop")])).toBe(false)
  })

  test("tool-calls finish needs a drain", () => {
    const first = user()
    expect(hasUnansweredInput([first, assistant(first.info.id, "tool-calls")])).toBe(true)
  })

  test("pending tool part needs a drain", () => {
    const first = user()
    expect(
      hasUnansweredInput([first, assistant(first.info.id, "stop", [toolPart("running")])]),
    ).toBe(true)
  })

  test("orphaned interrupted tool does not need a drain", () => {
    const first = user()
    expect(
      hasUnansweredInput([first, assistant(first.info.id, "stop", [toolPart("error", true)])]),
    ).toBe(false)
  })

  test("second user message after an answered turn needs a drain", () => {
    const first = user()
    const second = user()
    expect(hasUnansweredInput([first, assistant(first.info.id, "stop"), second])).toBe(true)
  })

  test("empty history needs nothing", () => {
    expect(hasUnansweredInput([])).toBe(false)
  })
})
