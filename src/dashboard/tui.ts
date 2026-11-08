import type { TaskStatus } from '../types.ts';
import { fmtDuration, fmtTokens, type ProviderRow, type Snapshot } from './snapshot.ts';

export interface TuiOpts {
  color: boolean;
  width: number;
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m' };

const STATUS: Record<TaskStatus, { icon: string; color: keyof typeof C }> = {
  running: { icon: '▶', color: 'cyan' },
  pending: { icon: '·', color: 'dim' },
  passed: { icon: '✔', color: 'green' },
  merged: { icon: '✔', color: 'green' },
  unverified: { icon: '?', color: 'yellow' },
  failed: { icon: '✖', color: 'red' },
  blocked: { icon: '⊘', color: 'red' },
  stopped: { icon: '■', color: 'yellow' },
  lead: { icon: '★', color: 'magenta' },
};

const ORDER: TaskStatus[] = ['running', 'pending', 'lead', 'failed', 'blocked', 'stopped', 'unverified', 'passed', 'merged'];

function pad(s: string, n: number): string {
  const len = [...s].length;
  return len > n ? [...s].slice(0, Math.max(1, n - 1)).join('') + '…' : s + ' '.repeat(n - len);
}

export function bar(frac: number, width: number): string {
  const full = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function renderTui(s: Snapshot, o: TuiOpts): string {
  const k = (c: keyof typeof C, t: string) => (o.color ? C[c] + t + C.reset : t);
  const W = Math.max(70, Math.min(o.width, 140));
  const L: string[] = [];

  if (!s.run) {
    L.push(k('bold', 'polyagent dashboard'), '', 'No runs yet in this project. Start one with: polyagent run <tasks.json>');
    return L.join('\n');
  }
  const live = !s.run.finishedAt;
  const head = `${k('bold', 'polyagent')} · run ${s.run.id} · ${live ? k('cyan', 'running') : s.run.stopped ? k('yellow', 'stopped') : 'finished'} · ${fmtDuration(s.run.elapsedMs)}`;
  L.push(head);
  if (s.run.stopped) L.push(k('yellow', `  ${s.run.stopped}  →  polyagent resume ${s.run.id}`));
  const cnt = ORDER.filter((st) => s.counts[st]).map((st) => k(STATUS[st].color, `${s.counts[st]} ${st}`)).join(' · ');
  L.push(`${cnt}    tokens this run: ${k('bold', fmtTokens(s.totals.runTokens))}${s.totals.estimated ? k('dim', ' (some estimated)') : ''}`);
  L.push('');

  L.push(k('bold', 'TOOLS') + k('dim', '   budget used in the current window'));
  const bw = Math.max(10, Math.min(24, W - 90));
  for (const p of s.providers) L.push(providerLine(p, bw, k));
  L.push('');

  // Fixed columns take 64 chars; the model column gets the rest.
  const modelW = Math.max(18, Math.min(44, W - 64));
  L.push(k('bold', 'TASKS'));
  L.push(k('dim', `  ${pad('STATUS', 11)} ${pad('TASK', 20)} ${pad('TIER', 4)} ${pad('TOOL · MODEL', modelW)} ${pad('TIME', 8)} ${pad('TOKENS', 7)} TRY`));
  const rows = [...s.tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  for (const t of rows) {
    const st = STATUS[t.status];
    const tool = t.provider ? `${t.provider} · ${t.model ?? 'default'}${t.effort ? '/' + t.effort : ''}` : t.status === 'lead' ? 'Claude (you)' : '—';
    L.push(`  ${k(st.color, pad(`${st.icon} ${t.status}`, 11))} ${pad(t.id, 20)} ${pad(t.tier, 4)} ${pad(tool, modelW)} ${pad(t.elapsedMs ? fmtDuration(t.elapsedMs) : '—', 8)} ${pad(t.tokens ? fmtTokens(t.tokens) : '—', 7)} ${t.attempt || '—'}`);
    if (t.status === 'running' && t.where) L.push(k('dim', `      in ${t.where}`));
  }
  L.push('');
  L.push(k('dim', `updated ${new Date(s.at).toLocaleTimeString()} · all-time tokens ${fmtTokens(s.totals.allTimeTokens)} · Ctrl+C to quit`));
  return L.join('\n');
}

function providerLine(p: ProviderRow, bw: number, k: (c: keyof typeof C, t: string) => string): string {
  const pct = `${Math.round(p.used * 100)}%`.padStart(4);
  const left = `${Math.round(p.left * 100)}% left`.padStart(9);
  const color = p.used >= 0.85 ? 'red' : p.used >= 0.6 ? 'yellow' : 'green';
  const cap = p.maxTasks ? `${p.windowTasks}/${p.maxTasks} tasks` : `${p.windowTasks} tasks`;
  const state =
    p.state === 'busy' ? k('cyan', `● working (${p.running})`)
    : p.state === 'cooling' ? k('yellow', `◐ cooling down ${p.note ?? ''}`)
    : p.state === 'disabled' ? k('red', '✖ disabled: account refused (details: polyagent doctor)')
    : p.state === 'off' ? k('dim', '○ off')
    : k('dim', '○ idle');
  return `  ${pad(p.id, 7)} ${k(color, bar(p.used, bw))} ${pct} ${left}  ${pad(cap, 13)} ${pad(`${fmtTokens(p.runTokens)} this run`, 15)} ${state}`;
}

/** Live terminal dashboard: redraws every second until Ctrl+C. */
export function watchTui(get: () => Snapshot, intervalMs = 1000): void {
  const draw = () => {
    let text: string;
    try {
      text = renderTui(get(), { color: !process.env.NO_COLOR && !!process.stdout.isTTY, width: process.stdout.columns ?? 100 });
    } catch (e) {
      text = `polyagent dashboard: ${(e as Error).message}`;
    }
    process.stdout.write('\x1b[H\x1b[2J' + text + '\n');
  };
  draw();
  const t = setInterval(draw, intervalMs);
  process.on('SIGINT', () => {
    clearInterval(t);
    process.stdout.write('\n');
    process.exit(0);
  });
}
