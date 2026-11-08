import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rate, type Stats } from './learn.ts';
import { TIERS, type Config, type Task, type Tier } from './types.ts';

export const HIGH_RISK = ['auth', 'security', 'migration', 'concurrency', 'payments', 'crypto', 'data-loss', 'infra'];

export const idx = (t: Tier) => TIERS.indexOf(t);
export const at = (i: number): Tier => TIERS[Math.max(0, Math.min(TIERS.length - 1, i))]!;
export const up = (t: Tier) => at(idx(t) + 1);

export interface TierDecision {
  tier: Tier;
  notes: string[];
}

/** Counts lines of the in-scope files that exist (directories and globs are skipped). Cheap, no LLM. */
export function scopeLines(repo: string, files: string[]): number {
  let n = 0;
  for (const f of files) {
    if (/[*?]/.test(f)) continue;
    const p = join(repo, f);
    try {
      if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > 2_000_000) continue;
      n += readFileSync(p, 'utf8').split('\n').length;
    } catch {
      /* unreadable: ignore */
    }
  }
  return n;
}

/** Tier implied by the size of the work alone. */
export function heuristicTier(task: Task, lines: number): Tier {
  const f = task.files.length;
  const globs = task.files.some((x) => /[*?]/.test(x) || x.endsWith('/'));
  let i = f <= 1 ? 0 : f === 2 ? 1 : f <= 5 ? 2 : f <= 10 ? 3 : 4;
  if (globs) i = Math.max(i, 2);
  if (lines > 3000) i += 2;
  else if (lines > 800) i += 1;
  if (task.kind === 'docs' || task.kind === 'chore') i -= 1;
  if (task.kind === 'refactor') i += 1;
  return at(i);
}

/**
 * Final tier = the lead's estimate, moved at most one step by (a) the size/risk heuristic and
 * (b) what the ledger has learned. L/XL are never moved down. Every move is explained in notes.
 */
export function decideTier(task: Task, cfg: Config, stats: Stats | undefined, lines: number): TierDecision {
  const lead = task.tier;
  const notes: string[] = [];
  let i = idx(lead);
  const protectedHigh = idx(lead) >= idx('L');

  const risky = (task.risk ?? []).filter((r) => HIGH_RISK.includes(r.toLowerCase()));
  if (risky.length && i < idx('L')) {
    i += 1;
    notes.push(`+1 for risk (${risky.join(', ')})`);
  } else if (task.files.length > 0) {
    const h = heuristicTier(task, lines);
    const gap = idx(h) - idx(lead);
    if (gap >= 2) {
      i += 1;
      notes.push(`+1: scope looks like ${h} (${task.files.length} files, ~${lines} lines)`);
    } else if (gap <= -2 && !protectedHigh) {
      i -= 1;
      notes.push(`-1: scope looks like ${h} (${task.files.length} files, ~${lines} lines)`);
    }
  }

  const L = cfg.learning;
  if (L.enabled && stats && stats.total >= L.minSamples) {
    const cur = at(i);
    const here = stats.kindTier(task.kind, cur);
    const below = idx(cur) > 0 ? stats.kindTier(task.kind, at(idx(cur) - 1)) : undefined;
    const rHere = rate(here);
    const rBelow = rate(below);
    if (here && here.n >= L.bucketMin && rHere !== undefined && rHere < 0.5 && i < idx('XL')) {
      i += 1;
      notes.push(`+1 learned: ${task.kind}@${cur} passes only ${(rHere * 100).toFixed(0)}% of ${here.n}`);
    } else if (!protectedHigh && idx(cur) <= idx('M') && below && below.n >= L.bucketMin && rBelow !== undefined && rBelow >= 0.9) {
      i -= 1;
      notes.push(`-1 learned: ${task.kind}@${at(idx(cur) - 1)} passes ${(rBelow * 100).toFixed(0)}% of ${below.n}`);
    }
  }

  // Never move more than one step from the lead's estimate, never below it for L/XL.
  i = Math.max(idx(lead) - 1, Math.min(idx(lead) + 1, i));
  if (protectedHigh) i = Math.max(i, idx(lead));
  return { tier: at(i), notes };
}
