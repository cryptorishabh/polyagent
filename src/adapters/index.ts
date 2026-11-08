import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clip, extractResult, findUsage, isRateLimited, retryAfterMs, usageFrom } from '../result.ts';
import type { ProviderId, WorkerResult } from '../types.ts';

export const RESULT_SCHEMA = fileURLToPath(new URL('../../schema/result.json', import.meta.url));

export interface Invocation {
  cwd: string;
  card: string;
  model?: string;
  effort?: string;
  timeoutMs: number;
  /** File the CLI may write its last message to. */
  lastMessageFile: string;
  extraArgs: string[];
}

export interface Built {
  args: string[];
  stdin?: string;
}

export interface Raw {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  lastMessageFile: string;
}

export interface Parsed {
  /** Final assistant text (where the result JSON should be). */
  text: string;
  result?: WorkerResult;
  usage?: { input: number; output: number };
  rateLimited: boolean;
  retryAfterMs?: number;
  error?: string;
  /** The provider refused this account outright; disable it until the user fixes sign-in. */
  fatal?: string;
  /** A tool was auto-denied because headless mode cannot ask. A setup problem, not a model failure. */
  permissionDenied?: string;
}

export interface Adapter {
  id: ProviderId;
  binary: string;
  build(inv: Invocation): Built;
  parse(raw: Raw): Parsed;
  /** Args for a cheap version probe. */
  versionArgs: string[];
}

/** Machine-level Codex settings kept even though the user config is ignored. */
export const CODEX_PASSTHROUGH = ['windows.sandbox', 'sandbox_workspace_write.network_access'];

/** Reads `[section] key = "value"` entries from config.toml (minimal parser: strings and booleans). */
export function readTomlKeys(text: string, keys: string[]): [string, string | boolean][] {
  const out: [string, string | boolean][] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.+?)\s*(#.*)?$/);
    if (!kv) continue;
    const full = section ? `${section}.${kv[1]}` : kv[1]!;
    if (!keys.includes(full)) continue;
    const v = kv[2]!;
    if (v === 'true' || v === 'false') out.push([full, v === 'true']);
    else {
      const s = v.match(/^"([^"]*)"$|^'([^']*)'$/);
      if (s) out.push([full, s[1] ?? s[2]!]);
    }
  }
  return out;
}

let passthroughCache: [string, string | boolean][] | undefined;
function codexPassthrough(): [string, string | boolean][] {
  if (!passthroughCache) {
    const f = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
    passthroughCache = existsSync(f) ? readTomlKeys(readFileSync(f, 'utf8'), CODEX_PASSTHROUGH) : [];
  }
  return passthroughCache;
}

/** Errors that mean "this account can never use this CLI", not "try again later". */
const FATAL_RE = /(IneligibleTierError|no longer supported for|not eligible|account (is )?(suspended|disabled)|not logged in|please (log|sign) ?in|unauthenticated|invalid api key)/i;

const PERMISSION_RE = /(auto-denied|cannot prompt for|blocked by policy|requires? (user )?approval|permission (was )?denied)/i;

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

function finish(text: string, raw: Raw, usage?: { input: number; output: number }, error?: string): Parsed {
  const result = extractResult(text);
  const failed = raw.code !== 0 || !result;
  const blob = `${error ?? ''}\n${raw.stderr.slice(-4000)}\n${failed ? raw.stdout.slice(-4000) : ''}`;
  const all = `${blob}\n${raw.stdout.slice(-4000)}`;
  const permM = all.match(PERMISSION_RE);
  const fatalM = failed ? blob.match(FATAL_RE) : null;
  const rl = failed && !fatalM && isRateLimited(blob);
  const errText = failed ? (error ?? (raw.stderr.trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(-4).join('\n') || undefined)) : undefined;
  return { text, result, usage, rateLimited: rl, retryAfterMs: rl ? retryAfterMs(blob) : undefined, error: errText, permissionDenied: permM ? clip(all.slice(Math.max(0, (permM.index ?? 0) - 60), (permM.index ?? 0) + 200).trim(), 300) : undefined, fatal: fatalM ? clip(blob.slice(Math.max(0, (fatalM.index ?? 0) - 80), (fatalM.index ?? 0) + 200).trim(), 300) : undefined };
}

const pickText = (o: Record<string, unknown>) => ['result', 'response', 'text', 'output', 'content', 'message', 'final'].map((k) => o[k]).find((v) => typeof v === 'string') as string | undefined;

/** OpenAI Codex CLI: `codex exec`, ephemeral, user config ignored (so no "ultra"/priority defaults). */
export const codex: Adapter = {
  id: 'codex',
  binary: 'codex',
  versionArgs: ['--version'],
  build(inv) {
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--json', '--color', 'never', '-s', 'workspace-write', '-C', inv.cwd, '--output-schema', RESULT_SCHEMA, '-o', inv.lastMessageFile];
    // Ignoring the user config drops personal defaults (max effort, priority tier, plugins), but the
    // machine's sandbox setup must survive or the sandbox falls back to read-only.
    for (const [k, v] of codexPassthrough()) args.push('-c', `${k}=${JSON.stringify(v)}`);
    if (inv.model) args.push('-m', inv.model);
    if (inv.effort) args.push('-c', `model_reasoning_effort="${inv.effort}"`);
    args.push(...inv.extraArgs, '-');
    return { args, stdin: inv.card };
  },
  parse(raw) {
    let input = 0;
    let output = 0;
    let seen = false;
    let lastAgentText = '';
    let error: string | undefined;
    for (const line of raw.stdout.split('\n')) {
      const ev = tryJson(line) as Record<string, any> | undefined;
      if (!ev) continue;
      if (ev.type === 'turn.completed' && ev.usage) {
        const u = usageFrom(ev.usage);
        if (u) {
          input += u.input;
          output += u.output;
          seen = true;
        }
      }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') lastAgentText = ev.item.text;
      if (ev.type === 'error' || ev.type === 'turn.failed') error = String(ev.message ?? ev.error?.message ?? JSON.stringify(ev).slice(0, 500));
    }
    const fileText = existsSync(raw.lastMessageFile) ? readFileSync(raw.lastMessageFile, 'utf8') : '';
    return finish(fileText || lastAgentText, raw, seen ? { input, output } : undefined, error);
  },
};

/** Google Antigravity CLI (`agy`). Gemini models by default; Claude models only as overflow. */
export const agy: Adapter = {
  id: 'agy',
  binary: 'agy',
  versionArgs: ['--version'],
  build(inv) {
    const sec = Math.max(60, Math.floor(inv.timeoutMs / 1000) - 15);
    // Headless mode cannot prompt, so shell commands need an allow-rule. --sandbox keeps the terminal restricted.
    const settings = JSON.stringify({ permissions: { allow: ['command(*)'] } });
    const args = ['--print', '--output-format', 'json', '--json-schema', RESULT_SCHEMA, '--print-timeout', `${sec}s`, '--mode', 'accept-edits', '--disable-slash-commands', '--sandbox', '--settings', settings];
    if (inv.model) args.push('--model', inv.model);
    if (inv.effort) args.push('--effort', inv.effort);
    args.push(...inv.extraArgs);
    // --print takes the prompt as its own value.
    return { args: ['--print', inv.card, ...args.slice(1)] };
  },
  parse(raw) {
    const o = tryJson(raw.stdout) as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object') return finish(raw.stdout, raw);
    const structured = o.structured_output ?? o.structuredOutput;
    const text = structured ? JSON.stringify(structured) : (pickText(o) ?? raw.stdout);
    const err = typeof o.error === 'string' ? o.error : (o.error as any)?.message;
    return finish(text, raw, findUsage(o), err);
  },
};

/** Google Gemini CLI. Used as the fallback route into the Google AI quota. */
export const gemini: Adapter = {
  id: 'gemini',
  binary: 'gemini',
  versionArgs: ['--version'],
  build(inv) {
    const args = ['-p', 'Follow the polyagent task card given above on stdin.', '--output-format', 'json', '--approval-mode', 'auto_edit', '--skip-trust'];
    if (inv.model) args.push('-m', inv.model);
    args.push(...inv.extraArgs);
    return { args, stdin: inv.card };
  },
  parse(raw) {
    const o = tryJson(raw.stdout) as Record<string, any> | undefined;
    if (!o || typeof o !== 'object') return finish(raw.stdout, raw);
    let usage: { input: number; output: number } | undefined;
    const models = o.stats?.models;
    if (models && typeof models === 'object') {
      let i = 0;
      let out = 0;
      for (const m of Object.values(models) as any[]) {
        const u = usageFrom(m?.tokens);
        if (u) {
          i += u.input;
          out += u.output;
        }
      }
      usage = { input: i, output: out };
    }
    const err = typeof o.error === 'string' ? o.error : o.error?.message;
    return finish(typeof o.response === 'string' ? o.response : raw.stdout, raw, usage ?? findUsage(o), err);
  },
};

/** Claude Code as a headless worker. Off by default: Claude leads in-session instead. */
export const claude: Adapter = {
  id: 'claude',
  binary: 'claude',
  versionArgs: ['--version'],
  build(inv) {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
    if (inv.model) args.push('--model', inv.model);
    args.push(...inv.extraArgs);
    return { args, stdin: inv.card };
  },
  parse(raw) {
    const o = tryJson(raw.stdout) as Record<string, any> | undefined;
    if (!o || typeof o !== 'object') return finish(raw.stdout, raw);
    const u = o.usage ? { input: (o.usage.input_tokens ?? 0) + (o.usage.cache_creation_input_tokens ?? 0), output: o.usage.output_tokens ?? 0 } : undefined;
    return finish(typeof o.result === 'string' ? o.result : raw.stdout, raw, u, o.is_error ? String(o.result ?? 'error') : undefined);
  },
};

export const ADAPTERS: Record<ProviderId, Adapter> = { codex, agy, gemini, claude };
