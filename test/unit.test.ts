import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADAPTERS, CODEX_PASSTHROUGH, readTomlKeys } from '../src/adapters/index.ts';
import { BudgetTracker } from '../src/budget.ts';
import { validateConfig } from '../src/config.ts';
import { assertTopLevel, workerEnv } from '../src/guard.ts';
import { Stats } from '../src/learn.ts';
import { Ledger } from '../src/ledger.ts';
import { buildTierMap, parseAgyModels, sizeOf, splitAgy } from '../src/models.ts';
import { cmdQuote } from '../src/proc.ts';
import { extractResult, isRateLimited, retryAfterMs } from '../src/result.ts';
import { modelFor, Router } from '../src/router.ts';
import { inScope } from '../src/runner.ts';
import { buildCard } from '../src/taskcard.ts';
import { findCycle, validateTasks } from '../src/tasks.ts';
import { decideTier, heuristicTier } from '../src/tiering.ts';
import type { LedgerEntry, Tier } from '../src/types.ts';
import { task, testConfig, tmp } from './helpers.ts';

const AGY_MODELS = `Fetching available models...
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)
claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)
claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;

const entry = (o: Partial<LedgerEntry>): LedgerEntry => ({ ts: new Date().toISOString(), run: 'r', task: 't', attempt: 1, provider: 'codex', tier: 'S', kind: 'feature', input: 10, output: 5, estimated: false, durationMs: 1, outcome: 'pass', ...o });

describe('tasks', () => {
  it('accepts a valid file and rejects duplicates, unknown deps and cycles', () => {
    assert.deepEqual(validateTasks({ version: 1, tasks: [task('a'), task('b', { dependsOn: ['a'] })] }), []);
    assert.match(validateTasks({ version: 1, tasks: [task('a'), task('a')] }).join(), /duplicate/);
    assert.match(validateTasks({ version: 1, tasks: [task('a', { dependsOn: ['zz'] })] }).join(), /unknown task/);
    assert.deepEqual(findCycle([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })]), ['a', 'b', 'a']);
    assert.match(validateTasks({ version: 1, tasks: [task('A_bad')] }).join(), /id must match/);
  });
});

describe('tiering', () => {
  const cfg = testConfig();
  it('bumps risky work one tier, never more', () => {
    const d = decideTier(task('a', { tier: 'S', risk: ['auth'] }), cfg, undefined, 10);
    assert.equal(d.tier, 'M');
    assert.match(d.notes[0]!, /risk/);
  });
  it('moves at most one step toward the size heuristic', () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    assert.equal(heuristicTier(task('a', { files: many }), 0), 'XL');
    assert.equal(decideTier(task('a', { tier: 'XS', files: many }), cfg, undefined, 0).tier, 'S');
  });
  it('never downgrades L or XL', () => {
    assert.equal(decideTier(task('a', { tier: 'XL', files: ['README.md'], kind: 'docs' }), cfg, undefined, 5).tier, 'XL');
    assert.equal(decideTier(task('a', { tier: 'L', files: ['a.txt'] }), cfg, undefined, 5).tier, 'L');
  });
  it('learns: cheap tier keeps passing -> similar work moves down; failing tier -> up', () => {
    const passXS = Array.from({ length: 20 }, () => entry({ tier: 'XS', outcome: 'pass' }));
    const s1 = new Stats(passXS);
    const d1 = decideTier(task('a', { tier: 'S', files: ['a.ts', 'b.ts'] }), cfg, s1, 10);
    assert.equal(d1.tier, 'XS');
    assert.match(d1.notes.join(), /learned/);
    const failM = Array.from({ length: 20 }, () => entry({ tier: 'M', outcome: 'fail' }));
    const d2 = decideTier(task('a', { tier: 'M', files: ['a', 'b', 'c'] }), cfg, new Stats(failM), 10);
    assert.equal(d2.tier, 'L');
  });
  it('ignores learning below minSamples', () => {
    const few = Array.from({ length: 5 }, () => entry({ tier: 'XS', outcome: 'pass' }));
    assert.equal(decideTier(task('a', { tier: 'S', files: ['a', 'b'] }), cfg, new Stats(few), 10).tier, 'S');
  });
});

describe('model discovery', () => {
  it('maps agy models to tiers: Flash for small work, Argon for big, effort from the id', () => {
    const { main, claude } = splitAgy(parseAgyModels(AGY_MODELS));
    assert.equal(main.length, 6);
    const m = buildTierMap(main);
    assert.equal(m.XS!.model, 'gemini-3.8-flash-low');
    assert.equal(m.S!.model, 'gemini-3.8-flash-medium');
    assert.equal(m.M!.model, 'gemini-4-argon-medium');
    assert.equal(m.L!.model, 'gemini-4-argon-high');
    assert.equal(m.XL!.model, 'gemini-4-argon-high');
    const o = buildTierMap(claude);
    assert.equal(o.M!.model, 'claude-sonnet-5-5-medium');
    assert.equal(o.L!.model, 'claude-opus-5-5-high');
  });
  it('maps codex-style models with a separate effort parameter, newest first', () => {
    const levels = ['low', 'medium', 'high', 'xhigh'];
    const m = buildTierMap([
      { id: 'gpt-6.1-sol', efforts: levels },
      { id: 'gpt-6.1-terra', efforts: levels },
      { id: 'gpt-6-luna', efforts: levels },
      { id: 'gpt-5.6-luna', efforts: levels },
    ]);
    assert.deepEqual(m.XS, { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(m.M, { model: 'gpt-6.1-terra', effort: 'medium' });
    assert.deepEqual(m.XL, { model: 'gpt-6.1-sol', effort: 'xhigh' });
  });
  it('size hints ignore effort suffixes', () => {
    assert.equal(sizeOf('gemini-4-argon-max'), 2);
    assert.equal(sizeOf('gemini-3.8-flash-high'), 0);
  });
});

describe('router', () => {
  const mk = (over = (_: any) => {}) => {
    const cfg = testConfig(over);
    const ledger = new Ledger(tmp());
    const b = new BudgetTracker(cfg, ledger, { cooldownUntil: {}, tokenCeiling: {} });
    return { cfg, ledger, b, r: new Router(cfg, b) };
  };
  const o = (extra = {}) => ({ busy: new Set<any>(), exclude: new Set<any>(), claudeLow: false, assigned: {}, ...extra });

  it('keeps lead tasks with Claude, overflows them to agy Claude models when Claude is low', () => {
    const { r } = mk();
    assert.equal(r.route(task('a', { lead: true }), 'M', o()).kind, 'lead');
    const ov = r.route(task('a', { lead: true }), 'M', o({ claudeLow: true }));
    assert.equal(ov.kind, 'worker');
    assert.equal((ov as any).provider, 'agy');
    assert.equal((ov as any).model, 'claude-sonnet-medium');
  });
  it('picks the tier model of the chosen provider', () => {
    const { r } = mk();
    const x = r.route(task('a', { provider: 'codex' }), 'XS', o()) as any;
    assert.equal(x.model, 'gpt-mini');
    assert.equal(x.effort, 'low');
    const y = r.route(task('a', { provider: 'agy' }), 'L', o()) as any;
    assert.equal(y.model, 'gemini-argon-high');
  });
  it('spreads work by weight instead of always using one provider', () => {
    const { r } = mk();
    const assigned: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      const x = r.route(task('a', { kind: 'chore' }), 'S', o({ assigned })) as any;
      assigned[x.provider] = (assigned[x.provider] ?? 0) + 1;
    }
    assert.ok((assigned.codex ?? 0) >= 6, JSON.stringify(assigned));
    assert.ok((assigned.agy ?? 0) >= 6, JSON.stringify(assigned));
  });
  it('waits when every provider with budget is busy, stops when none has budget', () => {
    const { r, cfg } = mk();
    assert.equal(r.route(task('a'), 'S', o({ busy: new Set(['codex', 'agy', 'gemini']) })).kind, 'wait');
    for (const p of ['codex', 'agy', 'gemini'] as const) cfg.providers[p].enabled = false;
    const n = r.route(task('a'), 'S', o());
    assert.equal(n.kind, 'none');
    assert.match(n.why, /budget/);
  });
  it('modelFor falls back to the nearest tier, preferring bigger', () => {
    assert.deepEqual(modelFor({ M: { model: 'm' }, XL: { model: 'x' } }, 'L'), { model: 'x' });
    assert.deepEqual(modelFor({ M: { model: 'm' } }, 'XS'), { model: 'm' });
  });
});

describe('budget', () => {
  it('stops new work at 85% and learns a ceiling from rate limits', () => {
    const cfg = testConfig((c) => (c.providers.codex.budget.maxTasks = 10));
    const ledger = new Ledger(tmp());
    const b = new BudgetTracker(cfg, ledger, { cooldownUntil: {}, tokenCeiling: {} });
    for (let i = 0; i < 7; i++) ledger.add(entry({ provider: 'codex', input: 100, output: 0 }));
    assert.equal(b.canStart('codex'), true); // 8th run would land at 80%
    ledger.add(entry({ provider: 'codex' }));
    assert.equal(b.usage('codex').fraction, 0.8);
    assert.equal(b.canStart('codex'), false);
    b.rateLimited('agy', 60_000);
    assert.equal(b.canStart('agy'), false);
    b.rateLimited('codex');
    assert.ok(b.learnedState().tokenCeiling.codex! > 0);
  });
  it('counts in-flight workers so parallel starts cannot overshoot', () => {
    const cfg = testConfig((c) => (c.providers.agy.budget.maxTasks = 2));
    const b = new BudgetTracker(cfg, new Ledger(tmp()), { cooldownUntil: {}, tokenCeiling: {} });
    assert.equal(b.canStart('agy'), true);
    b.begin('agy');
    assert.equal(b.canStart('agy'), false);
  });
});

describe('results', () => {
  it('extracts the result JSON from fenced or noisy text and truncates it', () => {
    const r = extractResult('blah\n```json\n{"status":"done","summary":"' + 'x'.repeat(2000) + '","files_changed":["a"],"tests_run":"npm test","notes":""}\n```');
    assert.equal(r!.status, 'done');
    assert.ok(r!.summary.length <= 600);
    assert.equal(extractResult('no json here'), undefined);
  });
  it('detects rate limits and retry hints', () => {
    assert.ok(isRateLimited("You've hit your usage limit"));
    assert.ok(isRateLimited('429 Too Many Requests'));
    assert.ok(!isRateLimited('tests failed'));
    assert.equal(retryAfterMs('Try again in 7 minutes'), 420_000);
    assert.equal(retryAfterMs('resets in 2 hours'), 7_200_000);
  });
});

describe('adapters', () => {
  const inv = { cwd: '/w', card: 'CARD\nline2', model: 'm', effort: 'low', timeoutMs: 600_000, lastMessageFile: '/w/last', extraArgs: [] };
  it('agy gets the prompt as the value of --print', () => {
    const a = ADAPTERS.agy.build(inv).args;
    assert.equal(a[0], '--print');
    assert.equal(a[1], 'CARD\nline2');
    assert.ok(a.includes('--model') && a.includes('m'));
  });
  it('codex reads the card from stdin, ignores user config, and keeps the sandbox setting', () => {
    const b = ADAPTERS.codex.build(inv);
    assert.equal(b.stdin, 'CARD\nline2');
    assert.equal(b.args.at(-1), '-');
    assert.ok(b.args.includes('--ignore-user-config') && b.args.includes('--ephemeral'));
  });
  it('reads machine-level settings from config.toml', () => {
    const toml = 'model = "gpt"\nmodel_reasoning_effort = "ultra"\n[windows]\nsandbox = "elevated"\n[sandbox_workspace_write]\nnetwork_access = true\n';
    assert.deepEqual(readTomlKeys(toml, CODEX_PASSTHROUGH), [['windows.sandbox', 'elevated'], ['sandbox_workspace_write.network_access', true]]);
  });
  it('separates "account refused" from "rate limited"', () => {
    const p = ADAPTERS.gemini.parse({ code: 41, stdout: '', stderr: 'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.', timedOut: false, lastMessageFile: '/nope' });
    assert.ok(p.fatal);
    assert.equal(p.rateLimited, false);
  });
});

describe('guards', () => {
  it('worker env puts shims first and raises depth; polyagent refuses to run nested', () => {
    const env = workerEnv('/shims', { PATH: '/usr/bin' });
    assert.ok(env.PATH!.startsWith('/shims'));
    assert.equal(env.POLYAGENT_DEPTH, '1');
    assert.throws(() => assertTopLevel({ POLYAGENT_DEPTH: '1' }), /nested agent calls are blocked/);
    assert.doesNotThrow(() => assertTopLevel({}));
  });
  it('task card stays under the cap and forbids delegation', () => {
    const c = buildCard({ task: task('a', { goal: 'g'.repeat(50_000) }), tier: 'S', test: 'npm test', maxChars: 4000 });
    assert.ok(c.length <= 4000);
    assert.match(c, /Do NOT start, call or delegate/);
    assert.match(c, /Reply with ONLY this JSON/);
  });
  it('scope matching handles paths, dirs and globs', () => {
    assert.ok(inScope('src/a.ts', ['src/']));
    assert.ok(inScope('src/x/y.ts', ['src/**/*.ts']));
    assert.ok(!inScope('lib/a.ts', ['src/**']));
    assert.ok(inScope('out\\a.txt', ['out/a.txt']));
  });
  it('quotes cmd.exe arguments', () => {
    assert.equal(cmdQuote('plain'), 'plain');
    assert.equal(cmdQuote('C:\\My Project\\x'), '"C:\\My Project\\x"');
    assert.equal(cmdQuote('a"b'), '"a\\"b"');
  });
  it('config validation catches bad values', () => {
    const c = testConfig((x) => ((x.stopAt = 2), (x.concurrency = 9)));
    const errs = validateConfig(c);
    assert.ok(errs.some((e) => /stopAt/.test(e)) && errs.some((e) => /concurrency/.test(e)));
  });
});

void (null as unknown as Tier);
