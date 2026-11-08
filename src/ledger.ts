import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LedgerEntry, ProviderId } from './types.ts';

export const STATE_DIR = '.polyagent';

export function stateDir(repo: string): string {
  return join(repo, STATE_DIR);
}

export class Ledger {
  readonly file: string;
  private entries: LedgerEntry[];

  constructor(repo: string) {
    this.file = join(stateDir(repo), 'ledger.jsonl');
    this.entries = [];
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.entries.push(JSON.parse(line));
        } catch {
          // A torn last line after a crash is skipped, not fatal.
        }
      }
    }
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  add(e: LedgerEntry): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(e) + '\n');
    this.entries.push(e);
  }

  /** Entries for a provider within the last `hours`. */
  window(provider: ProviderId, hours: number, now = Date.now()): LedgerEntry[] {
    const since = now - hours * 3600_000;
    return this.entries.filter((e) => e.provider === provider && Date.parse(e.ts) >= since);
  }
}

/** Learned limits and cooldowns: things the providers told us, persisted across runs. */
export interface Learned {
  cooldownUntil: Partial<Record<ProviderId, string>>;
  /** Token ceiling observed at the moment a provider rate-limited us. */
  tokenCeiling: Partial<Record<ProviderId, number>>;
  /** Provider refused the account (e.g. tier no longer supported). Cleared by `polyagent doctor --reset`. */
  disabled?: Partial<Record<ProviderId, string>>;
}

export function loadLearned(repo: string): Learned {
  const f = join(stateDir(repo), 'learned.json');
  if (existsSync(f)) {
    try {
      return { cooldownUntil: {}, tokenCeiling: {}, disabled: {}, ...JSON.parse(readFileSync(f, 'utf8')) };
    } catch {
      /* fall through */
    }
  }
  return { cooldownUntil: {}, tokenCeiling: {}, disabled: {} };
}

export function saveLearned(repo: string, l: Learned): void {
  mkdirSync(stateDir(repo), { recursive: true });
  writeFileSync(join(stateDir(repo), 'learned.json'), JSON.stringify(l, null, 2) + '\n');
}
