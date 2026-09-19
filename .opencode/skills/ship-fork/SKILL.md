---
name: ship-fork
description: Ship changes in the opencode-extended fork: verify, rebuild the binary, rotate it live, commit, and push
---

# Ship the fork

This repo is `opencode-extended` (branch `better`), an opinionated opencode fork.
`origin` is someone else's fork; `better` pushes to `KapilSareen/opencode-extended`.
`claude-code-src/` (one level up, outside git) is read-only reference: never commit it.

## 1. Verify code changes

```bash
# from packages/opencode (never run package tests from the repo root)
bun typecheck
# if packages/core was touched:
bun typecheck # from packages/core
# if packages/tui was touched:
bun run typecheck # from packages/tui
```

Run affected suites from `packages/opencode`:

```bash
bun test test/tool/task.test.ts test/tool/background.test.ts test/tool/monitor.test.ts \
  test/tool/sleep.test.ts test/tool/cron.test.ts test/tool/registry.test.ts \
  test/session/prompt.test.ts test/session/session.test.ts
```

Test-layer gotchas (all learned the hard way):

- Tools that yield `Session`/`BackgroundJob`/etc. need those nodes in the test layer.
  Do NOT add `InstanceStore.node` to `ToolRegistry` deps or any test layer that
  feeds a TUI/loop test: its transitive `Project.node` graph hangs
  `prompt.test.ts` "loop includes MCP instructions" in teardown. Prefer the
  lightweight ambient override
  (`Effect.provideService(InstanceRef, {...ctx, directory, worktree})`) over
  `InstanceStore.provide` for same-project directory switches.
- If a layer error says `Unbound layer node: @opencode/InstanceBootstrap`, add
  `[InstanceBootstrap.node, Layer.succeed(...of({ run: Effect.void }))]` to that
  test's `LayerNode.compile` replacements (see `test/session/session.test.ts`).
- `it.effect` = TestClock, `it.instance`/`it.live` = real clock. Never `Effect.sleep`
  to sync with forked fibers; use Deferreds, `pollWithTimeout`, `jobs.wait`, `llm.wait`.
- `tmpdir({ git: true })` gives a real repo for worktree tests.
- `git rev-parse` needs `--show-toplevel` (bare `--toplevel` echoes literally).

Effect v4 beta gotchas: `Effect.yieldNow` is a value (no call parens), no
`Effect.zipRight` (use `Effect.andThen`), `catchCause` (no `catchAllCause`),
`ChildProcessSpawner` tag comes from `effect/unstable/process/ChildProcessSpawner`
(submodule import, `yield*` directly), `ChildProcess.make("git", args, opts)` array
form, `Effect.timeoutOption("3 seconds")` string durations. CrossSpawnSpawner's node
provides the spawner tag; `Monitor.node`-style deps need `CrossSpawnSpawner.node`.

Backend facts that constrain design:

- `completeToolCall` REPLACES part metadata with result metadata (only failures
  merge running metadata). `ctx.metadata` updates merge. Truncation preserves metadata.
- `ensureRunning` while busy just joins; it never queues follow-up work. Any
  "wake a busy session" design must handle the idle/busy race explicitly.
- Tool `execute` must be `R = never`; new services used at call time need registry
  node deps, which can pull heavy graphs (see InstanceStore warning above).
- Killing `sh -c` orphans grandchildren holding stdout open: spawn `detached` and
  group-kill (`process.kill(-pid)`) on teardown.
- Completed TUI tool blocks unmount when details are hidden unless they carry a
  diff (`shouldHide`); Thought headers use `theme.text`.

## 2. Rebuild the binary and rotate it live

```bash
# from packages/opencode
bun run script/build.ts --single --skip-install
./dist/opencode-linux-x64/bin/opencode --version   # smoke (script does this too)
```

The user's `opencode` resolves to `~/.local/bin/opencode`, a wrapper execing that
`dist` binary with `OPENCODE_DB` pinned to the shared DB (fork builds use a
version-derived DB filename otherwise) plus
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`. Rebuilding swaps the binary
under running processes: **old tabs keep running deleted-inode binaries**.
After shipping user-visible changes, tell the user to relaunch TUI tabs
(`ps` showing `(deleted)` = stale). Never kill their sessions unprompted.

Smoke after rebuild: `opencode --version` shows the new build tag, then one live
`opencode run "reply with exactly: <token>"`.

## 3. Commit and push

Conventions: conventional commits (`feat(scope): ...`), branch names ≤ 3 words,
no slashes. Never commit secrets, `dist/`, or `claude-code-src/`.

```bash
git add <intended files only>   # inspect git status first
git commit -m "feat(scope): summary"
git push better better          # pre-push hook runs full turbo typecheck (slow)
```

After an upstream rebase: `git push --force-with-lease better better`.
Upstream is `anomalyco/opencode` (`sst/opencode` redirects there). Check drift with
`git rev-list --count <base>..upstream/dev` after `git fetch upstream dev`.

## 4. GitHub issues

Draft in chat FIRST, never file directly. Distinguish the repos: `sst/opencode`
redirects to `anomalyco/opencode` (owner moved). Our issue lives at
`anomalyco/opencode#49842`; the duplicate `#49840` stays closed. No em dashes
in issue text (user preference).

## 5. User environment facts (do not break these)

- `opencode` = fork wrapper (shared DB/auth/config with old upstream paths).
  System binary intact at `/usr/local/bin/opencode`.
- Shared global config must name a working default model
  (`opencode-go/deepseek-v4.1-flash`); the fork's embedded default differs and its
  stored OpenAI key is invalid.
- Fork auth: `~/.opencode-fork/data/opencode/auth.json` symlinks to main's
  `auth.json` (only used if XDG isolation returns; currently vestigial).
- Failing `test/tool/write.test.ts` file-permission test is environmental
  (fails on clean baseline too).
