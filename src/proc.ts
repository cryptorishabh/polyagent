import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export const IS_WIN = process.platform === 'win32';

export interface RunOpts {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  /** Full stdout+stderr is streamed here; memory keeps only the tail. */
  logFile?: string;
  maxBufferChars?: number;
  /** Windows: pass args to the process exactly as given (caller did the quoting). */
  verbatim?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Finds an executable on PATH (skipping `skipDirs`, e.g. our shim dir).
 * On Windows prefers .exe > .cmd > .bat > .ps1, like a shell would for our purposes.
 */
export function resolveBinary(name: string, opts: { path?: string; skipDirs?: string[] } = {}): string | undefined {
  if (isAbsolute(name)) return existsSync(name) ? name : undefined;
  const dirs = (opts.path ?? process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  const skip = new Set((opts.skipDirs ?? []).map((d) => d.toLowerCase()));
  const exts = IS_WIN ? (extname(name) ? [''] : ['.exe', '.cmd', '.bat', '.ps1']) : [''];
  for (const ext of exts) {
    for (const d of dirs) {
      if (skip.has(d.toLowerCase())) continue;
      const p = join(d, name + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/** Quote one argument for cmd.exe (used only for .cmd/.bat shims such as npm's gemini.cmd). */
export function cmdQuote(a: string): string {
  if (a === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '%%') + '"';
}

/** Turns (binary, args) into something spawn can run safely on every OS. */
export function spawnPlan(bin: string, args: string[]): { file: string; args: string[]; shell: boolean; verbatim: boolean } {
  const ext = extname(bin).toLowerCase();
  if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    // cmd.exe cannot carry a newline inside an argument; adapters pass long prompts on stdin instead.
    if (args.some((a) => /[\r\n]/.test(a))) throw new Error(`${bin} is a .cmd shim and cannot take multi-line arguments; point "binary" at the real executable`);
    const line = [cmdQuote(bin), ...args.map(cmdQuote)].join(' ');
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], shell: false, verbatim: true };
  }
  if (IS_WIN && ext === '.ps1') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bin, ...args], shell: false, verbatim: false };
  }
  return { file: bin, args, shell: false, verbatim: false };
}

export function killTree(pid: number): void {
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export function run(o: RunOpts): Promise<RunResult> {
  const max = o.maxBufferChars ?? 2_000_000;
  const plan = spawnPlan(o.cmd, o.args);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      shell: plan.shell,
      windowsVerbatimArguments: plan.verbatim || !!o.verbatim,
      windowsHide: true,
      detached: !IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = o.logFile ? createWriteStream(o.logFile, { flags: 'a' }) : undefined;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const keep = (s: string) => (s.length > max ? s.slice(s.length - max) : s);
    child.stdout.on('data', (d: Buffer) => {
      stdout = keep(stdout + d.toString());
      log?.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = keep(stderr + d.toString());
      log?.write(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, o.timeoutMs);
    child.on('error', (e) => {
      stderr += `\n[polyagent] spawn failed: ${e.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      log?.end();
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    if (o.stdin !== undefined) child.stdin.end(o.stdin);
    else child.stdin.end();
  });
}

/** Small synchronous helper for git and version probes. */
export function sh(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  const plan = spawnPlan(cmd, args);
  const r = spawnSync(plan.file, plan.args, { cwd, env: env ?? process.env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: plan.verbatim, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() + (r.error ? ` ${r.error.message}` : '') };
}
