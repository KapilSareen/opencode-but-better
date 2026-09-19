import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useKV } from "./kv"
import { useToast } from "../ui/toast"

type Entry = {
  id?: string
  open: boolean
  focused: boolean
}

const KV_KEY = "side_chat_sessions"

export const { use: useSidebarChat, provider: SidebarChatProvider } = createSimpleContext({
  name: "SidebarChat",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const kv = useKV()
    const toast = useToast()
    const [state, setState] = createStore<Record<string, Entry>>({})

    const stored = (parentID: string): string | undefined => {
      const map = kv.get(KV_KEY, {}) as Record<string, string>
      return map[parentID]
    }

    const id = (parentID: string) => state[parentID]?.id ?? stored(parentID)
    const isOpen = (parentID: string) => state[parentID]?.open ?? false
    const isFocused = (parentID: string) => state[parentID]?.focused ?? false

    const open = (parentID: string) =>
      setState(parentID, (prev) => ({ ...(prev ?? { open: false, focused: false }), open: true }))
    const close = (parentID: string) => setState(parentID, () => ({ open: false, focused: false }))
    const focus = (parentID: string) =>
      setState(parentID, (prev) => ({ ...(prev ?? { open: false, focused: false }), open: true, focused: true }))
    const blur = (parentID: string) =>
      setState(parentID, (prev) => (prev ? { ...prev, focused: false } : { open: false, focused: false }))
    const toggle = (parentID: string) => {
      if (!isOpen(parentID) || !isFocused(parentID)) return focus(parentID)
      return blur(parentID)
    }

    // Start a fresh side chat with the parent's current context. The previous
    // side session stays durable but is unlinked; the next ask snapshots anew.
    const reset = (parentID: string) => {
      const map = { ...(kv.get(KV_KEY, {}) as Record<string, string>) }
      delete map[parentID]
      kv.set(KV_KEY, map)
      setState(parentID, () => ({ open: true, focused: true }))
    }

    const remember = (parentID: string, sideID: string) => {
      const map = { ...(kv.get(KV_KEY, {}) as Record<string, string>), [parentID]: sideID }
      kv.set(KV_KEY, map)
    }

    const ensure = async (parentID: string): Promise<string> => {
      const existing = id(parentID)
      if (existing) return existing
      const result = await sdk.client.session.create(
        {
          parentID,
          title: "Side chat",
          metadata: { sideChatOf: parentID },
        },
        { throwOnError: true },
      )
      const created = result.data!.id
      setState(parentID, (prev) => ({ ...(prev ?? { open: true, focused: false }), id: created, open: true }))
      remember(parentID, created)
      await sync.session.sync(created)
      return created
    }

    const ask = async (parentID: string, question: string) => {
      const text = question.trim()
      if (!text) {
        focus(parentID)
        return
      }
      // Focus the panel so the follow-up input is ready to type into.
      focus(parentID)
      try {
        const sideID = await ensure(parentID)
        await sdk.client.session.promptAsync(
          {
            sessionID: sideID,
            parts: [{ type: "text", text }],
          },
          { throwOnError: true },
        )
      } catch (error) {
        toast.show({
          message: error instanceof Error ? error.message : "Failed to send side question",
          variant: "error",
        })
      }
    }

    const stop = async (parentID: string) => {
      const sideID = id(parentID)
      if (!sideID) return
      await sdk.client.session.abort({ sessionID: sideID }).catch(() => undefined)
    }

    return {
      id,
      isOpen,
      isFocused,
      open,
      close,
      focus,
      blur,
      toggle,
      reset,
      ensure,
      ask,
      stop,
    }
  },
})
