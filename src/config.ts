import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS, TASK_KINDS, TIERS, type Config, type ProviderConfig, type ProviderId } from './types.ts';

export const CONFIG_FILE = 'polyagent.config.json';

/**
 * Defaults are deliberately conservative. Subscriptions do not publish token limits, so budgets start
 * as task counts and polyagent learns a token ceiling the first time a provider reports a rate limit.
 */
export function defaultConfig(): Config {
  const effortLadder = { XS: { effort: 'low' }, S: { effort: 'low' }, M: { effort: 'medium' }, L: { effort: 'high' }, XL: { effort: 'xhigh' } };
  return {
    version: 1,
    concurrency: 3,
    taskTimeoutMin: 15,
    testTimeoutMin: 10,
    stopAt: 0.85,
    cooldownMin: 60,
    taskCardMaxChars: 8000,
    providers: {
      codex: {
        enabled: true,
        weight: 4,
        strengths: ['feature', 'bugfix', 'test'],
        budget: { windowHours: 5, maxTokens: 0, maxTasks: 25 },
        tiers: structuredClone(effortLadder),
      },
      agy: {
        enabled: true,
        weight: 4,
        strengths: ['refactor', 'test', 'docs', 'research'],
        budget: { windowHours: 5, maxTokens: 0, maxTasks: 25 },
        tiers: {},
        overflowTiers: {},
      },
      gemini: {
        enabled: true,
        weight: 1,
        strengths: ['docs', 'research', 'review'],
        budget: { windowHours: 24, maxTokens: 0, maxTasks: 40 },
        tiers: {},
      },
      claude: {
        // Claude leads in-session. As a headless worker it is off by default to protect small plans.
        enabled: false,
        weight: 1,
        strengths: ['review', 'refactor'],
        budget: { windowHours: 5, maxTokens: 0, maxTasks: 8 },
        tiers: { XS: { model: 'haiku' }, S: { model: 'haiku' }, M: { model: 'sonnet' }, L: { model: 'opus' }, XL: { model: 'opus' } },
      },
    },
    learning: { enabled: true, minSamples: 20, bucketMin: 5 },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  if (c.version !== 1) errs.push('version must be 1');
  if (!(c.concurrency >= 1 && c.concurrency <= 4)) errs.push('concurrency must be 1..4');
  if (!(c.stopAt > 0 && c.stopAt <= 1)) errs.push('stopAt must be in (0,1]');
  if (!(c.taskTimeoutMin > 0)) errs.push('taskTimeoutMin must be > 0');
  if (!(c.taskCardMaxChars >= 1000)) errs.push('taskCardMaxChars must be >= 1000');
  for (const id of Object.keys(c.providers)) {
    if (!PROVIDERS.includes(id as ProviderId)) errs.push(`unknown provider "${id}"`);
  }
  for (const id of PROVIDERS) {
    const p: ProviderConfig | undefined = c.providers[id];
    if (!p) { errs.push(`provider ${id} missing`); continue; }
    if (!(p.weight >= 0)) errs.push(`${id}.weight must be >= 0`);
    for (const s of p.strengths) if (!TASK_KINDS.includes(s)) errs.push(`${id}.strengths: unknown kind "${s}"`);
    for (const t of Object.keys(p.tiers)) if (!TIERS.includes(t as never)) errs.push(`${id}.tiers: unknown tier "${t}"`);
    if (!(p.budget.windowHours > 0)) errs.push(`${id}.budget.windowHours must be > 0`);
  }
  return errs;
}

export function loadConfig(repo: string): Config {
  const file = join(repo, CONFIG_FILE);
  let cfg = defaultConfig();
  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${CONFIG_FILE}: invalid JSON (${(e as Error).message})`);
    }
    cfg = deepMerge(cfg, raw);
  }
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error(`${CONFIG_FILE}: ${errs.join('; ')}`);
  return cfg;
}

export function saveConfig(repo: string, cfg: Config): void {
  writeFileSync(join(repo, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n');
}
