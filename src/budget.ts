import type { Learned, Ledger } from './ledger.ts';
import type { Config, ProviderId } from './types.ts';

export interface UsageView {
  tokens: number;
  tasks: number;
  maxTokens: number;
  maxTasks: number;
  /** max(tokens/maxTokens, tasks/maxTasks); 0 when unlimited. */
  fraction: number;
  cooldownUntil?: number;
}

export class BudgetTracker {
  private cfg: Config;
  private ledger: Ledger;
  private learned: Learned;
  private now: () => number;
  /** Workers started but not yet in the ledger. Counted so parallel starts cannot overshoot. */
  private inflight = new Map<ProviderId, number>();

  constructor(cfg: Config, ledger: Ledger, learned: Learned, now: () => number = Date.now) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.learned = learned;
    this.now = now;
  }

  usage(p: ProviderId): UsageView {
    const b = this.cfg.providers[p].budget;
    const win = this.ledger.window(p, b.windowHours, this.now());
    const tokens = win.reduce((s, e) => s + e.input + e.output, 0);
    const tasks = win.length + (this.inflight.get(p) ?? 0);
    const ceiling = this.learned.tokenCeiling[p];
    const maxTokens = b.maxTokens > 0 ? (ceiling ? Math.min(b.maxTokens, ceiling) : b.maxTokens) : (ceiling ?? 0);
    const fT = maxTokens > 0 ? tokens / maxTokens : 0;
    const fN = b.maxTasks > 0 ? tasks / b.maxTasks : 0;
    const cd = this.learned.cooldownUntil[p];
    return { tokens, tasks, maxTokens, maxTasks: b.maxTasks, fraction: Math.max(fT, fN), cooldownUntil: cd ? Date.parse(cd) : undefined };
  }

  coolingDown(p: ProviderId): boolean {
    const u = this.usage(p).cooldownUntil;
    return u !== undefined && u > this.now();
  }

  /** May a NEW worker start on p? (Running workers always finish.) */
  canStart(p: ProviderId): boolean {
    const pc = this.cfg.providers[p];
    if (!pc.enabled || pc.weight <= 0) return false;
    if (this.learned.disabled?.[p]) return false;
    if (this.coolingDown(p)) return false;
    const u = this.usage(p);
    // Starting one more must not push us past stopAt.
    const nextTasks = u.maxTasks > 0 ? (u.tasks + 1) / u.maxTasks : 0;
    const tokFrac = u.maxTokens > 0 ? u.tokens / u.maxTokens : 0;
    return Math.max(nextTasks, tokFrac) <= this.cfg.stopAt;
  }

  begin(p: ProviderId): void {
    this.inflight.set(p, (this.inflight.get(p) ?? 0) + 1);
  }

  end(p: ProviderId): void {
    this.inflight.set(p, Math.max(0, (this.inflight.get(p) ?? 0) - 1));
  }

  /** Provider said "limit reached": cool down, and remember how much it took to get here. */
  rateLimited(p: ProviderId, retryAfterMs?: number): void {
    const ms = retryAfterMs ?? this.cfg.cooldownMin * 60_000;
    this.learned.cooldownUntil[p] = new Date(this.now() + ms).toISOString();
    const used = this.usage(p).tokens;
    if (used > 0) {
      const prev = this.learned.tokenCeiling[p];
      this.learned.tokenCeiling[p] = prev ? Math.min(prev, used) : used;
    }
  }

  disable(p: ProviderId, reason: string): void {
    (this.learned.disabled ??= {})[p] = reason;
  }

  learnedState(): Learned {
    return this.learned;
  }
}
