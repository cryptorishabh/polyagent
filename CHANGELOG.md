# Changelog

## 0.1.0 (unreleased)

- First version: `init`, `doctor`, `plan`, `run`, `status`, `resume`, `merge`, `clean`, `ledger`, `sync-rules`.
- Adapters: Codex CLI, Antigravity `agy`, Gemini CLI, Claude Code (headless, off by default).
- Per-task tiers (XS–XL) with discovered tier→model maps, size/risk heuristics and ledger-based learning.
- Guards: recursion lock, fresh ephemeral sessions, 3-attempt cap, timeouts, budget stop + resume.
- Claude Code plugin: `/poly` skill and `poly-reviewer` subagent.
- `polyagent install`: offers each missing CLI's official installer (npm, winget, or Google's install script), asks before each one, and skips what can't be installed. `init` and `/poly` offer it too.
- `polyagent dashboard`: live terminal view, or `--web` for a local read-only page (127.0.0.1 only, no external assets). It shows running tasks with tool, model, folder and elapsed time, per-tool budget bars and tokens, and the result of every task.
- A CLI that isn't installed is never routed to, so it can't use up a task's attempts.
- Found in real-CLI smoke tests (Windows, codex 0.159, agy 1.5, gemini 0.66):
  - agy `--print` takes the prompt as its value. Headless agy needs a `command(*)` allow-rule (kept inside `--sandbox`).
  - `codex --ignore-user-config` also drops `[windows] sandbox`. Machine-level sandbox keys are now passed through.
  - Gemini CLI refuses personal Google accounts (`IneligibleTierError`). The provider is disabled after one attempt.
  - Tool-permission denials count as setup errors and are not escalated to bigger models.
  - Windows test commands with quotes are passed to `cmd.exe` verbatim.
