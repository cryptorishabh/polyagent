import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BudgetTracker } from '../budget.ts';
import { Ledger, loadLearned, stateDir } from '../ledger.ts';
import { loadState } from '../runner.ts';
import { PROVIDERS, type Config, type ProviderId, type TaskStatus, type Tier } from '../types.ts';

export interface TaskRow {
  id: string;
  status: TaskStatus;
  tier: Tier;
  provider?: ProviderId;
  model?: string;
  effort?: string;
  attempt: number;
  /** ms since the running attempt started, or total time of finished attempts. */
  elapsedMs: number;
  tokens: number;
  /** Worktree folder, relative to the repo. */
  where?: string;
  branch?: string;
  summary?: string;
  history: string[];
}

export interface ProviderRow {
  id: ProviderId;
  enabled: boolean;
  /** 0..1 of the budget window. */
  used: number;
  /** 0..1 of the budget window remaining. */
  left: number;
  windowHours: number;
  windowTokens: number;
  windowTasks: number;
  maxTasks: number;
  maxTokens: number;
  runTokens: number;
  runTasks: number;
  running: number;
  state: 'ok' | 'busy' | 'cooling' | 'disabled' | 'off';
  note?: string;
}

export interface Snapshot {
  at: string;
  repo: string;
  run?: { id: string; startedAt: string; finishedAt?: string; stopped?: string; elapsedMs: number };
  counts: Partial<Record<TaskStatus, number>>;
  tasks: TaskRow[];
  providers: ProviderRow[];
  totals: { runTokens: number; allTimeTokens: number; estimated: boolean };
  runs: string[];
}

export function listRuns(repo: string): string[] {
  const d = join(stateDir(repo), 'runs');
  return existsSync(d) ? readdirSync(d).filter((n) => existsSync(join(d, n, 'state.json'))).sort().reverse() : [];
}

/** Everything a dashboard shows, read from files the runner keeps up to date. */
export function snapshot(repo: string, cfg: Config, runId?: string, now = Date.now()): Snapshot {
  const runs = listRuns(repo);
  const id = runId ?? runs[0];
  const ledger = new Ledger(repo);
  const learned = loadLearned(repo);
  const budget = new BudgetTracker(cfg, ledger, learned, () => now);
  const entries = ledger.all();
  const runEntries = id ? entries.filter((e) => e.run === id) : [];

  let state;
  try {
    state = id ? loadState(repo, id) : undefined;
  } catch {
    state = undefined;
  }

  const tasks: TaskRow[] = state
    ? Object.values(state.tasks).map((ts) => {
        const c = ts.current;
        const last = ts.attempts.at(-1);
        const tokens = runEntries.filter((e) => e.task === ts.id).reduce((s, e) => s + e.input + e.output, 0);
        return {
          id: ts.id,
          status: ts.status,
          tier: c?.tier ?? last?.tier ?? ts.tier,
          provider: c?.provider ?? last?.provider,
          model: c?.model ?? last?.model,
          effort: c?.effort ?? last?.effort,
          attempt: c?.attempt ?? ts.attempts.length,
          elapsedMs: c ? now - Date.parse(c.startedAt) : ts.attempts.reduce((s, a) => s + a.durationMs, 0),
          tokens,
          where: ts.worktree ? relative(repo, ts.worktree).replace(/\\/g, '/') : undefined,
          branch: ts.branch,
          summary: ts.result?.summary,
          history: ts.attempts.map((a) => `${a.provider}:${a.model ?? 'default'}@${a.tier}=${a.outcome}`),
        };
      })
    : [];

  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const providers: ProviderRow[] = PROVIDERS.filter((p) => cfg.providers[p].enabled || runEntries.some((e) => e.provider === p)).map((p) => {
    const u = budget.usage(p);
    const pc = cfg.providers[p];
    const running = tasks.filter((t) => t.status === 'running' && t.provider === p).length;
    const disabled = learned.disabled?.[p];
    const state: ProviderRow['state'] = !pc.enabled ? 'off' : disabled ? 'disabled' : budget.coolingDown(p) ? 'cooling' : running ? 'busy' : 'ok';
    const pe = runEntries.filter((e) => e.provider === p);
    const used = Math.min(1, u.fraction);
    return {
      id: p,
      enabled: pc.enabled,
      used,
      left: Math.max(0, 1 - used),
      windowHours: pc.budget.windowHours,
      windowTokens: u.tokens,
      windowTasks: u.tasks,
      maxTasks: u.maxTasks,
      maxTokens: u.maxTokens,
      runTokens: pe.reduce((s, e) => s + e.input + e.output, 0),
      runTasks: pe.length,
      running,
      state,
      note: disabled ? 'account refused by the provider (details: polyagent doctor)' : state === 'cooling' && u.cooldownUntil ? `until ${new Date(u.cooldownUntil).toLocaleTimeString()}` : undefined,
    };
  });

  return {
    at: new Date(now).toISOString(),
    repo,
    run: state
      ? { id: state.runId, startedAt: state.startedAt, finishedAt: state.finishedAt, stopped: state.stopped, elapsedMs: (state.finishedAt ? Date.parse(state.finishedAt) : now) - Date.parse(state.startedAt) }
      : undefined,
    counts,
    tasks,
    providers,
    totals: {
      runTokens: runEntries.reduce((s, e) => s + e.input + e.output, 0),
      allTimeTokens: entries.reduce((s, e) => s + e.input + e.output, 0),
      estimated: runEntries.some((e) => e.estimated),
    },
    runs,
  };
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
