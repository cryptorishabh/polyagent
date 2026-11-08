// A stand-in for codex / agy / gemini / claude used by the e2e tests. Spends no tokens.
// Behaviour per provider + task + attempt comes from the JSON file in $FAKE_SCRIPT:
//   { "codex": { "t1": ["bad", "ok"] }, "*": "ok" }
// Actions: ok | bad | none | ratelimit | sleep | delegate | crash
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const provider = process.argv[2];
const args = process.argv.slice(3);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

const usesStdin = provider !== 'agy';
const card = usesStdin ? await readStdin() : (args[args.indexOf('--print') + 1] ?? '');
const task = card.match(/# polyagent task (\S+)/)?.[1] ?? 'unknown';
const cwd = process.cwd();

const counterDir = join(process.env.FAKE_STATE ?? cwd, 'counters');
mkdirSync(counterDir, { recursive: true });
const cf = join(counterDir, `${provider}.${task}`);
const n = existsSync(cf) ? Number(readFileSync(cf, 'utf8')) + 1 : 1;
writeFileSync(cf, String(n));

if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ provider, task, n, args: args.filter((a) => a !== card) }) + '\n');

const script = process.env.FAKE_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_SCRIPT, 'utf8')) : {};
const forProv = script[provider]?.[task] ?? script[provider]?.['*'] ?? script['*'] ?? 'ok';
const action = Array.isArray(forProv) ? forProv[Math.min(n, forProv.length) - 1] : forProv;

const result = (status, summary) => JSON.stringify({ status, summary, files_changed: [`out/${task}.txt`], tests_run: 'none', notes: '' });

function emit(text) {
  const usage = { input_tokens: 1000, output_tokens: 200 };
  if (provider === 'codex') {
    const o = args[args.indexOf('-o') + 1];
    if (o) writeFileSync(o, text);
    console.log(JSON.stringify({ type: 'thread.started' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage }));
  } else if (provider === 'agy') {
    console.log(JSON.stringify({ result: text, usage }));
  } else if (provider === 'gemini') {
    console.log(JSON.stringify({ response: text, stats: { models: { 'fake-model': { tokens: { prompt: 1000, candidates: 200 } } } } }));
  } else {
    console.log(JSON.stringify({ result: text, usage }));
  }
}

function write(content) {
  mkdirSync(join(cwd, 'out'), { recursive: true });
  writeFileSync(join(cwd, 'out', `${task}.txt`), content);
}

switch (action) {
  case 'ok':
    write('ok');
    emit(result('done', `${provider} did ${task}`));
    break;
  case 'bad':
    write('bad');
    emit(result('done', `${provider} broke ${task}`));
    break;
  case 'none':
    emit(result('blocked', 'nothing to do'));
    break;
  case 'ratelimit':
    console.error('Error: You have hit your usage limit. Try again in 7 minutes.');
    process.exit(1);
    break;
  case 'sleep':
    await new Promise((r) => setTimeout(r, 60_000));
    break;
  case 'ineligible':
    console.error('An unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.');
    process.exit(41);
    break;
  case 'crash':
    console.error('segfault-ish crash');
    process.exit(2);
    break;
  case 'delegate': {
    // Try to hand the work to another agent, as the old setup did.
    const r = spawnSync(process.platform === 'win32' ? 'codex.cmd' : 'codex', ['exec', 'do my job'], { encoding: 'utf8', shell: process.platform === 'win32' });
    writeFileSync(join(process.env.FAKE_STATE ?? cwd, `delegate-exit.${task}`), String(r.status));
    write('ok');
    emit(result('done', 'tried to delegate'));
    break;
  }
  default:
    console.error(`unknown fake action ${action}`);
    process.exit(3);
}
