import { TextareaRenderable } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useSidebarChat } from "../../context/sidebar-chat"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useBindings } from "../../keymap"
import { Spinner } from "../../component/spinner"

export function SidebarChat(props: { parentID: string; overlay?: boolean }) {
  const chat = useSidebarChat()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable

  const sideID = createMemo(() => chat.id(props.parentID))
  const messages = createMemo(() => {
    const id = sideID()
    return id ? (sync.data.message[id] ?? []) : []
  })
  const status = createMemo(() => {
    const id = sideID()
    return id ? sync.data.session_status?.[id] : undefined
  })
  const busy = createMemo(() => status()?.type === "busy" || status()?.type === "retry")

  const turns = createMemo(() =>
    messages().flatMap((message) => {
      const text = (sync.data.part[message.id] ?? [])
        .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n\n")
        .trim()
      if (!text) return []
      return [{ id: message.id, role: message.role, text }]
    }),
  )

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (!chat.isOpen(props.parentID) || !chat.isFocused(props.parentID)) {
      if (textarea.focused) textarea.blur()
      return
    }
    if (!textarea.focused) textarea.focus()
  })

  async function submit() {
    if (!textarea || textarea.isDestroyed) return
    const text = textarea.plainText
    if (!text.trim()) return
    textarea.setText("")
    await chat.ask(props.parentID, text)
  }

  useBindings(() => ({
    target,
    enabled: target() !== undefined,
    priority: 1,
    bindings: [
      {
        key: "return",
        preventDefault: true,
        desc: "Send side chat message",
        group: "Side chat",
        cmd: () => void submit(),
      },
      {
        key: "escape",
        preventDefault: true,
        desc: "Return to main prompt",
        group: "Side chat",
        cmd: () => chat.blur(props.parentID),
      },
    ],
  }))

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={42}
      height="100%"
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={props.overlay ? "absolute" : "relative"}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>
          <b>Side chat</b>
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted} onMouseUp={() => chat.reset(props.parentID)}>
            new
          </text>
          <text fg={theme.textMuted} onMouseUp={() => chat.close(props.parentID)}>
            close
          </text>
        </box>
      </box>
      <text fg={theme.textMuted}>
        {busy() ? "using this session's context" : "shares this session's context, no tools"}
      </text>

      <scrollbox
        flexGrow={1}
        minHeight={0}
        stickyScroll={true}
        stickyStart="bottom"
        marginTop={1}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <box flexDirection="column" gap={1} paddingRight={1}>
          <For each={turns()}>
            {(turn) => (
              <box flexDirection="column">
                <text fg={turn.role === "user" ? theme.textMuted : theme.accent}>
                  <b>{turn.role === "user" ? "You" : "Side"}</b>
                </text>
                <text fg={turn.role === "user" ? theme.textMuted : theme.text}>{turn.text}</text>
              </box>
            )}
          </For>
          <Show when={busy()}>
            <Spinner color={theme.textMuted}>answering…</Spinner>
          </Show>
          <Show when={turns().length === 0 && !busy()}>
            <text fg={theme.textMuted}>
              {sideID()
                ? "Ask a follow-up below."
                : "Type a question below to start a side chat."}
            </text>
          </Show>
        </box>
      </scrollbox>

      <box flexShrink={0} flexDirection="column" gap={1} marginTop={1}>
        <textarea
          height={3}
          ref={(value: TextareaRenderable) => {
            textarea = value
            setTarget(value)
          }}
          placeholder="Ask something about this session…"
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
          cursorStyle={tuiConfig.cursor}
        />
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>enter send · esc back</text>
          <Show when={busy()}>
            <text fg={theme.textMuted} onMouseUp={() => void chat.stop(props.parentID)}>
              stop
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}
