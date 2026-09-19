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
  maximized: boolean
}

const blank: Entry = { open: false, focused: false, maximized: false }
const KV_KEY = "side_chat_sessions"

export const { use: useSidebarChat, provider: SidebarChatProvider } = createSimpleContext({
  name: "SidebarChat",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const kv = useKV()
    const toast = useToast()
    const [state, setState] = createStore<Record<string, Entry>>({})

    const patch = (parentID: string, value: Partial<Entry>) =>
      setState(parentID, (prev) => ({ ...(prev ?? blank), ...value }))

    const stored = (parentID: string): string | undefined => {
      const map = kv.get(KV_KEY, {}) as Record<string, string>
      return map[parentID]
    }

    const id = (parentID: string) => state[parentID]?.id ?? stored(parentID)
    const isOpen = (parentID: string) => state[parentID]?.open ?? false
    const isFocused = (parentID: string) => state[parentID]?.focused ?? false
    const isMaximized = (parentID: string) => state[parentID]?.maximized ?? false

    const open = (parentID: string) => patch(parentID, { open: true })
    const close = (parentID: string) => patch(parentID, { open: false, focused: false })
    const focus = (parentID: string) => patch(parentID, { open: true, focused: true })
    const blur = (parentID: string) => patch(parentID, { focused: false })
    const toggleMaximize = (parentID: string) => {
      const next = !isMaximized(parentID)
      patch(parentID, { open: true, focused: true, maximized: next })
    }
    const toggle = (parentID: string) => {
      if (!isOpen(parentID)) return focus(parentID)
      // Focused side input: the toggle closes the panel. Esc is the way back
      // to the main prompt without closing.
      if (isFocused(parentID)) return close(parentID)
      return focus(parentID)
    }

    // Start a fresh side chat with the parent's current context. The previous
    // side session stays durable but is unlinked; a new one is created so the
    // panel switches to an empty transcript and the next ask snapshots anew.
    const reset = async (parentID: string) => {
      const previous = id(parentID)
      if (previous) await sdk.client.session.abort({ sessionID: previous }).catch(() => undefined)
      patch(parentID, { id: undefined, open: true, focused: true })
      const map = { ...(kv.get(KV_KEY, {}) as Record<string, string>) }
      delete map[parentID]
      kv.set(KV_KEY, map)
      try {
        const result = await sdk.client.session.create(
          {
            parentID,
            title: "Side chat",
            metadata: { sideChatOf: parentID },
          },
          { throwOnError: true },
        )
        const created = result.data!.id
        patch(parentID, { id: created, open: true, focused: true })
        remember(parentID, created)
        await sync.session.sync(created)
      } catch (error) {
        toast.show({
          message: error instanceof Error ? error.message : "Failed to start a new side chat",
          variant: "error",
        })
      }
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
      patch(parentID, { id: created, open: true })
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
      isMaximized,
      open,
      close,
      focus,
      blur,
      toggle,
      toggleMaximize,
      reset,
      ensure,
      ask,
      stop,
    }
  },
})
