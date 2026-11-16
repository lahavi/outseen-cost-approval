// The plugin's settings (userConfig in plugin.json), as Claude Code passes them
// to hook processes, plus the note the estimate CLI leaves for the gate.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, isRegion } from './prices.ts';

export interface Settings {
  /** Ask before a launch whose monthly estimate may exceed this (USD). */
  monthlyLimitUsd: number;
  /** Region used when a command or template doesn't name one. */
  defaultRegion: string;
  /** Also ask when a launch or deployment can't be priced from the command. */
  askWhenUnpriced: boolean;
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const limit = Number(env.CLAUDE_PLUGIN_OPTION_MONTHLY_LIMIT_USD);
  const region = [env.AWS_REGION, env.AWS_DEFAULT_REGION, env.CLAUDE_PLUGIN_OPTION_DEFAULT_REGION]
    .find((r): r is string => !!r && isRegion(r));
  return {
    monthlyLimitUsd: Number.isFinite(limit) && limit >= 0 && env.CLAUDE_PLUGIN_OPTION_MONTHLY_LIMIT_USD !== '' && env.CLAUDE_PLUGIN_OPTION_MONTHLY_LIMIT_USD !== undefined ? limit : 100,
    defaultRegion: region ?? 'us-east-1',
    askWhenUnpriced: (env.CLAUDE_PLUGIN_OPTION_ASK_WHEN_UNPRICED ?? 'true').toLowerCase() !== 'false',
  };
}

// ─── The last estimate, so the gate doesn't ask about what was just priced ───

export interface LastEstimate {
  cwd: string;
  at: number;
  totalLow: number;
  totalHigh: number;
  unpricedCount: number;
}

const RECENT_MS = 30 * 60_000;
const file = () => path.join(dataDir(), 'last-estimate.json');

export function saveLastEstimate(e: Omit<LastEstimate, 'at'>): void {
  try { fs.writeFileSync(file(), JSON.stringify({ ...e, at: Date.now() })); } catch { /* best-effort */ }
}

/** The estimate made in this folder in the last 30 minutes, if any. */
export function recentEstimate(cwd: string): LastEstimate | null {
  try {
    const e = JSON.parse(fs.readFileSync(file(), 'utf8')) as LastEstimate;
    const same = path.resolve(e.cwd).toLowerCase() === path.resolve(cwd).toLowerCase();
    return same && Date.now() - e.at < RECENT_MS ? e : null;
  } catch {
    return null;
  }
}
