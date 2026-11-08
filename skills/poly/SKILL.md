---
name: poly
description: Split a coding request into tasks and delegate them in parallel to Codex, Antigravity (agy) and Gemini CLI through polyagent, with Claude planning, reviewing and merging. Use when the user asks to /poly, to "use all my subscriptions", to delegate or parallelise work across Codex/Antigravity/Gemini, or to add many tests or features at once.
---

# /poly — lead a polyagent run

You are the **lead**. Codex and Antigravity do most of the token-heavy work. You plan, route, review and merge. Your own plan may be the smallest of the three, so keep your context lean: read summaries, not logs.

## Hard rules
- Never call `codex`, `agy`, `gemini` or another agent CLI directly. Only `polyagent` (or `npx polyagent`) starts workers, because it enforces budgets, timeouts, model tiers and the recursion lock.
- Never resume, fork or continue a worker session. Every attempt starts fresh from a small task card.
- Never paste whole worker logs into the conversation. If you must debug, read the last ~40 lines of `.polyagent/runs/<run>/<task>.<n>.log`.
- Don't merge anything the user has not seen summarised. Merge only branches whose tests passed (or that are marked `unverified` and that you have reviewed).

## 0. Preflight (once per project)
1. `polyagent --version`. If missing: `npm i -g polyagent` (or use `npx polyagent`).
2. `polyagent install --dry-run` lists which worker CLIs (codex, agy, gemini) are missing and the official command for each. If any are missing, ask the user which to install. Name each one, show its command, and pass on the note about Gemini CLI and personal Google accounts. Then run `polyagent install <ids> --yes` for exactly the ones they chose. Never install one they didn't pick. A CLI that can't be installed, or that they decline, is skipped; polyagent routes its work to the others.
3. If there is no `polyagent.config.json`: `polyagent init`, then `polyagent doctor --refresh`. Show the user the tier→model table it prints and ask whether any model looks wrong for its tier. Any choice can be edited in the config.
4. If the project has `CLAUDE.md` but no `AGENTS.md` / `GEMINI.md`: offer `polyagent sync-rules` so all three tools follow the same rules.

## 1. Plan the task graph
Read only what you need to split the work well (structure, the files involved, how tests run). Then write `.polyagent/tasks/<short-name>.json`:

```json
{
  "version": 1,
  "test": "npm test",
  "setup": "npm ci",
  "tasks": [
    {
      "id": "parse-dates",
      "title": "Parse ISO dates in report.py",
      "goal": "What to build or fix, the constraints, and any API the worker must keep. Self-contained: the worker sees nothing else.",
      "kind": "feature",
      "tier": "S",
      "tierReason": "one function, existing tests nearby",
      "files": ["report.py", "tests/test_report.py"],
      "acceptance": ["parse_date handles Z and +01:00 offsets", "new tests cover both"],
      "test": "pytest tests/test_report.py -q",
      "dependsOn": [],
      "risk": []
    }
  ]
}
```

How to split:
- **Parallel by default.** Tasks that can run at once must not touch the same files. If two tasks need one file, chain them with `dependsOn`.
- **Small tasks.** One coherent change per task, about 1–5 files. Big features become several tasks plus one integration task.
- **Tests are tasks too.** For each feature, either put tests in its acceptance criteria or add a separate `kind: "test"` task that depends on it. Extra test-hardening tasks are cheap on Flash and mini models, so use them generously.
- **Tier honestly** (it picks the model). Never inflate:
  - `XS`: rename, typo, lint, docstring, config value.
  - `S`: one function or bug, one test file.
  - `M`: feature across 2–5 files, a module's test suite.
  - `L`: cross-module refactor, subtle bug, concurrency, performance.
  - `XL`: architecture or security-sensitive changes. Usually yours (`"lead": true`).
- Use `risk` tags (`auth`, `security`, `migration`, `concurrency`, `payments`, `data-loss`, `infra`). polyagent bumps risky work one tier.
- Mark `"lead": true` on work only you should do: architecture decisions, ambiguous product calls, anything needing this conversation's context.
- `provider` pins a task to one CLI. Use it only when the user asks, or when one tool is clearly better (for example, agy for reading a huge codebase).

## 2. Dry run, then confirm
Run `polyagent plan .polyagent/tasks/<name>.json`. It calls no model. Show the user a short table: task, tier, provider, model. Ask before running if there are more than 6 tasks or any L/XL worker task. Otherwise go ahead.

## 3. Run
`polyagent run .polyagent/tasks/<name>.json`. Use the background mode of your shell tool for long runs. It prints one compact JSON summary to stdout. Exit codes: `0` all good, `2` some failed or blocked, `3` stopped on budget.
- If your Claude usage is running low, add `--claude-low`. Lead tasks then go to Claude models on the Google quota through agy.
- On exit `3`, tell the user which providers are out and that `polyagent resume <run>` will continue later. Nothing is lost.

## 4. Review (cheaply)
For each task in the summary:
- `passed` with no `outOfScope` and tier XS–M: summary + diffstat are enough.
- `outOfScope`, any `risk`, tier L/XL or `unverified`: review the diff. For large diffs, hand the review to the `poly-reviewer` subagent (it runs on a cheaper model) with `git diff <base>...<branch>`.
- `failed`: read `testTail`. Then fix it yourself (small), write a sharper follow-up task (unclear goal), or report it to the user.
- `lead`: do these yourself now. For mechanical pieces, use subagents with a model matching the tier (haiku for XS/S, sonnet for M, opus only for L/XL).

## 5. Merge and finish
1. Show the user what will be merged. Then run `polyagent merge <run>`, or `--tasks a,b` to merge only some.
2. Run the project's full test command on the merged result.
3. `polyagent clean <run>` removes the worktrees and merged branches.
4. Report: tasks done per provider, anything failed or left, and `polyagent ledger` if the user asks about usage.
