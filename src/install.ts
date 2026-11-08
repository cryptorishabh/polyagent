import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { ADAPTERS } from './adapters/index.ts';
import { resolveBinary, spawnPlan } from './proc.ts';
import type { ProviderId } from './types.ts';

export interface InstallOption {
  /** Shown to the user exactly as it will run. */
  display: string;
  /** Tool that must already exist (npm, winget, curl...). */
  needs: string;
  cmd: string;
  args: string[];
}

export interface Recipe {
  name: string;
  /** What to do after installing. */
  signIn: string;
  docs: string;
  /** Shown before asking (e.g. account limitations). */
  warning?: string;
  options: (platform: NodeJS.Platform) => InstallOption[];
}

const npm = (pkg: string): InstallOption => ({ display: `npm install -g ${pkg}`, needs: 'npm', cmd: 'npm', args: ['install', '-g', pkg] });

/** Official sources only: each vendor's npm package, winget id or install script. */
export const RECIPES: Record<ProviderId, Recipe> = {
  codex: {
    name: 'OpenAI Codex CLI',
    signIn: 'codex login',
    docs: 'https://developers.openai.com/codex',
    options: () => [npm('@openai/codex')],
  },
  agy: {
    name: 'Google Antigravity CLI (agy)',
    signIn: 'run agy once and sign in with your Google account',
    docs: 'https://antigravity.google',
    options: (pl) =>
      pl === 'win32'
        ? [{ display: 'winget install --id Google.AntigravityCLI --exact', needs: 'winget', cmd: 'winget', args: ['install', '--id', 'Google.AntigravityCLI', '--exact', '--accept-source-agreements', '--accept-package-agreements'] }]
        : [{ display: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', needs: 'curl', cmd: 'bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] }],
  },
  gemini: {
    name: 'Google Gemini CLI',
    signIn: 'run gemini once and sign in, or set GEMINI_API_KEY',
    docs: 'https://github.com/google-gemini/gemini-cli',
    warning: 'Google no longer accepts personal Google accounts in Gemini CLI. It is only useful with a GEMINI_API_KEY or a company/Workspace account; on a personal Google AI plan, use agy instead.',
    options: () => [npm('@google/gemini-cli')],
  },
  claude: {
    name: 'Claude Code',
    signIn: 'run claude once and sign in',
    docs: 'https://claude.com/claude-code',
    options: () => [npm('@anthropic-ai/claude-code')],
  },
};

export type PlanItem =
  | { provider: ProviderId; state: 'installed'; path: string }
  | { provider: ProviderId; state: 'installable'; option: InstallOption }
  | { provider: ProviderId; state: 'skip'; reason: string };

/** Pure: decides, per provider, whether it is installed, installable here, or must be skipped. */
export function planInstall(providers: ProviderId[], has: (bin: string) => string | undefined, platform: NodeJS.Platform = process.platform): PlanItem[] {
  return providers.map((p): PlanItem => {
    const found = has(ADAPTERS[p].binary);
    if (found) return { provider: p, state: 'installed', path: found };
    const opt = RECIPES[p].options(platform).find((o) => has(o.needs));
    if (opt) return { provider: p, state: 'installable', option: opt };
    const needs = RECIPES[p].options(platform).map((o) => o.needs).join(' or ');
    return { provider: p, state: 'skip', reason: `no ${needs} on this machine; install by hand from ${RECIPES[p].docs}` };
  });
}

export interface InstallOpts {
  yes: boolean;
  dryRun: boolean;
  interactive: boolean;
  out?: (s: string) => void;
  ask?: (q: string) => Promise<boolean>;
  /** Test hook: replaces actually running the installer. */
  exec?: (o: InstallOption) => number;
  /** Test hook: replaces looking up binaries on PATH. */
  has?: (bin: string) => string | undefined;
}

async function ttyAsk(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function execOption(o: InstallOption): number {
  const bin = resolveBinary(o.cmd) ?? o.cmd;
  const plan = spawnPlan(bin, o.args);
  const r = spawnSync(plan.file, plan.args, { stdio: 'inherit', windowsVerbatimArguments: plan.verbatim, windowsHide: false });
  return r.status ?? 1;
}

export interface InstallReport {
  provider: ProviderId;
  result: 'already-installed' | 'installed' | 'failed' | 'declined' | 'skipped' | 'would-install';
  detail: string;
}

/** Offers each missing CLI's official installer. Never installs without a yes (prompt or --yes). */
export async function installClis(providers: ProviderId[], o: InstallOpts): Promise<InstallReport[]> {
  const out = o.out ?? ((s: string) => process.stderr.write(s + '\n'));
  const ask = o.ask ?? ttyAsk;
  const exec = o.exec ?? execOption;
  const has = o.has ?? ((b: string) => resolveBinary(b));
  const reports: InstallReport[] = [];
  for (const item of planInstall(providers, has)) {
    const r = RECIPES[item.provider];
    if (item.state === 'installed') {
      reports.push({ provider: item.provider, result: 'already-installed', detail: item.path });
      continue;
    }
    if (item.state === 'skip') {
      out(`· ${r.name}: not installed and can't be installed automatically (${item.reason}). Skipping it; polyagent works without it.`);
      reports.push({ provider: item.provider, result: 'skipped', detail: item.reason });
      continue;
    }
    out(`\n${r.name} is not installed.`);
    if (r.warning) out(`  note: ${r.warning}`);
    out(`  official install command: ${item.option.display}`);
    if (o.dryRun) {
      reports.push({ provider: item.provider, result: 'would-install', detail: item.option.display });
      continue;
    }
    const go = o.yes || (o.interactive && (await ask(`  Install ${r.name} now?`)));
    if (!go) {
      out(o.interactive ? `  skipped. polyagent will route work to the other tools.` : `  skipped (no terminal to ask; re-run with --yes to install).`);
      reports.push({ provider: item.provider, result: 'declined', detail: item.option.display });
      continue;
    }
    const code = exec(item.option);
    const now = has(ADAPTERS[item.provider].binary);
    if (code === 0 && now) {
      out(`  installed: ${now}\n  next: ${r.signIn}`);
      reports.push({ provider: item.provider, result: 'installed', detail: now });
    } else if (code === 0) {
      out(`  the installer finished, but ${ADAPTERS[item.provider].binary} isn't on PATH yet. Open a new terminal, then run polyagent doctor.`);
      reports.push({ provider: item.provider, result: 'installed', detail: 'restart terminal to pick up PATH' });
    } else {
      out(`  install failed (exit ${code}). Skipping it; see ${r.docs}`);
      reports.push({ provider: item.provider, result: 'failed', detail: `exit ${code}` });
    }
  }
  return reports;
}
