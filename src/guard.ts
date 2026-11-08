import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stateDir } from './ledger.ts';
import { IS_WIN } from './proc.ts';

/** Every agent CLI a worker might try to call to hand work onward. */
export const BLOCKED = ['codex', 'agy', 'antigravity', 'gemini', 'claude', 'polyagent', 'aider', 'cursor-agent', 'opencode'];
export const DEPTH_ENV = 'POLYAGENT_DEPTH';
export const BLOCK_EXIT = 97;

const MSG = 'polyagent: nested agent calls are blocked inside polyagent workers (depth guard).';

/** Writes stub executables that refuse to run. Placed first on a worker's PATH. */
export function ensureShims(repo: string): string {
  const dir = join(stateDir(repo), 'shims');
  mkdirSync(dir, { recursive: true });
  for (const name of BLOCKED) {
    const posix = join(dir, name);
    writeFileSync(posix, `#!/bin/sh\necho "${MSG}" >&2\nexit ${BLOCK_EXIT}\n`);
    try {
      chmodSync(posix, 0o755);
    } catch {
      /* windows */
    }
    if (IS_WIN) {
      writeFileSync(join(dir, `${name}.cmd`), `@echo ${MSG} 1>&2\r\n@exit /b ${BLOCK_EXIT}\r\n`);
      writeFileSync(join(dir, `${name}.ps1`), `[Console]::Error.WriteLine('${MSG}')\r\nexit ${BLOCK_EXIT}\r\n`);
    }
  }
  return dir;
}

/** Environment for a worker process: shims first on PATH, depth marker set. */
export function workerEnv(shimDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = shimDir + delimiter + (env[key] ?? '');
  env[DEPTH_ENV] = String(Number(base[DEPTH_ENV] ?? 0) + 1);
  // Stop CLIs from re-reading parent session context.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** polyagent itself refuses to run inside a worker. */
export function assertTopLevel(env: NodeJS.ProcessEnv = process.env): void {
  if (Number(env[DEPTH_ENV] ?? 0) >= 1) {
    throw new Error(`${MSG} (${DEPTH_ENV}=${env[DEPTH_ENV]})`);
  }
}
