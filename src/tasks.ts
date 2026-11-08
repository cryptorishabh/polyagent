import { readFileSync } from 'node:fs';
import { PROVIDERS, TASK_KINDS, TIERS, type Task, type TasksFile } from './types.ts';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function validateTasks(tf: TasksFile): string[] {
  const errs: string[] = [];
  if (tf.version !== 1) errs.push('version must be 1');
  if (!Array.isArray(tf.tasks) || tf.tasks.length === 0) errs.push('tasks must be a non-empty array');
  if (errs.length) return errs;
  if (tf.tasks.length > 50) errs.push('at most 50 tasks per run (split the work into several runs)');
  const ids = new Set<string>();
  for (const t of tf.tasks) {
    const where = `task "${t.id ?? '?'}"`;
    if (typeof t.id !== 'string' || !ID_RE.test(t.id)) errs.push(`${where}: id must match ${ID_RE}`);
    else if (ids.has(t.id)) errs.push(`${where}: duplicate id`);
    else ids.add(t.id);
    if (!t.title || typeof t.title !== 'string') errs.push(`${where}: title required`);
    if (!t.goal || typeof t.goal !== 'string') errs.push(`${where}: goal required`);
    if (!TASK_KINDS.includes(t.kind)) errs.push(`${where}: kind must be one of ${TASK_KINDS.join(', ')}`);
    if (!TIERS.includes(t.tier)) errs.push(`${where}: tier must be one of ${TIERS.join(', ')}`);
    if (!Array.isArray(t.files)) errs.push(`${where}: files must be an array`);
    if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) errs.push(`${where}: acceptance must list at least one criterion`);
    if (t.provider !== undefined && !PROVIDERS.includes(t.provider)) errs.push(`${where}: unknown provider`);
    if (t.dependsOn !== undefined && !Array.isArray(t.dependsOn)) errs.push(`${where}: dependsOn must be an array`);
  }
  for (const t of tf.tasks) {
    for (const d of t.dependsOn ?? []) if (!ids.has(d)) errs.push(`task "${t.id}": depends on unknown task "${d}"`);
  }
  if (!errs.length) {
    const cycle = findCycle(tf.tasks);
    if (cycle) errs.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  return errs;
}

export function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/** Dependencies first. */
export function topoOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: Task[] = [];
  const visit = (t: Task) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const d of t.dependsOn ?? []) visit(byId.get(d)!);
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}

export function loadTasks(file: string): TasksFile {
  let tf: TasksFile;
  try {
    tf = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const errs = validateTasks(tf);
  if (errs.length) throw new Error(`${file}:\n  - ${errs.join('\n  - ')}`);
  return tf;
}
