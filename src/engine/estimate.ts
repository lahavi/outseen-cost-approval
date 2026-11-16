// Monthly cost estimates for new AWS resources, at on-demand list prices.
// Extracted from Outseen's cost engine. Everything here is synchronous and
// offline: prices come from a PriceBook (today's AWS list prices for the
// region) when one is given, otherwise from the built-in tables.

import * as builtIn from './built-in-prices.ts';
import type { Confidence, CostEstimate, PriceBook, Priced, PriceSource, ResourceConfig } from './types.ts';

export const HOURS_PER_MONTH = 730;
const DISCOUNTS = 'Savings Plans, Reserved Instances and negotiated discounts';

// How far the real bill can plausibly land from the point estimate. Skewed
// upward: estimates leave out usage (transfer, requests), so surprises run high.
const RANGE: Record<Confidence, [number, number]> = {
  HIGH: [0.95, 1.15],
  MEDIUM: [0.8, 1.5],
  LOW: [0.5, 2.5],
};
const ORDER: Confidence[] = ['LOW', 'MEDIUM', 'HIGH'];
const weaker = (a: Confidence, b: Confidence): Confidence => ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))];
const round = (n: number) => Math.round(n * 100) / 100;

const SOURCE_CONFIDENCE: Record<PriceSource, Confidence> = {
  'aws-price-list': 'HIGH',
  'built-in': 'MEDIUM',
  'built-in-regional-estimate': 'LOW',
  'usage-assumption': 'LOW',
};

interface Quote { hourly: number; source: PriceSource }

function regionMultiplier(region: string): number {
  return builtIn.REGION_MULTIPLIER[region] ?? 1.1;
}

/**
 * Hourly price from the day's price list when there is one, else the built-in
 * table, else null (never a guess). A type missing from today's list is not
 * offered in that region, so the built-in table is not consulted for it.
 */
function quote(hasBook: boolean, fromBook: number | undefined, table: Record<string, number>, type: string, region: string): Quote | null {
  if (fromBook !== undefined && fromBook > 0) return { hourly: fromBook, source: 'aws-price-list' };
  if (hasBook) return null;
  const base = table[type];
  if (base === undefined) return null;
  return region === 'us-east-1'
    ? { hourly: base, source: 'built-in' }
    : { hourly: base * regionMultiplier(region), source: 'built-in-regional-estimate' };
}

// RDS engine names (CLI / Terraform / CloudFormation) → price book keys
function rdsEngineKey(engine: string): string {
  const e = engine.toLowerCase();
  if (e.startsWith('aurora-postgres')) return 'aurora-postgresql';
  if (e === 'aurora' || e.startsWith('aurora-mysql')) return 'aurora-mysql';
  if (e.startsWith('postgres')) return 'postgres';
  return e;
}

function finish(
  resourceType: CostEstimate['resourceType'], summary: string, breakdown: Record<string, number>,
  confidence: Confidence, priceSource: PriceSource, excludes: string[],
): CostEstimate {
  const monthly = round(Object.values(breakdown).reduce((s, v) => s + v, 0));
  const [lo, hi] = RANGE[confidence];
  const rounded: Record<string, number> = {};
  for (const [k, v] of Object.entries(breakdown)) if (v > 0) rounded[k] = round(v);
  return {
    resourceType, summary, monthly,
    monthlyLow: round(monthly * lo), monthlyHigh: round(monthly * hi),
    confidence, priceSource, breakdown: rounded,
    excludes: [...excludes, DISCOUNTS],
  };
}

const unknownType = (resourceType: CostEstimate['resourceType'], summary: string, what: string): Priced => ({
  unpriced: true, resourceType, summary, reason: `no list price found for ${what}`,
});

/** Estimate one resource. `book` is the day's price list for `region`, when available. */
export function estimateResource(config: ResourceConfig, region: string, book?: PriceBook | null): Priced {
  const b = book && book.region === region ? book : undefined;

  switch (config.type) {
    case 'EC2': {
      const count = Math.max(1, config.count ?? 1);
      const q = quote(!!b, b?.ec2[config.instanceType], builtIn.EC2, config.instanceType, region);
      if (!q) return unknownType('EC2', `${config.instanceType} × ${count}`, `EC2 type ${config.instanceType} in ${region}`);
      const volSize = config.rootVolumeSize ?? 20;
      const volType = (config.rootVolumeType ?? 'gp3').toLowerCase();
      const perGb = b?.ebs?.[volType] ?? (builtIn.EBS[volType] ?? builtIn.EBS.gp3).storage;
      const excludes = ['data transfer', 'additional EBS volumes', 'public IPv4 addresses', 'Windows or other licensed operating systems (priced as Linux)'];
      if (config.market === 'spot') excludes.push('Spot discount (priced at on-demand, the most it can cost)');
      return finish('EC2',
        `${config.instanceType} × ${count}, ${volSize}GB ${volType} root volume${config.market === 'spot' ? ', Spot' : ''}`,
        { compute: q.hourly * HOURS_PER_MONTH * count, storage: volSize * perGb * count },
        SOURCE_CONFIDENCE[q.source], q.source, excludes);
    }

    case 'RDS': {
      const engine = rdsEngineKey(config.engine);
      const aurora = engine.startsWith('aurora');
      const fromBook = b?.rds[config.instanceClass]?.[engine];
      // The built-in table is MySQL / PostgreSQL / MariaDB only; licensed engines are never guessed.
      const builtInOk = ['postgres', 'mysql', 'mariadb'].includes(engine);
      const q = quote(!!b, fromBook, builtInOk ? builtIn.RDS : {}, config.instanceClass, region);
      const label = `${config.instanceClass} (${config.engine})${config.multiAZ ? ' Multi-AZ' : ''}`;
      if (!q) return unknownType('RDS', label, `RDS ${config.instanceClass} with engine ${config.engine} in ${region}`);
      const compute = q.hourly * HOURS_PER_MONTH * (config.multiAZ ? 2 : 1);
      if (aurora) {
        return finish('RDS', `${label}, Aurora instance`, { compute },
          weaker('MEDIUM', SOURCE_CONFIDENCE[q.source]), q.source,
          ['Aurora storage and I/O (usage-based)', 'backups', 'data transfer']);
      }
      const gb = config.allocatedStorage ?? 20;
      const storage = gb * (config.iops ? 0.125 : 0.115);
      const iops = config.iops ? config.iops * 0.10 : 0;
      const backup = gb * 1.5 * 0.095; // assumes backups of about 1.5× allocated storage
      return finish('RDS', `${label}, ${gb}GB storage`, { compute, storage, iops, backup },
        SOURCE_CONFIDENCE[q.source], q.source,
        ['data transfer', 'snapshot storage beyond the estimate', 'Performance Insights']);
    }

    case 'RDS_AURORA': {
      // Serverless: ACU-hours are usage. Assumes a small steady load.
      const acus = 4;
      return finish('RDS_AURORA', `Aurora ${config.engine} (${config.engineMode}), assuming about ${acus} ACUs`,
        { compute: 0.12 * acus * HOURS_PER_MONTH, storage: 100 * 0.10 },
        'LOW', 'usage-assumption', ['actual capacity used (scales with load)', 'I/O requests', 'data transfer']);
    }

    case 'EBS': {
      const type = config.volumeType.toLowerCase();
      const p = builtIn.EBS[type] ?? builtIn.EBS.gp3;
      const perGb = b?.ebs?.[type];
      let iops = 0;
      if (type === 'gp3' && config.iops && config.iops > 3000) iops = (config.iops - 3000) * (p.iops ?? 0);
      else if ((type === 'io1' || type === 'io2') && config.iops) iops = config.iops * (p.iops ?? 0);
      const throughput = type === 'gp3' && config.throughput && config.throughput > 125
        ? (config.throughput - 125) * (p.throughput ?? 0) : 0;
      const source: PriceSource = perGb !== undefined ? 'aws-price-list' : region === 'us-east-1' ? 'built-in' : 'built-in-regional-estimate';
      return finish('EBS', `${config.size}GB ${type}${config.iops ? `, ${config.iops} IOPS` : ''}`,
        { storage: config.size * (perGb ?? p.storage), iops, throughput },
        // Storage is a fixed price; the built-in figure is close in every region.
        perGb !== undefined ? 'HIGH' : 'MEDIUM', source, ['snapshots']);
    }

    case 'NAT_GATEWAY': {
      const hourly = b?.nat?.hourly ?? 0.045;
      const perGb = b?.nat?.perGb ?? 0.045;
      const gb = 100;
      return finish('NAT_GATEWAY', `NAT gateway, assuming about ${gb}GB/month processed`,
        { hourly: hourly * HOURS_PER_MONTH, dataProcessing: gb * perGb },
        'MEDIUM', b?.nat ? 'aws-price-list' : region === 'us-east-1' ? 'built-in' : 'built-in-regional-estimate',
        ['data processed beyond the assumed volume', 'data transfer out']);
    }

    case 'S3':
      return finish('S3', 'S3 bucket, assuming about 100GB stored', { storage: 100 * 0.023, requests: 1 },
        'LOW', 'usage-assumption', ['actual stored data', 'requests', 'data transfer']);

    case 'ELASTICACHE': {
      const n = Math.max(1, config.numCacheNodes);
      const q = quote(!!b, b?.elasticache[config.cacheNodeType], builtIn.ELASTICACHE, config.cacheNodeType, region);
      if (!q) return unknownType('ELASTICACHE', `${config.cacheNodeType} × ${n}`, `ElastiCache node ${config.cacheNodeType} in ${region}`);
      return finish('ELASTICACHE', `${config.cacheNodeType} × ${n} node${n === 1 ? '' : 's'}`,
        { compute: q.hourly * HOURS_PER_MONTH * n }, SOURCE_CONFIDENCE[q.source], q.source,
        ['backup storage', 'data transfer']);
    }

    case 'REDSHIFT': {
      const n = Math.max(1, config.numberOfNodes);
      const q = quote(!!b, b?.redshift[config.nodeType], builtIn.REDSHIFT, config.nodeType, region);
      if (!q) return unknownType('REDSHIFT', `${config.nodeType} × ${n}`, `Redshift node ${config.nodeType} in ${region}`);
      return finish('REDSHIFT', `${config.nodeType} × ${n} node${n === 1 ? '' : 's'}`,
        { compute: q.hourly * HOURS_PER_MONTH * n }, SOURCE_CONFIDENCE[q.source], q.source,
        ['managed storage (RA3)', 'concurrency scaling', 'Spectrum queries']);
    }

    case 'EKS': {
      if (config.kind === 'cluster') {
        return finish('EKS', 'EKS cluster (control plane fee)', { cluster: 0.10 * HOURS_PER_MONTH },
          'HIGH', region === 'us-east-1' ? 'built-in' : 'built-in-regional-estimate',
          ['worker nodes (priced when node groups are created)', 'extended support for old Kubernetes versions']);
      }
      const type = config.instanceTypes[0] ?? 't3.medium';
      const n = Math.max(0, config.desiredSize);
      const q = quote(!!b, b?.ec2[type], builtIn.EC2, type, region);
      if (!q) return unknownType('EKS', `${type} × ${n} nodes`, `EC2 type ${type} in ${region}`);
      return finish('EKS', `EKS node group, ${type} × ${n} node${n === 1 ? '' : 's'} (desired size)`,
        { compute: q.hourly * HOURS_PER_MONTH * n }, weaker('MEDIUM', SOURCE_CONFIDENCE[q.source]), q.source,
        ['autoscaling beyond the desired size', 'node EBS volumes', 'load balancers', 'data transfer']);
    }

    case 'SAGEMAKER': {
      const q = quote(!!b, b?.sagemaker[config.instanceType], builtIn.SAGEMAKER, config.instanceType, region);
      const gb = config.volumeSizeInGB ?? 5;
      if (!q) return unknownType('SAGEMAKER', config.instanceType, `SageMaker notebook type ${config.instanceType} in ${region}`);
      return finish('SAGEMAKER', `SageMaker notebook ${config.instanceType}, ${gb}GB volume`,
        { compute: q.hourly * HOURS_PER_MONTH, storage: gb * 0.14 }, SOURCE_CONFIDENCE[q.source], q.source,
        ['training jobs and endpoints', 'data transfer']);
    }
  }
}
