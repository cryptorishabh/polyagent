# polyagent

**Use your Claude, ChatGPT (Codex) and Google AI (Antigravity / Gemini CLI) subscriptions together on one project.** Claude plans, reviews and merges. Codex and Antigravity do the heavy work in parallel. Hard guards stop the waste that usually comes with multi-agent setups.

```
            you ──► Claude (lead, /poly)
                     │  writes tasks.json, reviews summaries, merges
                     ▼
               polyagent run ──► budget · tier→model · recursion lock · timeouts
           ┌─────────┼──────────┬────────────┐
           ▼         ▼          ▼            ▼
        codex      agy       gemini     (claude -p, optional)
      worktree   worktree   worktree
           └──── tests run by polyagent, not by an LLM ────┘
```

## Why

Letting one agent hand work to another usually goes wrong in the same ways:

| What burns your quota | What polyagent does |
|---|---|
| Agents delegating to agents, recursively | Workers get a PATH shim that blocks every agent CLI (`codex`, `agy`, `gemini`, `claude`, …) plus a depth marker. polyagent itself refuses to run inside a worker. |
| One huge thread re-sent every turn; forks that inherit it | Every attempt is a fresh, ephemeral session that starts from a task card of at most 8 KB. No resume, no fork. |
| Top model at max effort for a typo | Each task gets a tier (XS–XL) that picks the model and effort per provider. Flash/mini models do small work, and big models are saved for hard work. |
| Retry loops | At most 3 attempts per task: try, retry one tier up, then reassign to another provider. Then it stops. |
| The lead reading megabytes of logs | Workers must return a small JSON result. The lead reads a bounded summary; logs stay on disk. |
| Running until every plan is empty | A per-provider budget ledger. At 85% of a budget, running work finishes, nothing new starts, and `resume` continues later. |

## Install

Requirements: Node ≥ 22.6, git, and whichever CLIs you subscribe to, each signed in once:

| Provider | CLI | Sign in |
|---|---|---|
| ChatGPT Plus/Pro | [Codex CLI](https://developers.openai.com/codex) | `codex login` |
| Google AI Pro/Ultra | Antigravity CLI `agy` | `agy` (follow the prompt) |
| Google AI (fallback) | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `GEMINI_API_KEY`, or a workspace/paid tier* |
| Claude | [Claude Code](https://claude.com/claude-code) | the lead, in your session |

\* Google has ended Gemini CLI sign-in for personal Google accounts ("no longer supported for Gemini Code Assist for individuals"). On a personal Google AI plan, use `agy`. If polyagent sees that refusal, it disables Gemini CLI after one attempt and sends the work elsewhere; `polyagent doctor --reset` re-enables it.

```bash
npm i -g polyagent
```

Then add the `/poly` skill to Claude Code:

```bash
claude plugin marketplace add cryptorishabh/polyagent
```

```bash
claude plugin install polyagent@polyagent
```

## Quick start

```bash
cd your-project
polyagent init
polyagent doctor --refresh
```

`doctor` checks every CLI and its sign-in, reads which models each one offers, and writes a tier→model map into `polyagent.config.json`. Example:

```
✔ codex   enabled  codex-cli 0.159.1
    tiers:  XS=gpt-6-luna/low  S=gpt-6-luna/medium  M=gpt-6.1-terra/medium  L=gpt-6.1-sol/high  XL=gpt-6.1-sol/xhigh
✔ agy     enabled  1.4.12
    tiers:  XS=gemini-3.8-flash-low  S=gemini-3.8-flash-medium  M=gemini-4-argon-medium  L=gemini-4-argon-high  XL=gemini-4-argon-high
    overflow (Claude on Google quota): S=claude-sonnet-5-5-medium  L=claude-opus-5-5-high …
```

Then, in Claude Code:

```
/poly add input validation to every API handler, with tests for each
```

Claude writes a task graph. `polyagent plan` shows the routing without calling a model. After you confirm, `polyagent run` executes it, and Claude reviews and merges.

## Model selection

| Tier | Typical work | Codex | agy | Claude (lead's subagents) |
|---|---|---|---|---|
| XS | rename, lint, docstring | small model, low effort | Flash low | haiku |
| S | one function / bug / test file | small model, medium | Flash medium | haiku |
| M | feature in 2–5 files | mid model, medium | Argon medium | sonnet |
| L | cross-module refactor, subtle bug | top model, high | Argon high | opus |
| XL | architecture, security | top model, xhigh | Argon high | opus (lead) |

The tier is decided in three layers:
1. **The lead's estimate.** Claude sets a tier with a reason.
2. **A cheap heuristic.** File count, lines in scope and risk tags can move it one step up or down. L/XL are never moved down.
3. **Learning.** After 20+ runs, the ledger's pass rates shift thresholds. If XS keeps passing for a kind of task, similar S work drops to XS; if M keeps failing, it goes to L.

Models are discovered rather than hard-coded, so new releases need no code change. Override any entry in `polyagent.config.json`.

## Commands

```
polyagent init                       create config, exclude .polyagent/ from git
polyagent doctor [--refresh]         check CLIs, discover models, write tier maps
polyagent plan <tasks.json>          dry run: tiers, providers, models (no model calls)
polyagent run <tasks.json>           run; prints a compact JSON summary
         [--claude-low]              send lead work to Claude models via agy
polyagent status|resume|merge|clean [runId]
polyagent ledger                     usage and pass rate per provider/model/tier
polyagent sync-rules                 copy CLAUDE.md to AGENTS.md and GEMINI.md
```

Exit codes: `0` ok, `2` some tasks failed, `3` stopped on budget (`polyagent resume` continues).

## Configuration

`polyagent.config.json` (every field is optional and merged over the defaults):

```jsonc
{
  "version": 1,
  "concurrency": 3,          // never more than one worker per provider
  "taskTimeoutMin": 15,
  "stopAt": 0.85,            // stop starting work at 85% of a provider's budget
  "test": "npm test",        // default verification command
  "setup": "npm ci",         // run in each fresh worktree
  "providers": {
    "codex":  { "weight": 4, "budget": { "windowHours": 5, "maxTasks": 25, "maxTokens": 0 }, "tiers": { "XS": { "model": "…", "effort": "low" } } },
    "agy":    { "weight": 4, "tiers": { … }, "overflowTiers": { … } },
    "gemini": { "weight": 1 },
    "claude": { "enabled": false }   // headless Claude worker; the lead is Claude anyway
  }
}
```

Subscriptions don't publish token limits, so budgets start as task counts. The first time a provider says "usage limit", polyagent records a cooldown (using the CLI's "try again in …" hint when there is one) and learns a token ceiling.

## Safety

- Workers run with each CLI's sandbox and auto-edit mode, inside a separate git worktree on a `polyagent/<run>/<task>` branch. Your branch changes only on `polyagent merge`.
- Codex runs with `--ignore-user-config`, so personal defaults such as maximum reasoning effort or priority service tiers don't silently multiply usage.
- See [SECURITY.md](SECURITY.md) for limits: a worker that calls an agent by absolute path is not stopped by the PATH shim.

## Terms of service

polyagent only drives each vendor's **official CLI** with **your own** signed-in account, exactly as you would by hand. Don't use it to share accounts, resell access, or get around a provider's limits.

## License

MIT
