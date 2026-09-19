// Side Chat ("/btw") support.
//
// A side chat is a hidden child session that answers questions against the
// parent conversation's context without touching the parent transcript and
// without blocking the parent drain. Context is shared by prefix: the parent's
// frozen message prefix is replayed as the head of the side request, so a
// provider that caches on content prefix serves it as a cache read instead of
// a fresh upload. Side sessions persist only their own Q/A turns.

import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionID } from "./schema"

export const SIDE_CHAT_OF = "sideChatOf"
export const SIDE_CUTOFF = "sideCutoff"

export const REMINDER = `<system-reminder>
This is a side question from the user. Answer it directly in a single response using the conversation context provided above.

Important context:
- You are a separate, lightweight instance. The main agent is NOT interrupted; it continues working independently in the background.
- You share the conversation context but are a completely separate instance.
- Do NOT reference being interrupted or what you were "previously doing"; that framing is incorrect.

Critical constraints:
- You have NO tools available. You cannot read files, run commands, search, or take any actions.
- NEVER say "Let me check...", "I'll now...", or promise to take any action.
- If you do not know the answer, say so; do not offer to look it up.

Answer the question concisely.</system-reminder>`

export function parentOf(metadata: Record<string, any> | undefined): SessionID | undefined {
  const value = metadata?.[SIDE_CHAT_OF]
  return typeof value === "string" && value.length > 0 ? (value as SessionID) : undefined
}

export function cutoffOf(metadata: Record<string, any> | undefined): string | undefined {
  const value = metadata?.[SIDE_CUTOFF]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// The parent prefix is frozen at the last message the parent had fully settled:
// a user message, or an assistant turn that finished without pending tool
// calls. This excludes the assistant message currently streaming, if any, which
// is exactly the point the parent's own last request was built from.
export function lastStableMessageID(msgs: SessionV1.WithParts[]): string | undefined {
  const msg = msgs.findLast(
    (m) =>
      m.info.role === "user" ||
      (m.info.role === "assistant" &&
        !!m.info.finish &&
        !["tool-calls", "unknown"].includes(m.info.finish) &&
        !!m.info.time.completed),
  )
  return msg ? String(msg.info.id) : undefined
}

export * as SessionSideChat from "./side-chat"
