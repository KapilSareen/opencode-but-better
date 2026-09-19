# opencode-extended

An opinionated fork of opencode: background subagents that don't block you, side chats that answer from context without interrupting, agents that watch things and wake you up, and diffs that stay on screen. Drop-in replacement for the `opencode` binary, same sessions, same keys, same config.

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>

## What you can do now

- **Background subagents that don't block** — spawn work with `background: true` and keep chatting. Completion notices land mid-conversation without breaking state or caches. No flags, no asking; background-first is the default.
- **Side chat (`/btw`) that doesn't interrupt**: ask a quick question against the current session's context in the right-hand panel and keep a follow-up conversation there while the main agent keeps working. The parent transcript is never copied: the side chat replays it as a cached prefix, so context is shared without re-uploading tokens. Runs in a hidden child session with no tools. Keys: `/btw <question>`, `<leader>j` focus/close, `<leader>k` new, `<leader>z` full screen, `esc` back to main.
- **Steer running agents** — `background send` (or by spawn `name`) drops a message into a running child at its next step boundary; `status` shows spend, tokens, and recent tool activity; `tail` reads its live transcript; `kill` stops it; `detach` is the model-callable Ctrl+B that moves a foreground task to background mid-turn.
- **Children talk back** — running subagents push milestones to you via `notify_parent` instead of you polling them.
- **Monitors** — `monitor start` watches a shell command and streams matching output lines into your session; process-group kill so orphans can't hang it.
- **Cron** — `cron create` delivers a message into a session on a 5-field schedule (one-shots supported).
- **Sleep** — `sleep` parks the agent with early wake the moment new input arrives, instead of burning a shell on `sleep 300`.
- **Worktree isolation (default on)** — every subagent works in its own detached git worktree, auto-removed when clean, kept and reported when dirty. `"isolation": "off"` opts out per agent.
- **ESC picks up queued input** instead of stranding it; programmatic aborts/kills still stay dead.
- **Completed diffs stay visible** in the TUI when tool details are hidden — no more flash-then-gone edits.

## Setup

Prerequisites: [Bun](https://bun.sh) >= 1.3 and git. Build takes a few minutes (embeds the web UI):

```bash
git clone -b better https://github.com/KapilSareen/opencode-extended.git
cd opencode-extended
bun install
bun run --cwd packages/opencode script/build.ts --single --skip-install
# binary: packages/opencode/dist/<platform>-<arch>/bin/opencode
```

Use it as your `opencode` (same sessions, credentials, config). Put this wrapper
earlier on `PATH` than the upstream binary (e.g. `~/.local/bin/opencode`):

```sh
#!/bin/sh
export OPENCODE_DB="$HOME/.local/share/opencode/opencode.db"
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
exec /path/to/opencode-extended/packages/opencode/dist/opencode-linux-x64/bin/opencode "$@"
```

(`OPENCODE_DB` pins the shared sessions database — dev builds otherwise use a
version-derived DB filename. Auth, config, and cache are shared through the
standard XDG paths.)

Make sure the shared global config names a working default model, e.g. in
`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "model": "opencode-go/deepseek-v4.1-flash"
}
```

Notes:

- Project-local `.opencode/` directories are shared with upstream by design.
- Serving both binaries at once? Give them different ports (`serve --port ...`).
- The upstream binary stays wherever it was — remove the wrapper to go back.

## Everyday reference

| Want | Do |
| ---- | -- |
| Run something in background | `task` with `background: true` (preferred for independent work) |
| Check / steer / stop a child | `background status\|send\|kill\|list\|tail\|detach` (by `task_id` or `name`) |
| Get progress pushed to you | child calls `notify_parent` at milestones |
| Watch a command | `monitor start` with a regex `pattern`; `stop\|status\|list` to manage |
| Recurring nudge | `cron create` with `"*/15 * * * *"` + message; `delete` to remove |
| Wait for something | `sleep` with `duration_ms` (wakes early on new input) |
| Isolate file edits | default on; `"isolation": "off"` per agent to disable |
| Background a running task yourself | `Ctrl+B` in the TUI |
| Ask a side question | `/btw <question>` (or `<leader>j` to open the panel) |
| Follow up in the side chat | type in the panel; `Enter` sends, `esc` returns to main |
| New side chat / full screen | `<leader>k` / `<leader>z` (`<leader>` is `Ctrl+X`) |

## Credits

All core product work belongs upstream: **[opencode by sst](https://github.com/sst/opencode)**
([docs](https://opencode.ai/docs), [Discord](https://discord.gg/opencode)).
This clone's base is [`anomalyco/opencode`](https://github.com/anomalyco/opencode).
This fork only adds the orchestration and side-chat layer above. Bugs in the new
surface (`background`, `monitor`, `notify_parent`, `sleep`, `cron`, worktree
isolation, `/btw` side chat) are ours, not theirs.
