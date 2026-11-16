// Estimate CLI, used by the aws-cost-estimate skill.
//
//   node cli.js estimate --command "aws ec2 run-instances --instance-type r6g.4xlarge"
//   node cli.js estimate --terraform-plan plan.json      (from: terraform show -json tfplan)
//   node cli.js estimate --cloudformation template.yaml
//   options: --region <region>   default region when the input doesn't name one
//            --json              machine-readable output

import fs from 'node:fs';
import { readSettings, saveLastEstimate } from './config.ts';
import { scanCommandLine } from './inputs/aws-cli.ts';
import { parseTemplate, scanCloudFormation } from './inputs/cloudformation.ts';
import { scanTerraformPlan } from './inputs/terraform-plan.ts';
import { isRegion } from './prices.ts';
import { buildReport, toMarkdown, usd, type FoundResource } from './report.ts';

const USAGE = `Usage:
  estimate --command "<aws cli command>"
  estimate --terraform-plan <plan.json | ->     JSON from: terraform show -json <planfile>
  estimate --cloudformation <template file>
Options:
  --region <region>   region to assume when the input doesn't name one
  --json              print JSON instead of a table`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

const readInput = (file: string): string => (file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'));

async function main(argv: string[]): Promise<void> {
  if (argv[0] !== 'estimate') fail(argv.length ? `Unknown command: ${argv[0]}` : 'No command given.');
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const settings = readSettings();
  const regionArg = opt('--region');
  if (regionArg && !isRegion(regionArg)) fail(`Not an AWS region: ${regionArg}`);
  const region = regionArg ?? settings.defaultRegion;

  let found: FoundResource[] = [];
  let notCovered: Record<string, number> = {};
  let deployments: string[] = [];

  const command = opt('--command');
  const planFile = opt('--terraform-plan');
  const templateFile = opt('--cloudformation');
  if (command !== undefined) {
    const scan = scanCommandLine(command, region);
    found = scan.resources;
    deployments = scan.deployments;
  } else if (planFile !== undefined) {
    let plan: any;
    try { plan = JSON.parse(readInput(planFile)); } catch (e: any) {
      fail(`Could not read ${planFile} as JSON (${e.message}). Create it with: terraform show -json <planfile> > plan.json`);
    }
    if (!Array.isArray(plan?.resource_changes)) fail('This JSON has no resource_changes. Create it with: terraform show -json <planfile>');
    ({ resources: found, notCovered } = scanTerraformPlan(plan, region));
  } else if (templateFile !== undefined) {
    let template: any;
    try { template = parseTemplate(readInput(templateFile)); } catch (e: any) {
      fail(`Could not read ${templateFile} as JSON or YAML (${e.message}).`);
    }
    if (!template?.Resources) fail('This template has no Resources section.');
    ({ resources: found, notCovered } = scanCloudFormation(template, region));
  } else {
    fail('Give one of --command, --terraform-plan or --cloudformation.');
  }

  const report = await buildReport(found);
  if (found.length) {
    saveLastEstimate({ cwd: process.cwd(), totalLow: report.totalLow, totalHigh: report.totalHigh, unpricedCount: report.unpricedCount });
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...report, notCovered, deployments, monthlyLimitUsd: settings.monthlyLimitUsd }, null, 2)}\n`);
    return;
  }

  const out: string[] = [];
  if (!found.length) {
    out.push(deployments.length
      ? `${deployments.join(', ')} deploys infrastructure whose resources can't be read from the command. Estimate the Terraform plan or the template instead.`
      : 'Nothing here creates an AWS resource this tool prices.');
  } else {
    out.push(toMarkdown(report));
    if (report.totalHigh > settings.monthlyLimitUsd) out.push(`This is over the monthly limit of ${usd(settings.monthlyLimitUsd)} set for this plugin.`);
  }
  const others = Object.entries(notCovered);
  if (others.length) {
    out.push(`Also being created, and not priced by this tool: ${others.map(([t, n]) => (n > 1 ? `${t} × ${n}` : t)).join(', ')}. Some of these cost money (load balancers, Lambda, DynamoDB, data transfer); many are free (IAM, security groups).`);
  }
  process.stdout.write(`${out.join('\n\n')}\n`);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`Estimate failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
