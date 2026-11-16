// Reads AWS CLI commands out of a shell command line.

import type { FoundResource } from '../report.ts';
import { isRegion } from '../prices.ts';

// ─── Shell splitting ─────────────────────────────────────────────────────────

/** Splits a command line into simple commands (on && || ; | and newlines), each a list of words. */
export function splitCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => { if (has) words.push(word); word = ''; has = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) word += line[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < line.length) {
      if (line[i + 1] === '\n') i++;                 // line continuation
      else { word += line[++i]; has = true; }
    }
    else if (c === ' ' || c === '\t') endWord();
    else if (c === '\n' || c === ';') endCommand();
    else if (c === '&' || c === '|') { endCommand(); if (line[i + 1] === c) i++; }
    else { word += c; has = true; }
  }
  endCommand();
  return commands;
}

// ─── One aws command ─────────────────────────────────────────────────────────

export interface AwsCommand {
  service: string;
  operation: string;
  /** --option → its values ([] for a bare flag). */
  options: Map<string, string[]>;
  region?: string;
  text: string;
}

const GLOBAL_FLAGS = new Set(['--debug', '--no-verify-ssl', '--no-paginate', '--no-sign-request', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-auto-prompt']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Words that only wrap the real command: `sudo aws …`, `npx cdk deploy`, `pnpm exec cdk deploy`.
const WRAPPERS = new Set(['sudo', 'env', 'command', 'time', 'npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'exec', 'dlx', '--']);
const isPrefix = (w: string): boolean => ASSIGNMENT.test(w) || WRAPPERS.has(w);

/** Parses the words of one simple command if it is an `aws` call. */
export function parseAwsCommand(words: string[]): AwsCommand | null {
  let i = 0;
  let envRegion: string | undefined;
  while (i < words.length && isPrefix(words[i])) {
    const m = words[i].match(/^AWS_(?:DEFAULT_)?REGION=(.+)$/);
    if (m) envRegion = m[1];
    i++;
  }
  const exe = words[i]?.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  if (exe !== 'aws' && exe !== 'aws.exe' && exe !== 'aws.cmd') return null;
  i++;

  const positional: string[] = [];
  const options = new Map<string, string[]>();
  let current: string[] | null = null;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq > 0 ? w.slice(0, eq) : w;
      current = options.get(name) ?? [];
      options.set(name, current);
      if (eq > 0) current.push(w.slice(eq + 1));
      if (GLOBAL_FLAGS.has(name)) current = null;
    } else if (current && (positional.length >= 2 || current.length === 0)) {
      current.push(w);
      // Before the service and operation are known, an option takes one value at most.
      if (positional.length < 2) current = null;
    } else {
      positional.push(w);
    }
  }
  if (positional.length < 2) return null;
  const region = options.get('--region')?.[0] ?? envRegion;
  return { service: positional[0], operation: positional[1], options, region, text: words.join(' ') };
}

// ─── Option helpers ──────────────────────────────────────────────────────────

const first = (c: AwsCommand, name: string): string | undefined => c.options.get(name)?.[0];
const all = (c: AwsCommand, name: string): string => (c.options.get(name) ?? []).join(' ');
const has = (c: AwsCommand, name: string): boolean => c.options.has(name);
const int = (s: string | undefined): number | undefined => {
  const n = s === undefined ? NaN : parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
};
/** A key's value in either JSON ({"VolumeSize": 100}) or shorthand (VolumeSize=100) form. */
function field(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`["']?${key}["']?\\s*[=:]\\s*["']?([A-Za-z0-9_.:-]+)`, 'i'));
  return m?.[1];
}
/** Values that come from a file, a shell variable or a command can't be read here. */
const opaque = (s: string | undefined): boolean => !!s && /^(file|fileb):\/\/|[$`]/.test(s);

// ─── Launch commands → resources ─────────────────────────────────────────────

type Found = Omit<FoundResource, 'name' | 'region'>;
const unreadable = (why: string): Found => ({ unreadable: why });

const LAUNCHES: Record<string, (c: AwsCommand) => Found | null> = {
  'ec2 run-instances': (c) => {
    const instanceType = first(c, '--instance-type');
    if (!instanceType) {
      return unreadable(has(c, '--launch-template')
        ? 'the instance type comes from a launch template'
        : 'no --instance-type given (AWS would use the account or launch template default)');
    }
    if (opaque(instanceType)) return unreadable('the instance type is a variable');
    const counts = (first(c, '--count') ?? '1').split(':').map((n) => int(n) ?? 1);
    const bdm = all(c, '--block-device-mappings');
    return {
      config: {
        type: 'EC2', instanceType,
        count: Math.max(...counts), // "min:max" can launch up to max
        rootVolumeSize: int(field(bdm, 'VolumeSize')),
        rootVolumeType: field(bdm, 'VolumeType'),
        market: /spot/i.test(all(c, '--instance-market-options')) ? 'spot' : undefined,
      },
    };
  },
  'ec2 create-volume': (c) => {
    const size = int(first(c, '--size'));
    if (size === undefined) return unreadable('no --size given (the size comes from a snapshot)');
    return { config: { type: 'EBS', size, volumeType: first(c, '--volume-type') ?? 'gp2', iops: int(first(c, '--iops')), throughput: int(first(c, '--throughput')) } };
  },
  'ec2 create-nat-gateway': () => ({ config: { type: 'NAT_GATEWAY' } }),
  'rds create-db-instance': (c) => {
    const instanceClass = first(c, '--db-instance-class');
    const engine = first(c, '--engine');
    if (!instanceClass || !engine || opaque(instanceClass) || opaque(engine)) return unreadable('the instance class or engine could not be read');
    return {
      config: {
        type: 'RDS', instanceClass, engine,
        allocatedStorage: int(first(c, '--allocated-storage')),
        multiAZ: has(c, '--multi-az'),
        iops: int(first(c, '--iops')),
      },
    };
  },
  'rds create-db-cluster': (c) => {
    const engine = first(c, '--engine') ?? 'aurora';
    const serverless = first(c, '--engine-mode') === 'serverless' || has(c, '--serverless-v2-scaling-configuration');
    if (serverless) return { config: { type: 'RDS_AURORA', engine, engineMode: 'serverless' } };
    return unreadable('the cluster itself has no hourly charge; its instances are priced when they are created');
  },
  'elasticache create-cache-cluster': (c) => {
    const cacheNodeType = first(c, '--cache-node-type');
    if (!cacheNodeType || opaque(cacheNodeType)) return unreadable('the node type could not be read');
    return { config: { type: 'ELASTICACHE', cacheNodeType, numCacheNodes: int(first(c, '--num-cache-nodes')) ?? 1 } };
  },
  'elasticache create-replication-group': (c) => {
    const cacheNodeType = first(c, '--cache-node-type');
    if (!cacheNodeType || opaque(cacheNodeType)) return unreadable('the node type could not be read');
    const nodes = int(first(c, '--num-cache-clusters'))
      ?? (int(first(c, '--num-node-groups')) ?? 1) * ((int(first(c, '--replicas-per-node-group')) ?? 0) + 1);
    return { config: { type: 'ELASTICACHE', cacheNodeType, numCacheNodes: nodes } };
  },
  'redshift create-cluster': (c) => {
    const nodeType = first(c, '--node-type');
    if (!nodeType || opaque(nodeType)) return unreadable('the node type could not be read');
    return { config: { type: 'REDSHIFT', nodeType, numberOfNodes: int(first(c, '--number-of-nodes')) ?? 1 } };
  },
  'eks create-cluster': () => ({ config: { type: 'EKS', kind: 'cluster' } }),
  'eks create-nodegroup': (c) => {
    const types = c.options.get('--instance-types') ?? [];
    if (types.some(opaque)) return unreadable('the instance types are variables');
    const scaling = all(c, '--scaling-config');
    return {
      config: {
        type: 'EKS', kind: 'nodegroup',
        instanceTypes: types.length ? types.flatMap((t) => t.split(',')) : ['t3.medium'],
        desiredSize: int(field(scaling, 'desiredSize')) ?? int(field(scaling, 'minSize')) ?? 2,
      },
    };
  },
  'sagemaker create-notebook-instance': (c) => {
    const instanceType = first(c, '--instance-type');
    if (!instanceType || opaque(instanceType)) return unreadable('the instance type could not be read');
    return { config: { type: 'SAGEMAKER', instanceType, volumeSizeInGB: int(first(c, '--volume-size-in-gb')) } };
  },
  'sagemaker create-endpoint-config': () => unreadable('SageMaker endpoints are not priced yet'),
  's3api create-bucket': () => ({ config: { type: 'S3' } }),
  's3 mb': () => ({ config: { type: 'S3' } }),
};

/** Infrastructure deployments whose contents can't be seen from the command. */
const IAC_AWS: Record<string, string> = {
  'cloudformation deploy': 'a CloudFormation deployment',
  'cloudformation create-stack': 'a CloudFormation stack',
  'cloudformation update-stack': 'a CloudFormation stack update',
  'cloudformation execute-change-set': 'a CloudFormation change set',
};

export interface CommandScan {
  /** Launches found, priced or not. */
  resources: FoundResource[];
  /** Deployments whose resources can't be seen from the command, e.g. "terraform apply". */
  deployments: string[];
}

/** Everything in a shell command line that would create AWS resources. */
export function scanCommandLine(line: string, defaultRegion: string): CommandScan {
  const scan: CommandScan = { resources: [], deployments: [] };
  for (const words of splitCommands(line)) {
    const exe = words.find((w) => !isPrefix(w))?.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    const rest = words.join(' ');

    if (/^(terraform|tofu|terragrunt)(\.exe)?$/.test(exe) && /\s(apply|run-all apply)\b/.test(rest) && !/\s-destroy\b/.test(rest)) {
      scan.deployments.push(`${exe.replace('.exe', '')} apply`);
    } else if (/^cdk(\.cmd)?$/.test(exe) && /\sdeploy\b/.test(rest)) scan.deployments.push('cdk deploy');
    else if (/^pulumi(\.exe)?$/.test(exe) && /\sup\b/.test(rest)) scan.deployments.push('pulumi up');
    else if (/^sam(\.cmd)?$/.test(exe) && /\sdeploy\b/.test(rest)) scan.deployments.push('sam deploy');

    const cmd = parseAwsCommand(words);
    if (!cmd || cmd.options.has('--dry-run') || cmd.options.has('--generate-cli-skeleton')) continue;
    const key = `${cmd.service} ${cmd.operation}`;
    if (IAC_AWS[key]) { scan.deployments.push(`aws ${key}`); continue; }
    const launch = LAUNCHES[key];
    if (!launch) continue;

    const region = cmd.region && isRegion(cmd.region) ? cmd.region : defaultRegion;
    const found = cmd.options.has('--cli-input-json') || cmd.options.has('--cli-input-yaml')
      ? unreadable('its settings come from an input file')
      : launch(cmd);
    if (found) scan.resources.push({ name: `aws ${key}`, region, ...found });
  }
  return scan;
}
