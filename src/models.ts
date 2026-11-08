import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sh } from './proc.ts';
import type { ModelChoice, Tier, TierMap } from './types.ts';

export interface Discovered {
  id: string;
  /** Effort levels the model accepts as a parameter (Codex style). */
  efforts?: string[];
}

export const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/i;

// Matched against whole name tokens ("gemini" must not match "mini").
const SMALL = /^(flash|mini|nano|lite|haiku|luna|small|spark|tiny)$/i;
const MID = /^(terra|sonnet|plus|standard)$/i;
const BIG = /^(argon|pro|opus|sol|ultra|large|max)$/i;

export const stripEffort = (id: string) => id.replace(EFFORT_SUFFIX, '');
export const effortInId = (id: string) => id.match(EFFORT_SUFFIX)?.[1]?.toLowerCase();

/** 0 small, 1 mid, 2 big. Name hints only; doctor prints the result so users can correct it in config. */
export function sizeOf(id: string): 0 | 1 | 2 {
  const toks = stripEffort(id).split(/[-_.\s/]+/);
  if (toks.some((t) => SMALL.test(t))) return 0;
  if (toks.some((t) => BIG.test(t))) return 2;
  return 1;
}

export function versionOf(id: string): number {
  const m = stripEffort(id).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

const TARGET: Record<Tier, { size: 0 | 1 | 2; effort: string }> = {
  XS: { size: 0, effort: 'low' },
  S: { size: 0, effort: 'medium' },
  M: { size: 1, effort: 'medium' },
  L: { size: 2, effort: 'high' },
  XL: { size: 2, effort: 'xhigh' },
};

function nearestEffort(target: string, have: string[]): string | undefined {
  if (!have.length) return undefined;
  const ti = EFFORT_LADDER.indexOf(target);
  return [...have].sort((a, b) => Math.abs(EFFORT_LADDER.indexOf(a) - ti) - Math.abs(EFFORT_LADDER.indexOf(b) - ti) || EFFORT_LADDER.indexOf(a) - EFFORT_LADDER.indexOf(b))[0];
}

/**
 * Picks, for each tier, the newest model of the right size and the nearest effort.
 * Handles both styles: effort as a separate parameter (Codex) and effort baked into the id (agy: "...-high").
 */
export function buildTierMap(models: Discovered[]): TierMap {
  if (!models.length) return {};
  const families = new Map<string, { base: string; size: 0 | 1 | 2; ver: number; variants: Map<string, string>; efforts: string[] }>();
  for (const m of models) {
    const base = stripEffort(m.id);
    const f = families.get(base) ?? { base, size: sizeOf(m.id), ver: versionOf(m.id), variants: new Map(), efforts: [] };
    const e = effortInId(m.id);
    if (e) f.variants.set(e, m.id);
    else f.variants.set('', m.id);
    if (m.efforts) f.efforts = m.efforts.map((x) => x.toLowerCase());
    families.set(base, f);
  }
  const fams = [...families.values()];
  const order: Record<0 | 1 | 2, (0 | 1 | 2)[]> = { 0: [0, 1, 2], 1: [1, 2, 0], 2: [2, 1, 0] };
  const out: TierMap = {};
  for (const tier of Object.keys(TARGET) as Tier[]) {
    const t = TARGET[tier];
    let fam;
    for (const s of order[t.size]) {
      const c = fams.filter((f) => f.size === s).sort((a, b) => b.ver - a.ver);
      if (c.length) {
        fam = c[0];
        break;
      }
    }
    if (!fam) continue;
    const choice: ModelChoice = {};
    const baked = [...fam.variants.keys()].filter(Boolean);
    if (baked.length) {
      choice.model = fam.variants.get(nearestEffort(t.effort, baked)!)!;
    } else {
      choice.model = fam.variants.get('') ?? fam.base;
      const e = nearestEffort(t.effort, fam.efforts);
      if (e) choice.effort = e;
    }
    out[tier] = choice;
  }
  return out;
}

/** `agy models` prints "id<TAB>Display name" per line. */
export function parseAgyModels(text: string): Discovered[] {
  return text
    .split('\n')
    .map((l) => l.trim().split(/\t+|\s{2,}/)[0]!)
    .filter((id) => /^[a-z0-9][a-z0-9.\-]+$/i.test(id) && /\d/.test(id) && !/^fetching/i.test(id))
    .map((id) => ({ id }));
}

export function discoverAgy(bin: string, cwd: string): Discovered[] {
  const r = sh(bin, ['models'], cwd);
  return r.code === 0 ? parseAgyModels(r.out) : [];
}

/** Codex keeps the model list the server sent in $CODEX_HOME/models_cache.json. */
export function discoverCodex(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): Discovered[] {
  const f = join(codexHome, 'models_cache.json');
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return (j.models ?? [])
      .filter((m: any) => m.visibility !== 'hide' && typeof m.slug === 'string' && !/review/i.test(m.slug))
      .map((m: any) => ({ id: m.slug, efforts: (m.supported_reasoning_levels ?? []).map((e: any) => e.effort).filter(Boolean) }));
  } catch {
    return [];
  }
}

/** Splits agy's catalogue: Gemini models for normal work, Claude models for overflow only. */
export function splitAgy(models: Discovered[]): { main: Discovered[]; claude: Discovered[] } {
  return {
    main: models.filter((m) => /^gemini/i.test(m.id)),
    claude: models.filter((m) => /^claude/i.test(m.id)),
  };
}
