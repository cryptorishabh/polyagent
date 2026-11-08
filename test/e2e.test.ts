import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Ledger } from '../src/ledger.ts';
import { sh } from '../src/proc.ts';
import { loadState, Runner, runDir, summarize } from '../src/runner.ts';
import type { Config, TasksFile } from '../src/types.ts';
import { runShell } from '../src/verify.ts';
import { fakeAdapters, fakeBinaries, fakeEnv, gitRepo, task, tasksFile, testConfig } from './helpers.ts';

async function go(repo: string, cfg: Config, tf: TasksFile, extra: { claudeLow?: boolean } = {}) {
  const r = Runner.create(repo, cfg, tf, join(repo, 'tasks.json'), { adapters: fakeAdapters(), binaries: fakeBinaries(), log: () => {}, ...extra });
  const s = await r.run();
  return { r, s };
}

const calls = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

describe('e2e with fake CLIs', { concurrency: false }, () => {
  it('runs independent tasks in parallel across providers, verifies with tests, merges', async () => {
    const repo = gitRepo();
    const { log } = fakeEnv({ '*': 'ok' });
    const cfg = testConfig();
    const tf = tasksFile([task('a'), task('b'), task('c'), task('d', { dependsOn: ['a', 'b'] })]);
    const { s } = await go(repo, cfg, tf);
    for (const id of ['a', 'b', 'c', 'd']) assert.equal(s.tasks[id]!.status, 'passed', `${id}: ${JSON.stringify(s.tasks[id])}`);
    const used = new Set(calls(log).map((c) => c.provider));
    assert.ok(used.size >= 2, `expected work spread over providers, got ${[...used]}`);
    // d was built on top of a and b.
    const dWt = s.tasks.d!.worktree!;
    assert.ok(existsSync(join(dWt, 'out', 'a.txt')) && existsSync(join(dWt, 'out', 'b.txt')));
    // Merge back.
    for (const id of ['a', 'b', 'c', 'd']) assert.equal(sh('git', ['merge', '--no-ff', '--no-edit', s.tasks[id]!.branch!], repo).code, 0);
    assert.equal(readFileSync(join(repo, 'out', 'd.txt'), 'utf8'), 'ok');
    const sum = summarize(repo, s, cfg);
    assert.ok(JSON.stringify(sum).length < 8000, 'summary for the lead stays small');
  });

  it('passes per-tier model and effort to the CLI (cheap model for XS, big for L)', async () => {
    const repo = gitRepo();
    const { log } = fakeEnv({ '*': 'ok' });
    const cfg = testConfig();
    await go(repo, cfg, tasksFile([task('small', { tier: 'XS', provider: 'codex' }), task('big', { tier: 'L', provider: 'codex', files: ['out/big.txt'] })]));
    const c = calls(log);
    const small = c.find((x) => x.task === 'small')!.args;
    const big = c.find((x) => x.task === 'big')!.args;
    assert.ok(small.includes('gpt-mini') && small.includes('model_reasoning_effort="low"'), small.join(' '));
    assert.ok(big.includes('gpt-big') && big.includes('model_reasoning_effort="high"'), big.join(' '));
    assert.ok(small.includes('--ephemeral') && small.includes('--ignore-user-config'), 'fresh context, no user config');
  });

  it('failed tests -> one retry at a higher tier, then reassignment, then stop (no loops)', async () => {
    const repo = gitRepo();
    const { log } = fakeEnv({ codex: { t: 'bad' }, agy: { t: 'bad' }, gemini: { t: 'bad' } });
    const cfg = testConfig();
    const { s } = await go(repo, cfg, tasksFile([task('t', { tier: 'S' })]));
    const ts = s.tasks.t!;
    assert.equal(ts.status, 'failed');
    assert.equal(ts.attempts.length, 3);
    assert.equal(ts.attempts[0]!.tier, 'S');
    assert.equal(ts.attempts[1]!.tier, 'M', 'retry escalates one tier');
    assert.equal(ts.attempts[2]!.tier, 'M');
    assert.notEqual(ts.attempts[2]!.provider, ts.attempts[1]!.provider, 'third attempt goes to a different provider');
    assert.equal(calls(log).length, 3);
    assert.match(ts.testTail ?? '', /FAIL t/);
  });

  it('escalated retry succeeds', async () => {
    const repo = gitRepo();
    fakeEnv({ codex: { t: ['bad', 'ok'] } });
    const { s } = await go(repo, testConfig(), tasksFile([task('t', { provider: 'codex', tier: 'XS' })]));
    assert.equal(s.tasks.t!.status, 'passed');
    assert.deepEqual(s.tasks.t!.attempts.map((a) => [a.tier, a.outcome]), [['XS', 'fail'], ['S', 'pass']]);
  });

  it('rate limit -> provider cools down, task moves to another provider at the same tier', async () => {
    const repo = gitRepo();
    fakeEnv({ codex: { '*': 'ratelimit' }, '*': 'ok' });
    const cfg = testConfig((c) => (c.providers.agy.weight = 0.01));
    const { s } = await go(repo, cfg, tasksFile([task('t', { tier: 'M' })]));
    const ts = s.tasks.t!;
    assert.equal(ts.attempts[0]!.provider, 'codex');
    assert.equal(ts.attempts[0]!.outcome, 'rate_limited');
    assert.equal(ts.attempts[1]!.tier, ts.attempts[0]!.tier, 'not the model\'s fault: no escalation');
    assert.notEqual(ts.attempts[1]!.provider, 'codex');
    assert.equal(ts.status, 'passed');
    const learned = JSON.parse(readFileSync(join(repo, '.polyagent', 'learned.json'), 'utf8'));
    const until = Date.parse(learned.cooldownUntil.codex);
    assert.ok(until > Date.now() + 5 * 60_000 && until < Date.now() + 8 * 60_000, 'uses the "try again in 7 minutes" hint');
  });

  it('kills a hung worker at the timeout', async () => {
    const repo = gitRepo();
    fakeEnv({ codex: { t: 'sleep' }, '*': 'ok' });
    const cfg = testConfig((c) => (c.taskTimeoutMin = 0.05));
    const started = Date.now();
    const { s } = await go(repo, cfg, tasksFile([task('t', { provider: 'codex' })]));
    assert.equal(s.tasks.t!.attempts[0]!.outcome, 'timeout');
    assert.ok(Date.now() - started < 40_000);
  });

  it('blocks a worker that tries to start another agent', async () => {
    const repo = gitRepo();
    const { state } = fakeEnv({ codex: { t: 'delegate' } });
    const { s } = await go(repo, testConfig(), tasksFile([task('t', { provider: 'codex' })]));
    assert.equal(readFileSync(join(state, 'delegate-exit.t'), 'utf8'), '97', 'nested codex hit the shim');
    assert.equal(s.tasks.t!.status, 'passed');
  });

  it('budget stop: finishes running work, starts nothing new, writes resume.json; resume continues', async () => {
    const repo = gitRepo();
    fakeEnv({ '*': 'ok' });
    const cfg = testConfig((c) => {
      c.concurrency = 1;
      for (const p of ['codex', 'agy', 'gemini'] as const) c.providers[p].budget.maxTasks = 1;
      c.stopAt = 1;
    });
    const tf = tasksFile([task('a'), task('b'), task('c'), task('d'), task('e')]);
    const { s } = await go(repo, cfg, tf);
    const done = Object.values(s.tasks).filter((t) => t.status === 'passed').length;
    assert.equal(done, 3, 'one task per provider budget');
    assert.ok(s.stopped);
    assert.ok(existsSync(join(runDir(repo, s.runId), 'resume.json')));
    assert.equal(Object.values(s.tasks).filter((t) => t.status === 'stopped').length, 2);

    // More budget (e.g. a new window) -> resume finishes the rest.
    for (const p of ['codex', 'agy', 'gemini'] as const) cfg.providers[p].budget.maxTasks = 10;
    const again = new Runner(repo, cfg, tf, loadState(repo, s.runId), { adapters: fakeAdapters(), binaries: fakeBinaries(), log: () => {} });
    const s2 = await again.run();
    assert.ok(Object.values(s2.tasks).every((t) => t.status === 'passed'));
    assert.equal(new Ledger(repo).all().length, 5, 'no task ran twice');
  });

  it('a failed dependency blocks dependents instead of wasting runs', async () => {
    const repo = gitRepo();
    const { log } = fakeEnv({ '*': 'bad' });
    const { s } = await go(repo, testConfig(), tasksFile([task('a'), task('b', { dependsOn: ['a'] })]));
    assert.equal(s.tasks.a!.status, 'failed');
    assert.equal(s.tasks.b!.status, 'blocked');
    assert.ok(calls(log).every((c) => c.task === 'a'));
  });

  it('lead tasks are left for Claude; with --claude-low they overflow to agy Claude models', async () => {
    const repo = gitRepo();
    const { log } = fakeEnv({ '*': 'ok' });
    const arch = task('arch', { lead: true, tier: 'M', files: ['out/arch.txt', 'out/x.txt', 'out/y.txt'] });
    const { s } = await go(repo, testConfig(), tasksFile([arch]));
    assert.equal(s.tasks.arch!.status, 'lead');
    assert.equal(calls(log).length, 0);
    const { s: s2 } = await go(repo, testConfig(), tasksFile([arch]), { claudeLow: true });
    assert.equal(s2.tasks.arch!.status, 'passed');
    const c = calls(log)[0];
    assert.equal(c.provider, 'agy');
    assert.ok(c.args.includes('claude-sonnet-medium'));
  });

  it('a provider that refuses the account is disabled once, and work moves on without retrying it', async () => {
    const repo = gitRepo();
    const { log } = fakeEnv({ gemini: { '*': 'ineligible' }, '*': 'ok' });
    const cfg = testConfig((c) => ((c.providers.gemini.weight = 100), (c.concurrency = 1)));
    const { s } = await go(repo, cfg, tasksFile([task('a', { kind: 'docs' }), task('b', { kind: 'docs' })]));
    assert.equal(s.tasks.a!.status, 'passed');
    assert.equal(s.tasks.b!.status, 'passed');
    assert.equal(calls(log).filter((c) => c.provider === 'gemini').length, 1, 'gemini tried exactly once');
    const learned = JSON.parse(readFileSync(join(repo, '.polyagent', 'learned.json'), 'utf8'));
    assert.match(learned.disabled.gemini, /IneligibleTierError/);
  });

  it('runs test commands containing quotes, && and pipes exactly as written', async () => {
    const tmpd = gitRepo();
    const ok = await runShell(`node -e "const s='a b';process.exit(s==='a b'&&1===1?0:1)"`, tmpd, 30_000);
    assert.equal(ok.ok, true, ok.tail);
    const bad = await runShell(`node -e "process.exit(2)"`, tmpd, 30_000);
    assert.equal(bad.ok, false);
  });

  it('flags files changed outside the task scope', async () => {
    const repo = gitRepo();
    fakeEnv({ '*': 'ok' });
    const { s } = await go(repo, testConfig(), tasksFile([task('t', { files: ['src/'] })]));
    assert.deepEqual(s.tasks.t!.outOfScope, ['out/t.txt']);
  });
});
