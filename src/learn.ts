import type { LedgerEntry, Outcome, ProviderId, TaskKind, Tier } from './types.ts';

export interface Bucket {
  n: number;
  ok: number;
  tokens: number;
}

const OK: Outcome[] = ['pass', 'unverified'];
/** Outcomes that say something about the model's skill (rate limits and crashes do not). */
const SKILL: Outcome[] = ['pass', 'unverified', 'fail', 'no_changes', 'timeout'];

export class Stats {
  readonly total: number;
  private byKindTier = new Map<string, Bucket>();
  private byProvKindTier = new Map<string, Bucket>();

  constructor(entries: readonly LedgerEntry[]) {
    const rel = entries.filter((e) => SKILL.includes(e.outcome));
    this.total = rel.length;
    for (const e of rel) {
      add(this.byKindTier, `${e.kind}|${e.tier}`, e);
      add(this.byProvKindTier, `${e.provider}|${e.kind}|${e.tier}`, e);
    }
  }

  kindTier(kind: TaskKind, tier: Tier): Bucket | undefined {
    return this.byKindTier.get(`${kind}|${tier}`);
  }

  provKindTier(p: ProviderId, kind: TaskKind, tier: Tier): Bucket | undefined {
    return this.byProvKindTier.get(`${p}|${kind}|${tier}`);
  }
}

function add(m: Map<string, Bucket>, k: string, e: LedgerEntry) {
  const b = m.get(k) ?? { n: 0, ok: 0, tokens: 0 };
  b.n++;
  if (OK.includes(e.outcome)) b.ok++;
  b.tokens += e.input + e.output;
  m.set(k, b);
}

export function rate(b: Bucket | undefined): number | undefined {
  return b && b.n > 0 ? b.ok / b.n : undefined;
}
