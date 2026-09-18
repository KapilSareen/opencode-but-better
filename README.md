> **opencode-but-better** — an opinionated fork of opencode on the [`better`](https://github.com/KapilSareen/opencode-but-better/tree/better) branch: non-blocking background subagents, persistent monitors, cron scheduling, keep-alive sleep, worktree isolation, bidirectional parent↔child messaging, ESC-drains-queue, and persistent diffs. [Install this fork](#installing-opencode-but-better) · [What's different](#whats-different-in-this-fork)

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Installing opencode-but-better (this fork)

No package managers ship the fork — build it from source (takes a few minutes, embeds the web UI):

```bash
git clone -b better https://github.com/KapilSareen/opencode-but-better.git
cd opencode-but-better
bun install
bun run --cwd packages/opencode script/build.ts --single --skip-install
# binary lands at packages/opencode/dist/<platform>-<arch>/bin/opencode
```

Run it side-by-side with upstream `opencode` under an isolated profile (separate
config, sessions, cache — shared API keys), e.g. as `~/.local/bin/opencode-fork`:

```sh
#!/bin/sh
export XDG_DATA_HOME="$HOME/.opencode-fork/data"
export XDG_STATE_HOME="$HOME/.opencode-fork/state"
export XDG_CACHE_HOME="$HOME/.opencode-fork/cache"
export XDG_CONFIG_HOME="$HOME/.opencode-fork/config"
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
exec /path/to/opencode-but-better/packages/opencode/dist/opencode-linux-x64/bin/opencode "$@"
```

Then point the fork at your existing keys and a working default model:

```bash
mkdir -p ~/.opencode-fork/data/opencode
ln -sf ~/.local/share/opencode/auth.json ~/.opencode-fork/data/opencode/auth.json
opencode-fork auth login   # only if the link above doesn't cover your provider
```

Notes:

- Project-local `.opencode/` directories are shared with upstream by design;
  global config, sessions/DB, cache, and state are split.
- If you serve both at once, give them different ports (`serve --port ...`).

### What's different in this fork

- **Non-blocking background subagents** — parents stay interactive; completion
  notices inject mid-drain without breaking state or caches.
- **`background` tool** — `status` (spend, tokens, recent activity), `send`,
  `kill`, `list`, `tail`, `detach` (model-callable Ctrl+B), by `task_id` or `name`.
- **`monitor` tool + service** — watch a process, stream matching lines into a
  session; process-group kill so orphans can't hang it.
- **`notify_parent`** — running children can push milestones to their parent.
- **`sleep`** — keep-alive wait with early wake on new input. **`cron`** —
  scheduled messages into sessions (in-memory).
- **Worktree isolation (default on)** — subagents work in detached git
  worktrees, auto-removed when clean; `"isolation": "off"` opts out.
- **ESC drains queued input** instead of stranding it.
- **Completed diffs stay visible** in the TUI when tool details are hidden.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
