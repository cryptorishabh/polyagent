import { snapshot } from './dashboard/snapshot.ts';
import type { Config } from './types.ts';

export function quotaRows(repo: string, cfg: Config) {
  return snapshot(repo, cfg).providers.map((p) => {
    const usedPct = Math.round(p.used * 100);
    return {
      id: p.id, enabled: p.enabled, usedPct, leftPct: Math.max(0, 100 - usedPct),
      windowTasks: p.windowTasks, maxTasks: p.maxTasks, windowTokens: p.windowTokens,
      maxTokens: p.maxTokens, state: p.state, note: p.note,
    };
  });
}

export function renderQuota(rows: ReturnType<typeof quotaRows>): string {
  const cells = [
    ['Provider', 'Left', 'Used', 'Tasks', 'Tokens', 'State', 'Note'],
    ...rows.map((r) => [r.id, `${r.leftPct}%`, `${r.usedPct}%`, `${r.windowTasks}/${r.maxTasks || 'unlimited'}`, `${r.windowTokens}/${r.maxTokens || 'unlimited'}`, r.state, r.note ?? '']),
  ];
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((row) => row[i]!.length)));
  return ['Polyagent budget left in the current window (not provider subscription quota)', ...cells.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd())].join('\n');
}
