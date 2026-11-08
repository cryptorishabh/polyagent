import { clip } from './result.ts';
import type { Task, Tier } from './types.ts';

export interface CardOpts {
  task: Task;
  tier: Tier;
  test?: string;
  /** Short reason the previous attempt failed (test tail, error). */
  previousFailure?: string;
  maxChars: number;
}

const RESULT_SPEC = `{"status":"done|partial|blocked","summary":"<=600 chars: what you changed and why","files_changed":["path", "..."],"tests_run":"command and result, or none","notes":"<=400 chars: risks or why blocked"}`;

/**
 * The only context a worker gets. Small on purpose: no chat history, no repo dump.
 * Workers read the files they need themselves.
 */
export function buildCard(o: CardOpts): string {
  const t = o.task;
  const head = [
    `# polyagent task ${t.id} (${t.kind}, tier ${o.tier})`,
    '',
    'You are a polyagent worker. Rules:',
    '- Work only inside the current directory (a git worktree made for this task).',
    '- Do NOT start, call or delegate to any other AI agent or CLI (codex, agy, gemini, claude, polyagent). Those calls are blocked and count as failure.',
    '- Do not commit, push or switch branches. polyagent commits and verifies your work.',
    '- Stay within the files in scope unless a change elsewhere is strictly required; say so in notes.',
    '- Follow the project rules in AGENTS.md / CLAUDE.md / GEMINI.md if present.',
    '',
    `## Title\n${clip(t.title, 200)}`,
  ];
  const scope = t.files.length ? t.files.slice(0, 40).map((f) => `- ${f}`).join('\n') + (t.files.length > 40 ? `\n- …and ${t.files.length - 40} more` : '') : '- (not specified: find the relevant files yourself, keep the change small)';
  const accept = t.acceptance.slice(0, 15).map((a) => `- ${clip(a, 300)}`).join('\n');
  const test = o.test ? `## Test command\n\`${o.test}\` (run it if your sandbox allows; polyagent runs it again afterwards)` : '## Test command\nnone configured';
  const prev = o.previousFailure ? `## Previous attempt failed\n${clip(o.previousFailure, 1500)}\nFix the cause; do not repeat the same approach blindly.` : '';
  const tail = `## When finished\nReply with ONLY this JSON object and nothing else:\n${RESULT_SPEC}`;

  const fixed = [head.join('\n'), `## Files in scope\n${scope}`, `## Acceptance criteria\n${accept}`, test, prev, tail].filter(Boolean);
  const fixedLen = fixed.join('\n\n').length + 20;
  const goalBudget = Math.max(400, o.maxChars - fixedLen);
  const parts = [head.join('\n'), `## Goal\n${clip(t.goal, goalBudget)}`, ...fixed.slice(1)];
  return clip(parts.join('\n\n'), o.maxChars);
}
