import { IS_WIN, run } from './proc.ts';

export interface ShellResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  tail: string;
}

/** Runs a project command (tests, setup) through the platform shell. Never an LLM. */
export async function runShell(command: string, cwd: string, timeoutMs: number, logFile?: string, env?: NodeJS.ProcessEnv): Promise<ShellResult> {
  // cmd.exe /s /c "<command>" must receive the command verbatim; Node's default escaping (\") breaks quotes.
  const r = IS_WIN
    ? await run({ cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], cwd, timeoutMs, logFile, env, verbatim: true })
    : await run({ cmd: '/bin/sh', args: ['-c', command], cwd, timeoutMs, logFile, env });
  const all = (r.stdout + '\n' + r.stderr).trim();
  return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, tail: all.slice(-1500) };
}
