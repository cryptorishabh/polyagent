import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, type Adapter } from '../src/adapters/index.ts';
import { defaultConfig } from '../src/config.ts';
import { sh } from '../src/proc.ts';
import type { Config, ProviderId, Task, TasksFile } from '../src/types.ts';

export const FAKE = fileURLToPath(new URL('./fake-clis/fake-agent.mjs', import.meta.url));

export function tmp(prefix = 'polyagent-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function gitRepo(): string {
  const d = tmp('pa-repo-');
  const g = (...a: string[]) => {
    const r = sh('git', a, d);
    if (r.code !== 0) throw new Error(r.err);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'test');
  g('config', 'user.email', 'test@example.com');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(d, 'out'));
  writeFileSync(join(d, 'out', '.keep'), '');
  // Test for task X: out/X.txt must say "ok".
  writeFileSync(join(d, 'check.mjs'), `import {readFileSync} from 'node:fs';const t=process.argv[2];let s='';try{s=readFileSync('out/'+t+'.txt','utf8')}catch{};if(s!=='ok'){console.error('FAIL '+t+': '+JSON.stringify(s));process.exit(1)}console.log('PASS '+t)\n`);
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return d;
}

/** Real adapters (real arg building + parsing), but the binary is node running the fake agent. */
export function fakeAdapters(): Record<ProviderId, Adapter> {
  const out = {} as Record<ProviderId, Adapter>;
  for (const [id, a] of Object.entries(ADAPTERS) as [ProviderId, Adapter][]) {
    out[id] = {
      ...a,
      binary: process.execPath,
      build(inv) {
        const b = a.build(inv);
        return { ...b, args: [FAKE, id, ...b.args] };
      },
    };
  }
  return out;
}

export const fakeBinaries = (): Partial<Record<ProviderId, string>> => ({ codex: process.execPath, agy: process.execPath, gemini: process.execPath, claude: process.execPath });

export function testConfig(over: (c: Config) => void = () => {}): Config {
  const c = defaultConfig();
  c.taskTimeoutMin = 0.5;
  c.testTimeoutMin = 1;
  c.providers.codex.tiers = { XS: { model: 'gpt-mini', effort: 'low' }, S: { model: 'gpt-mini', effort: 'medium' }, M: { model: 'gpt-mid', effort: 'medium' }, L: { model: 'gpt-big', effort: 'high' }, XL: { model: 'gpt-big', effort: 'xhigh' } };
  c.providers.agy.tiers = { XS: { model: 'gemini-flash-low' }, S: { model: 'gemini-flash-medium' }, M: { model: 'gemini-argon-medium' }, L: { model: 'gemini-argon-high' }, XL: { model: 'gemini-argon-high' } };
  c.providers.agy.overflowTiers = { S: { model: 'claude-sonnet-low' }, M: { model: 'claude-sonnet-medium' }, L: { model: 'claude-opus-high' } };
  c.providers.gemini.tiers = { M: { model: 'gemini-cli-model' } };
  over(c);
  return c;
}

export function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, goal: `Make out/${id}.txt say ok`, kind: 'feature', tier: 'S', files: [`out/${id}.txt`], acceptance: ['test passes'], test: `node check.mjs ${id}`, ...extra };
}

export function tasksFile(tasks: Task[]): TasksFile {
  return { version: 1, tasks };
}

export function fakeEnv(script: unknown): { state: string; log: string } {
  const state = tmp('pa-fake-');
  const f = join(state, 'script.json');
  writeFileSync(f, JSON.stringify(script));
  process.env.FAKE_SCRIPT = f;
  process.env.FAKE_STATE = state;
  process.env.FAKE_LOG = join(state, 'calls.jsonl');
  return { state, log: process.env.FAKE_LOG };
}
