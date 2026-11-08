import type { BudgetTracker } from './budget.ts';
import { rate, type Stats } from './learn.ts';
import { at, idx } from './tiering.ts';
import { PROVIDERS, TIERS, type Config, type ModelChoice, type ProviderId, type Task, type Tier, type TierMap } from './types.ts';

export type Route =
  | { kind: 'worker'; provider: ProviderId; tier: Tier; model?: string; effort?: string; overflow: boolean; why: string }
  | { kind: 'lead'; why: string }
  | { kind: 'wait'; why: string }
  | { kind: 'none'; why: string };

export interface RouteOpts {
  busy: ReadonlySet<ProviderId>;
  /** Providers already tried for this task (reassignment). */
  exclude: ReadonlySet<ProviderId>;
  claudeLow: boolean;
  /** Worker runs assigned so far in this run, for keeping the configured share. */
  assigned: Readonly<Partial<Record<ProviderId, number>>>;
}

/** Model for a tier; falls back to the nearest configured tier (up first, then down). */
export function modelFor(map: TierMap | undefined, tier: Tier): ModelChoice {
  if (!map) return {};
  if (map[tier]) return map[tier]!;
  for (let d = 1; d < TIERS.length; d++) {
    const upT = idx(tier) + d < TIERS.length ? map[at(idx(tier) + d)] : undefined;
    if (upT) return upT;
    const dnT = idx(tier) - d >= 0 ? map[at(idx(tier) - d)] : undefined;
    if (dnT) return dnT;
  }
  return {};
}

export class Router {
  private cfg: Config;
  private budget: BudgetTracker;
  private stats: Stats | undefined;

  constructor(cfg: Config, budget: BudgetTracker, stats?: Stats) {
    this.cfg = cfg;
    this.budget = budget;
    this.stats = stats;
  }

  route(task: Task, tier: Tier, o: RouteOpts): Route {
    // Lead tasks stay with Claude in-session unless the Claude plan is running low.
    if (task.lead && !o.claudeLow) return { kind: 'lead', why: 'lead task: Claude does it in-session' };
    if (task.lead || (task.provider === 'claude' && !this.cfg.providers.claude.enabled)) {
      return this.overflow(tier, o, 'claude work overflowed onto the Google quota (agy Claude models)');
    }

    if (task.provider) {
      const p = task.provider;
      if (o.exclude.has(p)) return { kind: 'none', why: `pinned provider ${p} already failed this task` };
      if (!this.budget.canStart(p)) return { kind: 'none', why: `pinned provider ${p} is out of budget or cooling down` };
      if (o.busy.has(p)) return { kind: 'wait', why: `pinned provider ${p} is busy` };
      return this.worker(p, tier, false, 'pinned');
    }

    const cands = PROVIDERS.filter((p) => !o.exclude.has(p) && this.budget.canStart(p));
    if (!cands.length) return { kind: 'none', why: 'no provider has budget left (or all already tried this task)' };
    const free = cands.filter((p) => !o.busy.has(p));
    if (!free.length) return { kind: 'wait', why: 'every provider with budget is busy' };

    const totalW = cands.reduce((s, p) => s + this.cfg.providers[p].weight, 0) || 1;
    const totalA = Object.values(o.assigned).reduce((s, n) => s + (n ?? 0), 0);
    let best: { p: ProviderId; score: number; why: string } | undefined;
    for (const p of free) {
      const pc = this.cfg.providers[p];
      const u = this.budget.usage(p);
      const headroom = Math.max(0.05, 1 - u.fraction);
      const strength = pc.strengths.includes(task.kind) ? 1.5 : 1;
      const learned = rate(this.stats?.provKindTier(p, task.kind, tier));
      const skill = learned !== undefined && (this.stats?.provKindTier(p, task.kind, tier)?.n ?? 0) >= this.cfg.learning.bucketMin ? Math.max(0.2, learned) : 1;
      const share = pc.weight / totalW;
      const actual = totalA ? (o.assigned[p] ?? 0) / totalA : 0;
      const fairness = Math.min(3, Math.max(0.25, 1 + (share - actual) * 2));
      const score = pc.weight * headroom * strength * skill * fairness;
      const why = `w=${pc.weight} headroom=${headroom.toFixed(2)} strength=${strength} skill=${skill.toFixed(2)} fair=${fairness.toFixed(2)}`;
      if (!best || score > best.score) best = { p, score, why };
    }
    return this.worker(best!.p, tier, false, best!.why);
  }

  private overflow(tier: Tier, o: RouteOpts, why: string): Route {
    const p: ProviderId = 'agy';
    const map = this.cfg.providers.agy.overflowTiers;
    if (!map || !Object.keys(map).length) return { kind: 'none', why: 'Claude is low and no agy overflow models are configured (run polyagent doctor)' };
    if (o.exclude.has(p) || !this.budget.canStart(p)) return { kind: 'none', why: 'agy overflow unavailable (budget, cooldown or already tried)' };
    if (o.busy.has(p)) return { kind: 'wait', why: 'agy busy' };
    return this.worker(p, tier, true, why);
  }

  private worker(p: ProviderId, tier: Tier, overflow: boolean, why: string): Route {
    const pc = this.cfg.providers[p];
    const m = modelFor(overflow ? pc.overflowTiers : pc.tiers, tier);
    return { kind: 'worker', provider: p, tier, model: m.model, effort: m.effort, overflow, why };
  }
}
