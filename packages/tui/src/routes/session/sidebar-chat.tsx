import { TextareaRenderable } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useSidebarChat } from "../../context/sidebar-chat"
import { useSync } from "../../context/sync"
import { useTheme, tint } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useBindings, useCommandShortcut } from "../../keymap"
import { Spinner } from "../../component/spinner"
import { SplitBorder } from "../../ui/border"

export function SidebarChat(props: { parentID: string; width: number; overlay?: boolean }) {
  const chat = useSidebarChat()
  const sync = useSync()
  const { theme } = useTheme()
  const muted = () => tint(theme.textMuted, theme.text, 0.55)
  const tuiConfig = useTuiConfig()
  const toggleShortcut = useCommandShortcut("session.side_chat")
  const newShortcut = useCommandShortcut("session.side_chat.new")
  const maximizeShortcut = useCommandShortcut("session.side_chat.maximize")
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable

  const spacious = createMemo(() => props.width >= 64)
  const maximized = createMemo(() => chat.isMaximized(props.parentID))
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

  // The panel exists to ask while the main agent keeps working, so surface the
  // main session's live status here.
  const mainStatus = createMemo(() => sync.data.session_status?.[props.parentID])
  const mainBusy = createMemo(() => mainStatus()?.type === "busy" || mainStatus()?.type === "retry")

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
      width={props.width}
      height="100%"
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={props.overlay ? "absolute" : "relative"}
      onMouseDown={() => chat.focus(props.parentID)}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>
          <b>Side chat</b>
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={muted()} onMouseUp={() => void chat.reset(props.parentID)}>
            new<Show when={spacious() && newShortcut()}>{` ${newShortcut()}`}</Show>
          </text>
          <text fg={muted()} onMouseUp={() => chat.toggleMaximize(props.parentID)}>
            {maximized() ? "minimize" : "maximize"}
            <Show when={spacious() && maximizeShortcut()}>{` ${maximizeShortcut()}`}</Show>
          </text>
          <text fg={muted()} onMouseUp={() => chat.close(props.parentID)}>
            close
          </text>
        </box>
      </box>

      <box flexDirection="row" gap={1} flexShrink={0}>
        <Show
          when={mainBusy()}
          fallback={
            <>
              <text fg={theme.success}>•</text>
              <text fg={muted()}>main idle · shares its context</text>
            </>
          }
        >
          <Spinner color={theme.accent}>main working</Spinner>
        </Show>
      </box>

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
              <box
                flexDirection="column"
                border={["left"]}
                customBorderChars={SplitBorder.customBorderChars}
                borderColor={turn.role === "user" ? theme.primary : theme.accent}
                paddingLeft={2}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={turn.role === "user" ? theme.backgroundElement : undefined}
              >
                <text fg={turn.role === "user" ? theme.primary : theme.accent}>
                  <b>{turn.role === "user" ? "You" : "Side"}</b>
                </text>
                <text fg={theme.text}>{turn.text}</text>
              </box>
            )}
          </For>
          <Show when={busy()}>
            <Spinner color={muted()}>answering…</Spinner>
          </Show>
          <Show when={turns().length === 0 && !busy()}>
            <text fg={muted()}>
              {sideID() ? "Ask a follow-up below." : "Type a question below to start a side chat."}
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
          onMouseDown={() => chat.focus(props.parentID)}
          placeholder="Ask something about this session…"
          placeholderColor={muted()}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
          cursorStyle={tuiConfig.cursor}
        />
        <box flexDirection="row" justifyContent="space-between">
          <text fg={muted()}>
            enter send
            <Show when={toggleShortcut()}>
              <span> · {toggleShortcut()} {chat.isFocused(props.parentID) ? "close" : "focus"}</span>
            </Show>
            <span> · esc back</span>
          </text>
          <Show when={busy()}>
            <text fg={muted()} onMouseUp={() => void chat.stop(props.parentID)}>
              stop
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}
