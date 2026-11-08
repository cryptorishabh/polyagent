import type { Usage, WorkerResult } from './types.ts';

export const LIMITS = { summary: 600, notes: 400, tests_run: 300, files: 60 };

export function clip(s: string, n: number): string {
  s = (s ?? '').toString().trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Validates and truncates a worker's JSON so the lead never reads more than a few hundred tokens. */
export function normalizeResult(v: unknown): WorkerResult | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== 'string' || typeof o.status !== 'string') return undefined;
  const status = (['done', 'partial', 'blocked'] as const).find((s) => s === o.status) ?? 'partial';
  return {
    status,
    summary: clip(o.summary, LIMITS.summary),
    files_changed: Array.isArray(o.files_changed) ? o.files_changed.filter((x): x is string => typeof x === 'string').slice(0, LIMITS.files) : [],
    tests_run: clip(typeof o.tests_run === 'string' ? o.tests_run : '', LIMITS.tests_run),
    notes: clip(typeof o.notes === 'string' ? o.notes : '', LIMITS.notes),
  };
}

/** Finds the last JSON object in free text (fenced or bare) that looks like a worker result. */
export function extractResult(text: string): WorkerResult | undefined {
  if (!text) return undefined;
  try {
    const r = normalizeResult(JSON.parse(text.trim()));
    if (r) return r;
  } catch {
    /* not pure JSON */
  }
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!);
  // Balanced-brace scan for bare objects.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        candidates.push(text.slice(i, j + 1));
        break;
      }
    }
  }
  for (const c of candidates.reverse()) {
    try {
      const r = normalizeResult(JSON.parse(c));
      if (r) return r;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

const RATE_RE = /(rate[ _-]?limit|usage limit|quota|resource[ _-]?exhausted|\b429\b|too many requests|limit (has been )?reached|out of credits|try again (in|later|at))/i;

export function isRateLimited(text: string): boolean {
  return RATE_RE.test(text);
}

export function retryAfterMs(text: string): number | undefined {
  const m = text.match(/(?:try again|retry|resets?)\s+(?:in|after)\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase()[0];
  const mult = u === 's' ? 1e3 : u === 'm' ? 6e4 : u === 'h' ? 36e5 : 864e5;
  return Math.round(n * mult);
}

/** Rough token estimate when a CLI reports no usage (4 chars ≈ 1 token). */
export function estimateUsage(inputChars: number, outputChars: number): Usage {
  return { input: Math.ceil(inputChars / 4), output: Math.ceil(outputChars / 4), estimated: true };
}

const IN_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokenCount', 'prompt', 'input'];
const OUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'candidatesTokenCount', 'candidates', 'output'];

/** Reads {input, output} from one usage-like object, or undefined if it is not one. */
export function usageFrom(o: unknown): { input: number; output: number } | undefined {
  if (typeof o !== 'object' || o === null) return undefined;
  const r = o as Record<string, unknown>;
  const i = IN_KEYS.map((k) => r[k]).find((v) => typeof v === 'number') as number | undefined;
  const out = OUT_KEYS.map((k) => r[k]).find((v) => typeof v === 'number') as number | undefined;
  if (i === undefined && out === undefined) return undefined;
  return { input: i ?? 0, output: out ?? 0 };
}

/** Depth-first search for the first object under a key named usage/tokens/stats that carries token counts. */
export function findUsage(v: unknown, depth = 0): { input: number; output: number } | undefined {
  if (depth > 8 || typeof v !== 'object' || v === null) return undefined;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    if (/^(usage|tokens|token_usage|usageMetadata)$/i.test(k)) {
      const u = usageFrom(child);
      if (u) return u;
    }
  }
  for (const child of Object.values(v as Record<string, unknown>)) {
    const u = findUsage(child, depth + 1);
    if (u) return u;
  }
  return undefined;
}
