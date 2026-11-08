# Changelog

## 0.1.0 (unreleased)

- First version: `init`, `doctor`, `plan`, `run`, `status`, `resume`, `merge`, `clean`, `ledger`, `sync-rules`.
- Adapters: Codex CLI, Antigravity `agy`, Gemini CLI, Claude Code (headless, off by default).
- Per-task tiers (XS–XL) with discovered tier→model maps, size/risk heuristics and ledger-based learning.
- Guards: recursion lock, fresh ephemeral sessions, 3-attempt cap, timeouts, budget stop + resume.
- Claude Code plugin: `/poly` skill and `poly-reviewer` subagent.
- Found in real-CLI smoke tests (Windows, codex 0.159, agy 1.5, gemini 0.66):
  - agy `--print` takes the prompt as its value. Headless agy needs a `command(*)` allow-rule (kept inside `--sandbox`).
  - `codex --ignore-user-config` also drops `[windows] sandbox`. Machine-level sandbox keys are now passed through.
  - Gemini CLI refuses personal Google accounts (`IneligibleTierError`). The provider is disabled after one attempt.
  - Tool-permission denials count as setup errors and are not escalated to bigger models.
  - Windows test commands with quotes are passed to `cmd.exe` verbatim.
