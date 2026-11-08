import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installClis, planInstall, type InstallOption } from '../src/install.ts';

const machine = (bins: string[]) => {
  const set = new Set(bins);
  return (b: string) => (set.has(b) ? `/bin/${b}` : undefined);
};

describe('install planning', () => {
  it('uses each vendor\'s official installer for the platform', () => {
    const win = planInstall(['codex', 'agy', 'gemini'], machine(['npm', 'winget']), 'win32');
    assert.deepEqual(win.map((p) => p.state), ['installable', 'installable', 'installable']);
    assert.equal((win[0] as any).option.display, 'npm install -g @openai/codex');
    assert.equal((win[1] as any).option.display, 'winget install --id Google.AntigravityCLI --exact');
    assert.equal((win[2] as any).option.display, 'npm install -g @google/gemini-cli');
    const mac = planInstall(['agy'], machine(['curl']), 'darwin');
    assert.match((mac[0] as any).option.display, /^curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash$/);
  });
  it('reports installed CLIs and skips ones with no installer available', () => {
    const p = planInstall(['codex', 'agy'], machine(['codex']), 'win32');
    assert.equal(p[0]!.state, 'installed');
    assert.equal(p[1]!.state, 'skip');
    assert.match((p[1] as any).reason, /winget/);
  });
});

describe('installClis', () => {
  const quiet = () => {};
  it('never installs without a yes', async () => {
    const ran: InstallOption[] = [];
    const r = await installClis(['codex'], { yes: false, dryRun: false, interactive: true, ask: async () => false, exec: (o) => (ran.push(o), 0), has: machine(['npm']), out: quiet });
    assert.equal(r[0]!.result, 'declined');
    assert.equal(ran.length, 0);
    const r2 = await installClis(['codex'], { yes: false, dryRun: false, interactive: false, exec: (o) => (ran.push(o), 0), has: machine(['npm']), out: quiet });
    assert.equal(r2[0]!.result, 'declined', 'no terminal and no --yes: does not install');
    assert.equal(ran.length, 0);
  });
  it('installs on yes and reports the next sign-in step', async () => {
    const bins = ['npm'];
    const lines: string[] = [];
    const r = await installClis(['codex'], { yes: false, dryRun: false, interactive: true, ask: async () => true, exec: () => (bins.push('codex'), 0), has: (b) => (bins.includes(b) ? `/bin/${b}` : undefined), out: (s) => lines.push(s) });
    assert.equal(r[0]!.result, 'installed');
    assert.ok(lines.some((l) => /codex login/.test(l)));
  });
  it('dry run lists commands only; failures and missing installers are skipped, not fatal', async () => {
    const ran: InstallOption[] = [];
    const dry = await installClis(['codex', 'gemini'], { yes: true, dryRun: true, interactive: false, exec: (o) => (ran.push(o), 0), has: machine(['npm']), out: quiet });
    assert.deepEqual(dry.map((d) => d.result), ['would-install', 'would-install']);
    assert.equal(ran.length, 0);
    const fail = await installClis(['codex'], { yes: true, dryRun: false, interactive: false, exec: () => 1, has: machine(['npm']), out: quiet });
    assert.equal(fail[0]!.result, 'failed');
    const none = await installClis(['agy'], { yes: true, dryRun: false, interactive: false, exec: () => 0, has: machine([]), out: quiet });
    assert.equal(none[0]!.result, 'skipped');
  });
  it('warns that Gemini CLI does not accept personal Google accounts', async () => {
    const lines: string[] = [];
    await installClis(['gemini'], { yes: false, dryRun: true, interactive: false, has: machine(['npm']), out: (s) => lines.push(s) });
    assert.ok(lines.some((l) => /personal Google accounts/.test(l)));
  });
});
