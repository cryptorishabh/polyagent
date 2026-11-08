import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS } from './adapters/index.ts';
import { RECIPES } from './install.ts';
import { buildTierMap, discoverAgy, discoverCodex, splitAgy } from './models.ts';
import { resolveBinary, sh } from './proc.ts';
import { PROVIDERS, type Config, type ProviderId, type TierMap } from './types.ts';

export interface ProviderReport {
  id: ProviderId;
  enabled: boolean;
  binary?: string;
  version?: string;
  auth: 'ok' | 'missing' | 'unknown';
  authHint?: string;
  models: string[];
  tiers: TierMap;
  overflowTiers?: TierMap;
  problems: string[];
}

function authCheck(id: ProviderId, bin: string, cwd: string): { auth: ProviderReport['auth']; hint?: string } {
  if (id === 'codex') {
    const r = sh(bin, ['login', 'status'], cwd);
    const txt = `${r.out} ${r.err}`;
    if (r.code === 0 && !/not logged in/i.test(txt)) return { auth: 'ok', hint: txt.split('\n')[0] };
    return { auth: 'missing', hint: 'run: codex login' };
  }
  if (id === 'gemini') {
    const home = join(homedir(), '.gemini');
    if (existsSync(join(home, 'oauth_creds.json')) || process.env.GEMINI_API_KEY) return { auth: 'ok' };
    return { auth: existsSync(join(home, 'settings.json')) ? 'unknown' : 'missing', hint: 'run gemini once interactively and sign in with Google' };
  }
  if (id === 'claude') return { auth: 'unknown', hint: 'Claude leads in-session; headless worker is optional' };
  return { auth: 'unknown' };
}

/**
 * Checks each CLI and discovers its models. With `refresh`, writes the tier→model maps into cfg
 * (user-edited entries are kept unless refresh is "force").
 */
export function doctor(cfg: Config, cwd: string, refresh: false | 'fill' | 'force'): ProviderReport[] {
  const out: ProviderReport[] = [];
  for (const id of PROVIDERS) {
    const pc = cfg.providers[id];
    const a = ADAPTERS[id];
    const rep: ProviderReport = { id, enabled: pc.enabled, auth: 'unknown', models: [], tiers: pc.tiers, overflowTiers: pc.overflowTiers, problems: [] };
    const bin = resolveBinary(pc.binary ?? a.binary);
    if (!bin) {
      const opt = RECIPES[id].options(process.platform)[0];
      rep.problems.push(`${a.binary} not installed. Install: polyagent install ${id}${opt ? ` (runs: ${opt.display})` : ''}. Until then it is skipped.`);
      out.push(rep);
      continue;
    }
    rep.binary = bin;
    const v = sh(bin, a.versionArgs, cwd);
    rep.version = (v.out || v.err).split('\n')[0];
    if (v.code !== 0) rep.problems.push(`version check failed: ${v.err.slice(0, 200)}`);
    const au = authCheck(id, bin, cwd);
    rep.auth = au.auth;
    rep.authHint = au.hint;

    let tiers: TierMap = {};
    let overflow: TierMap | undefined;
    if (id === 'codex') {
      const ms = discoverCodex();
      rep.models = ms.map((m) => m.id);
      tiers = buildTierMap(ms);
      // Keep the effort ladder even when models are unknown.
    } else if (id === 'agy') {
      const all = discoverAgy(bin, cwd);
      rep.models = all.map((m) => m.id);
      if (!all.length) rep.problems.push('agy models returned nothing (signed in?)');
      else rep.auth = 'ok';
      const { main, claude } = splitAgy(all);
      tiers = buildTierMap(main);
      overflow = buildTierMap(claude);
    } else if (id === 'claude') {
      tiers = pc.tiers;
    }

    if (refresh) {
      const merge = (cur: TierMap | undefined, found: TierMap): TierMap => {
        if (refresh === 'force' || !cur) return { ...found };
        const m: TierMap = { ...found };
        for (const [k, v] of Object.entries(cur)) if (v?.model) (m as any)[k] = v;
        for (const [k, v] of Object.entries(m)) if (v && !v.effort && (cur as any)[k]?.effort) v.effort = (cur as any)[k].effort;
        return m;
      };
      if (Object.keys(tiers).length) pc.tiers = merge(pc.tiers, tiers);
      if (overflow && Object.keys(overflow).length) pc.overflowTiers = merge(pc.overflowTiers, overflow);
    }
    rep.tiers = pc.tiers;
    rep.overflowTiers = pc.overflowTiers;
    out.push(rep);
  }
  return out;
}

export function formatDoctor(reps: ProviderReport[]): string {
  const lines: string[] = [];
  for (const r of reps) {
    const ok = r.binary && !r.problems.length && r.auth !== 'missing';
    lines.push(`${ok ? '✔' : r.enabled ? '✖' : '·'} ${r.id.padEnd(7)} ${r.enabled ? 'enabled ' : 'disabled'} ${r.version ?? ''}`);
    if (r.binary) lines.push(`    binary: ${r.binary}`);
    lines.push(`    auth:   ${r.auth}${r.authHint ? ` (${r.authHint})` : ''}`);
    if (r.models.length) lines.push(`    models: ${r.models.join(', ')}`);
    const fmt = (m?: TierMap) => (m ? Object.entries(m).map(([t, c]) => `${t}=${c?.model ?? 'default'}${c?.effort ? '/' + c.effort : ''}`).join('  ') : '');
    if (r.tiers && Object.keys(r.tiers).length) lines.push(`    tiers:  ${fmt(r.tiers)}`);
    if (r.overflowTiers && Object.keys(r.overflowTiers).length) lines.push(`    overflow (Claude on Google quota): ${fmt(r.overflowTiers)}`);
    for (const p of r.problems) lines.push(`    problem: ${p}`);
  }
  return lines.join('\n');
}
