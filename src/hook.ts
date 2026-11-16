// The gate: a PreToolUse hook on Bash.
//
// Before Claude runs a command that launches AWS resources, this prices the
// launch and, if the monthly estimate may exceed your limit, asks you first.
// It can only add a question. It never approves a command for you, never
// blocks one outright, and on any error it steps aside (exit 0, no output).

import { readSettings, recentEstimate, type Settings } from './config.ts';
import { scanCommandLine } from './inputs/aws-cli.ts';
import { buildReport, range, usd } from './report.ts';

const WORTH_A_LOOK = /\b(aws|terraform|tofu|terragrunt|cdk|pulumi|sam)(\.exe|\.cmd)?\b/i;

/** The question to put to the user, or null to stay out of the way. */
export async function decide(command: string, cwd: string, settings: Settings): Promise<string | null> {
  if (!WORTH_A_LOOK.test(command)) return null;
  const scan = scanCommandLine(command, settings.defaultRegion);
  if (!scan.resources.length && !scan.deployments.length) return null;

  const limit = `your limit is ${usd(settings.monthlyLimitUsd)}/month`;
  const parts: string[] = [];

  if (scan.resources.length) {
    const report = await buildReport(scan.resources);
    const priced = report.lines.filter((l) => l.estimate);
    if (priced.length && report.totalHigh > settings.monthlyLimitUsd) {
      const what = priced.map((l) => `${l.estimate!.summary} in ${l.region}`).join('; ');
      const excludes = [...new Set(priced.flatMap((l) => l.estimate!.excludes))].join(', ');
      parts.push(`This would launch ${what}: about ${range(report.totalLow, report.totalHigh)}/month at on-demand list prices (${limit}). Not included: ${excludes}. ${report.priceNote}`);
    }
    if (report.unpricedCount && settings.askWhenUnpriced) {
      const why = report.lines.filter((l) => l.unpriced).map((l) => `${l.name} (${l.unpriced!.reason})`).join('; ');
      parts.push(`This launches AWS resources that could not be priced: ${why}.`);
    }
  }

  if (scan.deployments.length && settings.askWhenUnpriced) {
    const names = [...new Set(scan.deployments)].join(' and ');
    const recent = recentEstimate(cwd);
    if (!recent) {
      parts.push(`${names} can create AWS resources, and their cost can't be read from the command. To see the cost first, use the aws-cost-estimate skill on the plan or template.`);
    } else if (recent.totalHigh > settings.monthlyLimitUsd) {
      parts.push(`${names}: the estimate made a few minutes ago came to about ${range(recent.totalLow, recent.totalHigh)}/month (${limit}).`);
    } else if (recent.unpricedCount) {
      parts.push(`${names}: the estimate made a few minutes ago left ${recent.unpricedCount} resource${recent.unpricedCount === 1 ? '' : 's'} unpriced.`);
    }
  }

  return parts.length ? `AWS cost check. ${parts.join(' ')}` : null;
}

async function main(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input?.tool_name !== 'Bash' || typeof input?.tool_input?.command !== 'string') return;

  const reason = await decide(input.tool_input.command, typeof input.cwd === 'string' ? input.cwd : process.cwd(), readSettings());
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  }));
}

// Run only as a script (tests import decide()).
if (process.argv[1] && /hook\.(cjs|ts)$/.test(process.argv[1])) {
  main().catch(() => { /* fail open */ }).finally(() => { process.exitCode = 0; });
}
