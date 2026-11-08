import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.ts';
import { quotaRows, renderQuota } from '../src/quota.ts';
import { gitRepo, testConfig } from './helpers.ts';

test('quota reports rolling budget usage and clamps remaining percentage', () => {
  const repo = gitRepo();
  const cfg = testConfig((c) => {
    c.providers.codex.enabled = true;
    c.providers.codex.budget = { windowHours: 1, maxTasks: 4, maxTokens: 1000 };
  });
  const ledger = new Ledger(repo);
  const entry = {
    ts: new Date().toISOString(), run: 'run', task: 'task', attempt: 1,
    provider: 'codex' as const, tier: 'S' as const, kind: 'feature' as const,
    input: 100, output: 50, estimated: false, durationMs: 1, outcome: 'pass' as const,
  };
  ledger.add(entry);
  ledger.add(entry);
  ledger.add({ ...entry, ts: new Date(Date.now() - 7200_000).toISOString() });
  let row = quotaRows(repo, cfg).find((r) => r.id === 'codex')!;
  assert.equal(row.windowTasks, 2);
  assert.equal(row.windowTokens, 300);
  assert.equal(row.maxTasks, 4);
  assert.equal(row.maxTokens, 1000);
  assert.equal(row.usedPct, 50);
  assert.equal(row.leftPct, 100 - row.usedPct);
  assert.match(renderQuota([row]), /budget left in the current window/);
  ledger.add(entry);
  ledger.add(entry);
  ledger.add(entry);
  row = quotaRows(repo, cfg).find((r) => r.id === 'codex')!;
  assert.equal(row.leftPct, Math.max(0, 100 - row.usedPct));
  assert.equal(row.leftPct, 0);
});
