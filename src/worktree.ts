import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './ledger.ts';
import { sh } from './proc.ts';

export class GitError extends Error {}

export function git(cwd: string, ...args: string[]): string {
  const r = sh('git', args, cwd);
  if (r.code !== 0) throw new GitError(`git ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

export function gitOk(cwd: string, ...args: string[]): boolean {
  return sh('git', args, cwd).code === 0;
}

export function repoRoot(cwd: string): string {
  return git(cwd, 'rev-parse', '--show-toplevel');
}

/** Keeps .polyagent/ out of git without touching the user's .gitignore. */
export function excludeStateDir(repo: string): void {
  const common = git(repo, 'rev-parse', '--git-common-dir');
  const gitDir = join(common.match(/^[A-Za-z]:|^\//) ? '' : repo, common);
  const info = join(gitDir, 'info');
  mkdirSync(info, { recursive: true });
  const f = join(info, 'exclude');
  const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes(`/${STATE_DIR}/`)) appendFileSync(f, `${cur.endsWith('\n') || !cur ? '' : '\n'}/${STATE_DIR}/\n`);
}

export const branchName = (runId: string, taskId: string) => `polyagent/${runId}/${taskId}`;

const COMMITTER = ['-c', 'user.name=polyagent', '-c', 'user.email=polyagent@users.noreply.github.com'];

/**
 * Fresh worktree for a task, started from `base` plus the branches of its dependencies.
 * Re-creating discards a failed attempt so a retry never inherits a broken half-change.
 */
export function createWorktree(repo: string, dir: string, branch: string, base: string, mergeFrom: string[]): void {
  removeWorktree(repo, dir, branch);
  git(repo, 'worktree', 'add', '-f', '-b', branch, dir, base);
  for (const dep of mergeFrom) {
    const r = sh('git', [...COMMITTER, 'merge', '--no-edit', '--no-ff', dep], dir);
    if (r.code !== 0) {
      sh('git', ['merge', '--abort'], dir);
      throw new GitError(`dependency branch ${dep} conflicts: ${r.err || r.out}`);
    }
  }
}

export function removeWorktree(repo: string, dir: string, branch?: string): void {
  if (existsSync(dir)) {
    sh('git', ['worktree', 'remove', '--force', dir], repo);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  sh('git', ['worktree', 'prune'], repo);
  if (branch && gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) sh('git', ['branch', '-D', branch], repo);
}

/** Commits whatever the worker left. Returns the changed paths ([] = no changes). */
export function commitAll(dir: string, message: string, author: string): string[] {
  git(dir, 'add', '-A');
  const names = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  // Workers sometimes commit on their own; count those too.
  if (!names.length) return [];
  git(dir, ...COMMITTER, 'commit', '-q', '--no-verify', '-m', message, `--author=${author} <polyagent@users.noreply.github.com>`);
  return names;
}

export function changedSince(dir: string, base: string): string[] {
  return git(dir, 'diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
}

export function diffStat(dir: string, base: string, maxLines = 12): string {
  const lines = git(dir, 'diff', '--stat', `${base}...HEAD`).split('\n');
  return lines.length > maxLines ? [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines} more`, lines.at(-1)!].join('\n') : lines.join('\n');
}

export { COMMITTER };
