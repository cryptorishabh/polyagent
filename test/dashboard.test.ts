import assert from 'node:assert/strict';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { snapshot } from '../src/dashboard/snapshot.ts';
import { bar, renderTui } from '../src/dashboard/tui.ts';
import { startWeb } from '../src/dashboard/web.ts';
import { loadState, Runner } from '../src/runner.ts';
import { fakeAdapters, fakeBinaries, fakeEnv, gitRepo, task, tasksFile, testConfig } from './helpers.ts';

async function finishedRun() {
  const repo = gitRepo();
  fakeEnv({ codex: { b: 'bad' }, '*': 'ok' });
  const cfg = testConfig();
  const r = Runner.create(repo, cfg, tasksFile([task('a'), task('b', { provider: 'codex' }), task('c', { dependsOn: ['a'] })]), join(repo, 'tasks.json'), { adapters: fakeAdapters(), binaries: fakeBinaries(), log: () => {} });
  const s = await r.run();
  return { repo, cfg, s };
}

describe('dashboard', { concurrency: false }, () => {
  it('snapshot shows each task with its tool, model, tokens and per-tool totals', async () => {
    const { repo, cfg, s } = await finishedRun();
    const snap = snapshot(repo, cfg);
    assert.equal(snap.run!.id, s.runId);
    assert.equal(snap.tasks.length, 3);
    const a = snap.tasks.find((t) => t.id === 'a')!;
    assert.equal(a.status, 'passed');
    assert.ok(a.provider && a.model, 'tool and model shown');
    assert.equal(a.tokens, 1200, 'tokens from the ledger (fake reports 1000 in + 200 out)');
    const b = snap.tasks.find((t) => t.id === 'b')!;
    assert.equal(b.status, 'failed');
    assert.equal(b.history.length, 2);
    assert.equal(snap.totals.runTokens, snap.providers.reduce((x, p) => x + p.runTokens, 0));
    assert.ok(snap.providers.find((p) => p.id === 'codex')!.runTasks >= 2);
  });

  it('shows running tasks live: where, which model, elapsed time', async () => {
    const { repo, cfg, s } = await finishedRun();
    const st = loadState(repo, s.runId);
    // Simulate a mid-run state file.
    st.finishedAt = undefined;
    st.tasks.c!.status = 'running';
    st.tasks.c!.current = { attempt: 1, provider: 'agy', model: 'gemini-argon-medium', tier: 'M', startedAt: new Date(Date.now() - 65_000).toISOString() };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repo, '.polyagent', 'runs', s.runId, 'state.json'), JSON.stringify(st));
    const snap = snapshot(repo, cfg);
    const c = snap.tasks.find((t) => t.id === 'c')!;
    assert.equal(c.provider, 'agy');
    assert.equal(c.model, 'gemini-argon-medium');
    assert.ok(c.elapsedMs >= 64_000);
    assert.equal(snap.providers.find((p) => p.id === 'agy')!.state, 'busy');
    const text = renderTui(snap, { color: false, width: 120 });
    assert.match(text, /running/);
    assert.match(text, /agy · gemini-argon-medium/);
    assert.match(text, /in \.polyagent\/wt\//);
    assert.match(text, /1m 0[5-9]s/);
  });

  it('terminal view handles "no runs yet" and draws budget bars', () => {
    const repo = gitRepo();
    const text = renderTui(snapshot(repo, testConfig()), { color: false, width: 100 });
    assert.match(text, /No runs yet/);
    assert.equal(bar(0.5, 10), '█████░░░░░');
  });

  it('web dashboard serves the page and live JSON, and only on localhost', async () => {
    const { repo, cfg, s } = await finishedRun();
    const { server, url } = await startWeb((id) => snapshot(repo, cfg, id), 0);
    try {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await (await fetch(url)).text();
      assert.match(page, /<title>polyagent dashboard<\/title>/);
      const j = await (await fetch(url + 'api/snapshot')).json();
      assert.equal(j.run.id, s.runId);
      assert.equal(j.tasks.length, 3);
      const port = new URL(url).port;
      const status = await new Promise<number>((res, rej) => {
        const r = request({ host: '127.0.0.1', port, path: '/api/snapshot', headers: { host: 'evil.example.com' } }, (x) => res(x.statusCode!));
        r.on('error', rej);
        r.end();
      });
      assert.equal(status, 403, 'rejects foreign Host headers (DNS rebinding)');
      const post = await fetch(url + 'api/snapshot', { method: 'POST' });
      assert.equal(post.status, 405, 'read-only');
    } finally {
      server.close();
    }
  });
});
