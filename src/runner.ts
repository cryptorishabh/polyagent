import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ADAPTERS, type Adapter } from './adapters/index.ts';
import { BudgetTracker } from './budget.ts';
import { BLOCK_EXIT, ensureShims, workerEnv } from './guard.ts';
import { Stats } from './learn.ts';
import { Ledger, loadLearned, saveLearned, stateDir } from './ledger.ts';
import { resolveBinary, run } from './proc.ts';
import { clip, estimateUsage } from './result.ts';
import { Router, type Route } from './router.ts';
import { buildCard } from './taskcard.ts';
import { topoOrder } from './tasks.ts';
import { decideTier, scopeLines, up } from './tiering.ts';
import type { AttemptRecord, Config, Outcome, ProviderId, RunState, Task, TasksFile, TaskState, Tier } from './types.ts';
import { runShell } from './verify.ts';
import { branchName, changedSince, commitAll, createWorktree, diffStat, excludeStateDir, git, GitError } from './worktree.ts';

/** 1 first try + 1 escalated retry + 1 reassignment. Never more. */
export const MAX_ATTEMPTS = 3;
const NO_CHANGE_OK = new Set(['review', 'research']);

export interface RunnerOpts {
  claudeLow?: boolean;
  concurrency?: number;
  adapters?: Record<ProviderId, Adapter>;
  /** Override binaries (tests point these at fake CLIs). */
  binaries?: Partial<Record<ProviderId, string>>;
  log?: (s: string) => void;
  now?: () => number;
}

export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

export const runDir = (repo: string, runId: string) => join(stateDir(repo), 'runs', runId);

export function loadState(repo: string, runId: string): RunState {
  const f = join(runDir(repo, runId), 'state.json');
  if (!existsSync(f)) throw new Error(`no run ${runId} (looked in ${f})`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function latestRunId(repo: string): string | undefined {
  const d = join(stateDir(repo), 'runs');
  if (!existsSync(d)) return undefined;
  return readdirSync(d).sort().at(-1);
}

/** Glob-ish scope match: exact path, directory prefix, or * / ** patterns. */
export function inScope(file: string, scope: string[]): boolean {
  const f = file.replace(/\\/g, '/');
  return scope.some((s0) => {
    const s = s0.replace(/\\/g, '/').replace(/^\.\//, '');
    if (f === s) return true;
    if (s.endsWith('/') ? f.startsWith(s) : f.startsWith(s + '/')) return true;
    if (/[*?]/.test(s)) {
      const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$');
      return re.test(f);
    }
    return false;
  });
}

export class Runner {
  readonly repo: string;
  readonly cfg: Config;
  readonly tf: TasksFile;
  readonly state: RunState;
  private ledger: Ledger;
  private budget: BudgetTracker;
  private router: Router;
  private stats: Stats;
  private adapters: Record<ProviderId, Adapter>;
  private bins = new Map<ProviderId, string | undefined>();
  private shimDir: string;
  private log: (s: string) => void;
  private busy = new Set<ProviderId>();
  private assigned: Partial<Record<ProviderId, number>> = {};
  private stopping = false;
  private byId: Map<string, Task>;
  private opts: RunnerOpts;
  /** Per task: providers to skip on the next attempt, whether we already escalated, last failure text, current tier. */
  private retry = new Map<string, { exclude: Set<ProviderId>; escalated: boolean; failure?: string; tier: Tier }>();

  constructor(repo: string, cfg: Config, tf: TasksFile, state: RunState, opts: RunnerOpts = {}) {
    this.repo = repo;
    this.cfg = cfg;
    this.tf = tf;
    this.state = state;
    this.opts = opts;
    this.log = opts.log ?? ((s) => process.stderr.write(s + '\n'));
    this.ledger = new Ledger(repo);
    this.budget = new BudgetTracker(cfg, this.ledger, loadLearned(repo), opts.now);
    this.stats = new Stats(this.ledger.all());
    this.router = new Router(cfg, this.budget, this.stats);
    this.adapters = opts.adapters ?? ADAPTERS;
    this.shimDir = ensureShims(repo);
    // A CLI that isn't installed is never picked, so it can't use up a task's attempts.
    for (const p of Object.keys(cfg.providers) as ProviderId[]) {
      if (cfg.providers[p].enabled && !this.bin(p)) {
        this.budget.markMissing(p);
        this.log(`[setup] ${p}: ${this.adapters[p].binary} is not installed, so it is skipped this run (its share goes to the others). Add it with: polyagent install ${p}`);
      }
    }
    this.byId = new Map(tf.tasks.map((t) => [t.id, t]));
    for (const ts of Object.values(state.tasks)) {
      const prior = ts.attempts.at(-1);
      this.retry.set(ts.id, { exclude: new Set(), escalated: ts.attempts.some((a) => a.tier !== ts.tier), tier: prior?.tier ?? ts.tier });
    }
  }

  /** Creates the run state: tiers decided up front so `plan` and `run` agree. */
  static create(repo: string, cfg: Config, tf: TasksFile, tasksFile: string, opts: RunnerOpts = {}): Runner {
    excludeStateDir(repo);
    const runId = newRunId();
    const base = git(repo, 'rev-parse', tf.base ?? 'HEAD');
    let baseBranch: string | undefined;
    try {
      baseBranch = git(repo, 'symbolic-ref', '--short', 'HEAD');
    } catch {
      /* detached */
    }
    const stats = new Stats(new Ledger(repo).all());
    const tasks: Record<string, TaskState> = {};
    for (const t of topoOrder(tf.tasks)) {
      const d = decideTier(t, cfg, stats, scopeLines(repo, t.files));
      tasks[t.id] = { id: t.id, status: 'pending', tier: d.tier, tierNotes: d.notes, attempts: [] };
    }
    const state: RunState = { runId, repo, base, baseBranch, tasksFile: resolve(tasksFile), startedAt: new Date().toISOString(), claudeLow: !!opts.claudeLow, tasks };
    mkdirSync(runDir(repo, runId), { recursive: true });
    writeFileSync(join(runDir(repo, runId), 'tasks.json'), JSON.stringify(tf, null, 2));
    const r = new Runner(repo, cfg, tf, state, opts);
    r.save();
    return r;
  }

  save(): void {
    const d = runDir(this.repo, this.state.runId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'state.json'), JSON.stringify(this.state, null, 2));
  }

  private bin(p: ProviderId): string | undefined {
    if (!this.bins.has(p)) {
      const name = this.opts.binaries?.[p] ?? this.cfg.providers[p].binary ?? this.adapters[p].binary;
      this.bins.set(p, resolveBinary(name, { skipDirs: [this.shimDir] }));
    }
    return this.bins.get(p);
  }

  private depsState(t: Task): 'ready' | 'waiting' | 'blocked' {
    for (const d of t.dependsOn ?? []) {
      const s = this.state.tasks[d]!.status;
      if (s === 'failed' || s === 'blocked' || s === 'stopped') return 'blocked';
      if (s === 'lead') return 'blocked';
      if (s !== 'passed' && s !== 'unverified' && s !== 'merged') return 'waiting';
    }
    return 'ready';
  }

  /** Plans routing without running anything (dry run). */
  preview(): { id: string; tier: Tier; tierNotes: string[]; route: Route }[] {
    const assigned: Partial<Record<ProviderId, number>> = {};
    return topoOrder(this.tf.tasks).map((t) => {
      const ts = this.state.tasks[t.id]!;
      const route = this.router.route(t, ts.tier, { busy: new Set(), exclude: new Set(), claudeLow: this.state.claudeLow, assigned });
      if (route.kind === 'worker') assigned[route.provider] = (assigned[route.provider] ?? 0) + 1;
      return { id: t.id, tier: ts.tier, tierNotes: ts.tierNotes, route };
    });
  }

  async run(): Promise<RunState> {
    // A crash mid-attempt leaves "running"; such tasks start over.
    for (const ts of Object.values(this.state.tasks)) if (ts.status === 'running' || ts.status === 'stopped') ts.status = 'pending';
    delete this.state.stopped;
    const conc = Math.min(this.opts.concurrency ?? this.cfg.concurrency, 4);
    const running = new Map<string, Promise<void>>();
    const order = topoOrder(this.tf.tasks);

    for (;;) {
      let launched = false;
      for (const t of order) {
        if (this.stopping || running.size >= conc) break;
        const ts = this.state.tasks[t.id]!;
        if (ts.status !== 'pending' || running.has(t.id)) continue;
        const ds = this.depsState(t);
        if (ds === 'blocked') {
          ts.status = 'blocked';
          ts.result = { status: 'blocked', summary: 'A dependency failed, was stopped or is a lead task not yet done.', files_changed: [], tests_run: 'none', notes: '' };
          this.save();
          continue;
        }
        if (ds === 'waiting') continue;
        const r = this.retry.get(t.id)!;
        const route = this.router.route(t, r.tier, { busy: this.busy, exclude: r.exclude, claudeLow: this.state.claudeLow, assigned: this.assigned });
        if (route.kind === 'lead') {
          ts.status = 'lead';
          this.log(`[${t.id}] lead task: left for Claude`);
          this.save();
          continue;
        }
        if (route.kind === 'wait') continue;
        if (route.kind === 'none') {
          if (/budget/.test(route.why) && !t.provider) {
            this.stopping = true;
            this.state.stopped = `budget: ${route.why}`;
            this.log(`[stop] ${route.why}. Running tasks will finish; nothing new starts.`);
            break;
          }
          ts.status = r.exclude.size ? 'failed' : 'stopped';
          ts.result ??= { status: 'blocked', summary: route.why, files_changed: [], tests_run: 'none', notes: '' };
          this.log(`[${t.id}] ${ts.status}: ${route.why}`);
          this.save();
          continue;
        }
        const p = this.attempt(t, route).finally(() => running.delete(t.id));
        running.set(t.id, p);
        launched = true;
      }
      if (!running.size) {
        if (!launched) break;
        continue;
      }
      await Promise.race(running.values());
    }

    for (const ts of Object.values(this.state.tasks)) if (ts.status === 'pending') ts.status = 'stopped';
    this.state.finishedAt = new Date().toISOString();
    saveLearned(this.repo, this.budget.learnedState());
    this.save();
    if (this.state.stopped) {
      writeFileSync(join(runDir(this.repo, this.state.runId), 'resume.json'), JSON.stringify({ runId: this.state.runId, reason: this.state.stopped, command: `polyagent resume ${this.state.runId}` }, null, 2));
    }
    return this.state;
  }

  private async attempt(t: Task, route: Extract<Route, { kind: 'worker' }>): Promise<void> {
    const ts = this.state.tasks[t.id]!;
    const r = this.retry.get(t.id)!;
    const p = route.provider;
    const n = ts.attempts.length + 1;
    const adapter = this.adapters[p];
    ts.status = 'running';
    ts.current = { attempt: n, provider: p, model: route.model, effort: route.effort, tier: route.tier, startedAt: new Date().toISOString(), overflow: route.overflow || undefined };
    ts.lastProvider = p;
    this.busy.add(p);
    this.budget.begin(p);
    this.assigned[p] = (this.assigned[p] ?? 0) + 1;
    this.log(`[${t.id}] attempt ${n} -> ${p} ${route.model ?? '(default model)'}${route.effort ? ' effort=' + route.effort : ''} tier ${route.tier}${route.overflow ? ' (overflow)' : ''}`);
    this.save();

    const rd = runDir(this.repo, this.state.runId);
    const dir = join(stateDir(this.repo), 'wt', this.state.runId, t.id);
    const branch = branchName(this.state.runId, t.id);
    const logFile = join(rd, `${t.id}.${n}.log`);
    const lastMsg = join(rd, `${t.id}.${n}.last.txt`);
    const started = Date.now();
    let outcome: Outcome = 'error';
    let note: string | undefined;
    let usage = { input: 0, output: 0, estimated: true };

    try {
      const bin = this.bin(p);
      if (!bin) throw new Error(`${adapter.binary} not found on PATH (run polyagent doctor)`);
      const deps = (t.dependsOn ?? []).map((d) => branchName(this.state.runId, d));
      createWorktree(this.repo, dir, branch, this.state.base, deps);
      const startHead = git(dir, 'rev-parse', 'HEAD');
      ts.branch = branch;
      ts.worktree = dir;
      const setup = this.tf.setup ?? this.cfg.setup;
      if (setup) {
        const s = await runShell(setup, dir, this.cfg.testTimeoutMin * 60_000, logFile);
        if (!s.ok) throw new Error(`setup command failed: ${clip(s.tail, 400)}`);
      }
      const test = t.test ?? this.tf.test ?? this.cfg.test;
      const card = buildCard({ task: t, tier: route.tier, test, previousFailure: r.failure, maxChars: this.cfg.taskCardMaxChars });
      writeFileSync(join(rd, `${t.id}.${n}.card.md`), card);
      const built = adapter.build({ cwd: dir, card, model: route.model, effort: route.effort, timeoutMs: this.cfg.taskTimeoutMin * 60_000, lastMessageFile: lastMsg, extraArgs: this.cfg.providers[p].extraArgs ?? [] });
      const raw = await run({ cmd: bin, args: built.args, cwd: dir, env: workerEnv(this.shimDir), stdin: built.stdin, timeoutMs: this.cfg.taskTimeoutMin * 60_000, logFile });
      const parsed = adapter.parse({ ...raw, lastMessageFile: lastMsg });
      usage = parsed.usage ? { ...parsed.usage, estimated: false } : estimateUsage(card.length, raw.stdout.length);
      const delegated = raw.code === BLOCK_EXIT || /nested agent calls are blocked/.test(raw.stdout + raw.stderr);

      commitAll(dir, `polyagent(${t.id}): ${clip(t.title, 60)}`, `polyagent ${p}/${route.model ?? 'default'}`);
      const changed = changedSince(dir, startHead);
      ts.result = parsed.result;

      if (parsed.fatal && !changed.length) {
        outcome = 'error';
        note = `provider refused this account, disabled until \`polyagent doctor --reset\`: ${parsed.fatal}`;
        this.budget.disable(p, parsed.fatal);
        saveLearned(this.repo, this.budget.learnedState());
      } else if (raw.timedOut) {
        outcome = 'timeout';
        note = `timed out after ${this.cfg.taskTimeoutMin} min`;
      } else if (parsed.rateLimited) {
        outcome = 'rate_limited';
        note = clip(parsed.error ?? 'rate limited', 300);
        this.budget.rateLimited(p, parsed.retryAfterMs);
        saveLearned(this.repo, this.budget.learnedState());
      } else if (!changed.length && parsed.permissionDenied) {
        // The sandbox or headless approvals stopped it: a bigger model would hit the same wall.
        outcome = 'error';
        note = `tool permission denied in headless mode (setup issue, not escalated): ${parsed.permissionDenied}`;
      } else if (!changed.length) {
        if (NO_CHANGE_OK.has(t.kind) && parsed.result) outcome = 'unverified';
        else {
          outcome = raw.code !== 0 && !parsed.result ? 'error' : 'no_changes';
          note = parsed.error ? clip(parsed.error, 300) : 'worker made no changes';
        }
      } else if (test) {
        const v = await runShell(test, dir, this.cfg.testTimeoutMin * 60_000, logFile);
        outcome = v.ok ? 'pass' : 'fail';
        ts.testTail = v.ok ? undefined : clip(v.tail, 1500);
        if (!v.ok) note = v.timedOut ? 'tests timed out' : 'tests failed';
      } else {
        outcome = 'unverified';
        note = 'no test command configured';
      }
      if (delegated) note = `${note ? note + '; ' : ''}worker tried to call another agent (blocked)`;
      if (changed.length) {
        ts.diffstat = diffStat(dir, this.state.base);
        ts.outOfScope = t.files.length ? changed.filter((f) => !inScope(f, t.files)) : [];
        if (ts.result) ts.result.files_changed = changed.slice(0, 60);
      }
    } catch (e) {
      outcome = 'error';
      note = clip((e as Error).message, 400);
      if (e instanceof GitError && /conflicts/.test(note)) r.exclude = new Set(['codex', 'agy', 'gemini', 'claude']);
    } finally {
      this.busy.delete(p);
      delete ts.current;
      this.budget.end(p);
    }

    const durationMs = Date.now() - started;
    const rec: AttemptRecord = { attempt: n, provider: p, model: route.model, effort: route.effort, tier: route.tier, outcome, durationMs, input: usage.input, output: usage.output, note };
    ts.attempts.push(rec);
    this.ledger.add({ ts: new Date().toISOString(), run: this.state.runId, task: t.id, attempt: n, provider: p, model: route.model, effort: route.effort, tier: route.tier, kind: t.kind, input: usage.input, output: usage.output, estimated: usage.estimated, durationMs, outcome });
    this.log(`[${t.id}] attempt ${n} ${outcome}${note ? ': ' + note : ''}`);

    if (outcome === 'pass' || outcome === 'unverified') {
      ts.status = outcome === 'pass' ? 'passed' : 'unverified';
    } else if (n >= MAX_ATTEMPTS || r.exclude.size >= 4) {
      ts.status = 'failed';
    } else {
      r.failure = ts.testTail ?? note;
      if (outcome === 'rate_limited' || outcome === 'error') {
        // Not the model's fault: same tier, different provider.
        r.exclude.add(p);
      } else if (!r.escalated && r.tier !== 'XL') {
        r.escalated = true;
        r.tier = up(r.tier);
      } else {
        r.exclude.add(p);
      }
      ts.status = 'pending';
    }
    this.save();
  }
}

/** Compact report for the lead. Everything bounded; full logs stay on disk. */
export function summarize(repo: string, state: RunState, cfg: Config) {
  const ledger = new Ledger(repo);
  const budget = new BudgetTracker(cfg, ledger, loadLearned(repo));
  const usage: Record<string, unknown> = {};
  for (const p of ['codex', 'agy', 'gemini', 'claude'] as ProviderId[]) {
    if (!cfg.providers[p].enabled && p !== 'agy') continue;
    const u = budget.usage(p);
    const disabled = loadLearned(repo).disabled?.[p];
    usage[p] = { used: `${Math.round(u.fraction * 100)}%`, tasks: u.tasks, tokens: u.tokens, coolingDown: budget.coolingDown(p) || undefined, disabled: disabled ? clip(disabled, 160) : undefined };
  }
  return {
    run: state.runId,
    base: state.base.slice(0, 10),
    stopped: state.stopped,
    tasks: Object.values(state.tasks).map((ts) => ({
      id: ts.id,
      status: ts.status,
      tier: ts.tier,
      tierNotes: ts.tierNotes.length ? ts.tierNotes : undefined,
      attempts: ts.attempts.map((a) => `${a.provider}:${a.model ?? 'default'}@${a.tier}=${a.outcome}`),
      branch: ts.branch,
      summary: ts.result?.summary,
      notes: ts.result?.notes || undefined,
      files: ts.result?.files_changed,
      outOfScope: ts.outOfScope?.length ? ts.outOfScope : undefined,
      diffstat: ts.diffstat,
      testTail: ts.status === 'failed' ? ts.testTail : undefined,
    })),
    budget: usage,
  };
}

export function cleanRun(repo: string, state: RunState, force: boolean): string[] {
  const removed: string[] = [];
  for (const ts of Object.values(state.tasks)) {
    if (ts.worktree && existsSync(ts.worktree)) {
      try {
        git(repo, 'worktree', 'remove', '--force', ts.worktree);
      } catch {
        rmSync(ts.worktree, { recursive: true, force: true });
      }
      removed.push(ts.worktree);
    }
    if (ts.branch && (force || ts.status === 'merged')) {
      try {
        git(repo, 'branch', '-D', ts.branch);
        removed.push(ts.branch);
      } catch {
        /* gone */
      }
    }
  }
  try {
    git(repo, 'worktree', 'prune');
  } catch {
    /* ignore */
  }
  return removed;
}
