export const TIERS = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type Tier = (typeof TIERS)[number];

export const PROVIDERS = ['codex', 'agy', 'gemini', 'claude'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const TASK_KINDS = ['feature', 'bugfix', 'test', 'refactor', 'docs', 'review', 'research', 'chore'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** One unit of work written by the lead (Claude) into tasks.json. */
export interface Task {
  id: string;
  title: string;
  goal: string;
  kind: TaskKind;
  /** Lead's tier estimate. */
  tier: Tier;
  /** One line: why this tier (complexity, risk, ambiguity). */
  tierReason?: string;
  /** Files (or globs/dirs) in scope. Empty = worker decides, but tier heuristics treat it as unknown. */
  files: string[];
  acceptance: string[];
  /** Overrides the tasks-file / config test command. */
  test?: string;
  dependsOn?: string[];
  /** e.g. auth, security, migration, concurrency, payments. */
  risk?: string[];
  /** Pin to one provider. */
  provider?: ProviderId;
  /** Lead (Claude, in-session) does this task itself. */
  lead?: boolean;
}

export interface TasksFile {
  version: 1;
  /** Git ref the run starts from. Defaults to HEAD. */
  base?: string;
  /** Default test command for every task. */
  test?: string;
  /** Run in each fresh worktree before the worker starts (e.g. "npm ci"). */
  setup?: string;
  tasks: Task[];
}

export interface ModelChoice {
  model?: string;
  effort?: string;
}

export type TierMap = Partial<Record<Tier, ModelChoice>>;

export interface Budget {
  /** Rolling window length in hours. */
  windowHours: number;
  /** Max tokens (input+output) per window. 0 = unlimited. */
  maxTokens: number;
  /** Max worker runs per window. 0 = unlimited. */
  maxTasks: number;
}

export interface ProviderConfig {
  enabled: boolean;
  /** Executable name or absolute path. */
  binary?: string;
  /** Relative share of work. */
  weight: number;
  strengths: TaskKind[];
  budget: Budget;
  tiers: TierMap;
  /** agy only: models used when Claude work overflows onto the Google quota. */
  overflowTiers?: TierMap;
  /** Extra CLI args appended to every invocation. */
  extraArgs?: string[];
}

export interface Config {
  version: 1;
  /** Max workers at once (never more than one per provider). */
  concurrency: number;
  taskTimeoutMin: number;
  testTimeoutMin: number;
  /** Stop starting work on a provider at this fraction of its budget. */
  stopAt: number;
  /** Cooldown after a rate-limit when the CLI gives no retry hint. */
  cooldownMin: number;
  taskCardMaxChars: number;
  test?: string;
  setup?: string;
  providers: Record<ProviderId, ProviderConfig>;
  learning: { enabled: boolean; minSamples: number; bucketMin: number };
}

export interface WorkerResult {
  status: 'done' | 'partial' | 'blocked';
  summary: string;
  files_changed: string[];
  tests_run: string;
  notes: string;
}

export interface Usage {
  input: number;
  output: number;
  estimated: boolean;
}

export type Outcome = 'pass' | 'unverified' | 'fail' | 'no_changes' | 'error' | 'timeout' | 'rate_limited';

export interface LedgerEntry {
  ts: string;
  run: string;
  task: string;
  attempt: number;
  provider: ProviderId;
  model?: string;
  effort?: string;
  tier: Tier;
  kind: TaskKind;
  input: number;
  output: number;
  estimated: boolean;
  durationMs: number;
  outcome: Outcome;
}

export type TaskStatus = 'pending' | 'running' | 'passed' | 'unverified' | 'failed' | 'blocked' | 'lead' | 'stopped' | 'merged';

export interface AttemptRecord {
  attempt: number;
  provider: ProviderId;
  model?: string;
  effort?: string;
  tier: Tier;
  outcome: Outcome;
  durationMs: number;
  input: number;
  output: number;
  note?: string;
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  /** Tier after heuristics/learning, before escalation. */
  tier: Tier;
  tierNotes: string[];
  attempts: AttemptRecord[];
  branch?: string;
  worktree?: string;
  result?: WorkerResult;
  diffstat?: string;
  outOfScope?: string[];
  testTail?: string;
  lastProvider?: ProviderId;
}

export interface RunState {
  runId: string;
  repo: string;
  base: string;
  baseBranch?: string;
  tasksFile: string;
  startedAt: string;
  finishedAt?: string;
  stopped?: string;
  claudeLow: boolean;
  tasks: Record<string, TaskState>;
}
