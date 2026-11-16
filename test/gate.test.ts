import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data folder, and no network: these tests use the built-in price tables.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-approval-test-'));
process.env.CLAUDE_PLUGIN_DATA = DATA;
process.env.OUTSEEN_PRICES_OFFLINE = '1';
delete process.env.AWS_REGION;
delete process.env.AWS_DEFAULT_REGION;

const { readSettings, recentEstimate, saveLastEstimate } = await import('../src/config.ts');
const { decide } = await import('../src/hook.ts');
const { loadPriceBook } = await import('../src/prices.ts');
const { parseCsvLine } = await import('../scripts/build-prices.ts');

const SETTINGS = { monthlyLimitUsd: 100, defaultRegion: 'us-east-1', askWhenUnpriced: true };
const CWD = path.join(DATA, 'project');

before(() => { try { fs.rmSync(path.join(DATA, 'last-estimate.json')); } catch { /* none */ } });

// ─── Settings ────────────────────────────────────────────────────────────────

test('settings: defaults, plugin options, and AWS_REGION ahead of the configured region', () => {
  assert.deepEqual(readSettings({}), { monthlyLimitUsd: 100, defaultRegion: 'us-east-1', askWhenUnpriced: true });
  assert.deepEqual(readSettings({
    CLAUDE_PLUGIN_OPTION_MONTHLY_LIMIT_USD: '250', CLAUDE_PLUGIN_OPTION_DEFAULT_REGION: 'eu-west-1', CLAUDE_PLUGIN_OPTION_ASK_WHEN_UNPRICED: 'false',
  }), { monthlyLimitUsd: 250, defaultRegion: 'eu-west-1', askWhenUnpriced: false });
  assert.equal(readSettings({ AWS_REGION: 'ap-south-1', CLAUDE_PLUGIN_OPTION_DEFAULT_REGION: 'eu-west-1' }).defaultRegion, 'ap-south-1');
  assert.equal(readSettings({ CLAUDE_PLUGIN_OPTION_MONTHLY_LIMIT_USD: '0' }).monthlyLimitUsd, 0);
  assert.equal(readSettings({ CLAUDE_PLUGIN_OPTION_MONTHLY_LIMIT_USD: 'lots', CLAUDE_PLUGIN_OPTION_DEFAULT_REGION: '../etc' }).monthlyLimitUsd, 100);
  assert.equal(readSettings({ CLAUDE_PLUGIN_OPTION_DEFAULT_REGION: '../etc' }).defaultRegion, 'us-east-1');
});

// ─── The gate's decisions ────────────────────────────────────────────────────

test('a launch over the limit asks, with the range, the limit, what is left out and the price source', async () => {
  const q = await decide('aws ec2 run-instances --image-id ami-1 --instance-type r6g.4xlarge --count 2', CWD, SETTINGS);
  assert.match(q!, /^AWS cost check\. This would launch r6g\.4xlarge × 2, 20GB gp3 root volume in us-east-1: about \$[\d,]+–\$[\d,]+\/month at on-demand list prices \(your limit is \$100\/month\)/);
  assert.match(q!, /Not included: data transfer/);
  assert.match(q!, /Prices: built-in us-east-1 list prices/);
});

test('a launch under the limit, and commands that launch nothing, pass silently', async () => {
  assert.equal(await decide('aws ec2 run-instances --image-id ami-1 --instance-type t3.micro', CWD, SETTINGS), null);
  assert.equal(await decide('aws ec2 describe-instances', CWD, SETTINGS), null);
  assert.equal(await decide('npm test && git status', CWD, SETTINGS), null);
  assert.equal(await decide('terraform plan -out tfplan', CWD, SETTINGS), null);
});

test('the limit is compared with the high end of the range', async () => {
  // t3.large: about $62/month point estimate, MEDIUM range up to about $93.
  const cmd = 'aws ec2 run-instances --instance-type t3.large';
  assert.equal(await decide(cmd, CWD, { ...SETTINGS, monthlyLimitUsd: 95 }), null);
  assert.match((await decide(cmd, CWD, { ...SETTINGS, monthlyLimitUsd: 90 }))!, /your limit is \$90\.00\/month/);
});

test('launches that cannot be priced ask, unless that is switched off', async () => {
  const cmd = 'aws ec2 run-instances --launch-template LaunchTemplateName=web';
  assert.match((await decide(cmd, CWD, SETTINGS))!, /could not be priced: aws ec2 run-instances \(the instance type comes from a launch template\)/);
  assert.equal(await decide(cmd, CWD, { ...SETTINGS, askWhenUnpriced: false }), null);
});

test('terraform apply asks until an estimate under the limit was made in the same folder', async () => {
  const cmd = 'terraform apply -auto-approve';
  assert.match((await decide(cmd, CWD, SETTINGS))!, /terraform apply can create AWS resources.*aws-cost-estimate skill/);
  assert.equal(await decide(cmd, CWD, { ...SETTINGS, askWhenUnpriced: false }), null);

  saveLastEstimate({ cwd: CWD, totalLow: 40, totalHigh: 60, unpricedCount: 0 });
  assert.equal(await decide(cmd, CWD, SETTINGS), null);
  assert.match((await decide(cmd, path.join(DATA, 'elsewhere'), SETTINGS))!, /can create AWS resources/);

  saveLastEstimate({ cwd: CWD, totalLow: 900, totalHigh: 1200, unpricedCount: 0 });
  assert.match((await decide(cmd, CWD, SETTINGS))!, /estimate made a few minutes ago came to about \$900–\$1,200\/month/);

  saveLastEstimate({ cwd: CWD, totalLow: 10, totalHigh: 20, unpricedCount: 2 });
  assert.match((await decide(cmd, CWD, SETTINGS))!, /left 2 resources unpriced/);

  // An old estimate no longer counts.
  fs.writeFileSync(path.join(DATA, 'last-estimate.json'), JSON.stringify({ cwd: CWD, at: Date.now() - 31 * 60_000, totalLow: 1, totalHigh: 2, unpricedCount: 0 }));
  assert.equal(recentEstimate(CWD), null);
  fs.rmSync(path.join(DATA, 'last-estimate.json'));
});

// ─── The built hook and CLI, as Claude Code runs them ────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, CLAUDE_PLUGIN_DATA: DATA, OUTSEEN_PRICES_OFFLINE: '1' };
const runHook = (input: string) => spawnSync(process.execPath, [path.join(ROOT, 'dist/hook.cjs')], { input, env, encoding: 'utf8' });
const hookInput = (command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: CWD, tool_input: { command } });

test('dist/hook.cjs: asks with valid hook JSON, stays silent otherwise, and never fails', () => {
  const ask = runHook(hookInput('aws rds create-db-instance --db-instance-class db.r6g.4xlarge --engine postgres --allocated-storage 500 --multi-az'));
  assert.equal(ask.status, 0);
  const out = JSON.parse(ask.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /db\.r6g\.4xlarge \(postgres\) Multi-AZ, 500GB storage/);

  for (const input of [hookInput('aws s3 ls'), hookInput('ls -la'), 'not json', '', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'x' } })]) {
    const r = runHook(input);
    assert.deepEqual([r.status, r.stdout], [0, ''], input);
  }
});

test('dist/hook.cjs never answers "allow" or "deny"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dist/hook.cjs'), 'utf8');
  assert.equal(/permissionDecision:"(allow|deny)"/.test(src), false);
});

test('dist/cli.cjs: estimates a command, a Terraform plan and a template, and records the estimate', () => {
  const run = (args: string[], input?: string) => execFileSync(process.execPath, [path.join(ROOT, 'dist/cli.cjs'), ...args], { env, input, encoding: 'utf8', cwd: DATA });

  const cmd = run(['estimate', '--command', 'aws ec2 run-instances --instance-type m5.large --count 3']);
  assert.match(cmd, /\| aws ec2 run-instances: m5\.large × 3, 20GB gp3 root volume \| us-east-1 \| about \$/);
  assert.match(cmd, /\*\*Total: about \$[\d,.]+–\$[\d,.]+ a month\*\*/);
  assert.match(cmd, /over the monthly limit of \$100/);
  assert.ok(recentEstimate(DATA));

  const plan = JSON.stringify({ resource_changes: [
    { address: 'aws_instance.web', mode: 'managed', type: 'aws_instance', change: { actions: ['create'], after: { instance_type: 't3.micro' } } },
    { address: 'aws_lb.front', mode: 'managed', type: 'aws_lb', change: { actions: ['create'], after: {} } },
  ] });
  const tf = run(['estimate', '--terraform-plan', '-', '--region', 'eu-west-1'], plan);
  assert.match(tf, /aws_instance\.web: t3\.micro × 1/);
  assert.match(tf, /not priced by this tool: aws_lb/);
  assert.doesNotMatch(tf, /over the monthly limit/);

  const file = path.join(DATA, 'template.yaml');
  fs.writeFileSync(file, 'Resources:\n  Db:\n    Type: AWS::RDS::DBInstance\n    Properties:\n      DBInstanceClass: db.m5.large\n      Engine: oracle-ee\n');
  const cfn = run(['estimate', '--cloudformation', file]);
  assert.match(cfn, /\| Db \| us-east-1 \| not priced \| no list price found/);
  assert.match(cfn, /1 resource was not priced/);

  const json = JSON.parse(run(['estimate', '--command', 'aws ec2 create-nat-gateway --subnet-id s', '--json']));
  assert.equal(json.lines[0].estimate.resourceType, 'NAT_GATEWAY');

  const bad = spawnSync(process.execPath, [path.join(ROOT, 'dist/cli.cjs'), 'estimate', '--terraform-plan', path.join(DATA, 'missing.json')], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /terraform show -json/);
});

// ─── Price files ─────────────────────────────────────────────────────────────

test('a cached price file is used, a broken or foreign one is not, and bad region names never reach the disk', async () => {
  const book = { version: 1, region: 'eu-west-1', asOf: '2026-11-14T01:29:26Z', ec2: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`m5.fake${i}`, 1])), rds: {}, elasticache: {}, redshift: {}, sagemaker: {} };
  fs.writeFileSync(path.join(DATA, 'prices-v1-eu-west-1.json'), JSON.stringify(book));
  assert.equal((await loadPriceBook('eu-west-1'))!.asOf, book.asOf);

  fs.writeFileSync(path.join(DATA, 'prices-v1-eu-west-2.json'), JSON.stringify(book)); // wrong region inside
  assert.equal(await loadPriceBook('eu-west-2'), null);
  fs.writeFileSync(path.join(DATA, 'prices-v1-eu-west-3.json'), '{ broken');
  assert.equal(await loadPriceBook('eu-west-3'), null);
  assert.equal(await loadPriceBook('../../etc/passwd'), null);
  assert.equal(await loadPriceBook('us-east-1'), null); // offline and not cached: built-in tables are used
  fs.rmSync(path.join(DATA, 'prices-v1-eu-west-1.json'));
});

test('parseCsvLine reads quoted, empty and escaped fields', () => {
  assert.deepEqual(parseCsvLine('"SKU","OnDemand",,"$0.10 per ""hour"", EU",,"Hrs"'), ['SKU', 'OnDemand', '', '$0.10 per "hour", EU', '', 'Hrs']);
  assert.deepEqual(parseCsvLine('a,b,'), ['a', 'b', '']);
});
