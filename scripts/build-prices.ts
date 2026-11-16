// Builds the daily price files the plugin downloads: one small JSON per region,
// from AWS's public price lists. No AWS account or credentials are involved.
//
//   node scripts/build-prices.ts [--regions eu-west-1,us-east-1] [--out site/prices/v1]
//
// AWS publishes, per service and region, a CSV of every price
// (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/<region>/index.csv).
// The EC2 one is a few hundred MB, so files are streamed line by line and
// reduced to on-demand list prices for the resource types the plugin covers.
// A region whose AWS price versions haven't changed since the last published
// file is copied forward instead of being downloaded again.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import type { PriceBook } from '../src/engine/types.ts';
import { PRICE_BASE_URL } from '../src/prices.ts';

const AWS = 'https://pricing.us-east-1.amazonaws.com';
const SERVICES = ['AmazonEC2', 'AmazonRDS', 'AmazonElastiCache', 'AmazonRedshift', 'AmazonSageMaker'] as const;
type Service = (typeof SERVICES)[number];

/** A published price file: the price book plus the AWS versions it was built from. */
type Published = PriceBook & { sources: Record<string, string> };

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** One line of AWS's CSV: comma-separated, fields optionally in double quotes ("" escapes a quote). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { value += '"'; i += 2; continue; }
          break;
        }
        value += line[i++];
      }
      out.push(value);
      i += 2; // closing quote and comma
    } else {
      const end = line.indexOf(',', i);
      out.push(end === -1 ? line.slice(i) : line.slice(i, end));
      i = end === -1 ? line.length + 1 : end + 1;
    }
  }
  return out;
}

type Row = (column: string) => string;

/** Streams a price CSV, calling `onRow` for each on-demand USD row. Returns AWS's publication date. */
async function streamPrices(url: string, onRow: (row: Row) => void): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const lines = readline.createInterface({ input: Readable.fromWeb(res.body as any), crlfDelay: Infinity });
  let index: Map<string, number> | null = null;
  let published = '';
  let fields: string[] = [];
  const row: Row = (column) => fields[index!.get(column) ?? -1] ?? '';

  for await (const line of lines) {
    if (!index) {
      if (line.startsWith('"Publication Date"')) published = parseCsvLine(line)[1] ?? '';
      else if (line.startsWith('"SKU"')) index = new Map(parseCsvLine(line).map((name, i) => [name, i]));
      continue;
    }
    // Cheap pre-filter before the full parse: most rows are reservations.
    if (!line.includes('"OnDemand"')) continue;
    fields = parseCsvLine(line);
    if (row('TermType') !== 'OnDemand' || row('Currency') !== 'USD') continue;
    onRow(row);
  }
  if (!index) throw new Error(`${url}: no header row found`);
  return published;
}

// ─── What to keep from each service ──────────────────────────────────────────

// usageType carries a region prefix everywhere except us-east-1, e.g. "EU-BoxUsage:m5.large".
const usage = (name: string) => new RegExp(`^(?:[A-Z0-9]+-)?${name}:`);
const BOX_USAGE = usage('BoxUsage');
const INSTANCE_USAGE = usage('InstanceUsage');
const NODE_USAGE = usage('NodeUsage');
const NODE = usage('Node');

const RDS_ENGINES: Record<string, string> = {
  'PostgreSQL': 'postgres',
  'MySQL': 'mysql',
  'MariaDB': 'mariadb',
  'Aurora PostgreSQL': 'aurora-postgresql',
  'Aurora MySQL': 'aurora-mysql',
};

const price = (row: Row): number => Number(row('PricePerUnit'));
const hourly = (row: Row): number | null => {
  const p = price(row);
  return row('Unit') === 'Hrs' && Number.isFinite(p) && p > 0 ? p : null;
};

function collect(service: Service, book: Published): (row: Row) => void {
  switch (service) {
    case 'AmazonEC2':
      return (row) => {
        const family = row('Product Family');
        if (family.startsWith('Compute Instance')) {
          // On-demand Linux, shared tenancy, no bundled software.
          const p = hourly(row);
          if (p && row('operation') === 'RunInstances' && row('Tenancy') === 'Shared' && BOX_USAGE.test(row('usageType'))) {
            book.ec2[row('Instance Type')] = p;
          }
        } else if (family === 'Storage' && row('Volume API Name') && row('Unit') === 'GB-Mo') {
          const p = price(row);
          if (p > 0) (book.ebs ??= {})[row('Volume API Name')] = p;
        } else if (family === 'NAT Gateway') {
          const p = price(row);
          const type = row('usageType');
          if (!(p > 0)) return;
          book.nat ??= { hourly: 0, perGb: 0 };
          if (type.endsWith('NatGateway-Hours')) book.nat.hourly = p;
          else if (type.endsWith('NatGateway-Bytes')) book.nat.perGb = p;
        }
      };
    case 'AmazonRDS':
      return (row) => {
        const engine = RDS_ENGINES[row('Database Engine')];
        const p = hourly(row);
        // Standard Single-AZ instance hours only (not I/O-Optimized, Multi-AZ or Extended Support).
        if (!engine || !p || row('Product Family') !== 'Database Instance' || row('Deployment Option') !== 'Single-AZ'
          || row('Location Type') !== 'AWS Region' || !INSTANCE_USAGE.test(row('usageType'))) return;
        (book.rds[row('Instance Type')] ??= {})[engine] = p;
      };
    case 'AmazonElastiCache':
      return (row) => {
        const p = hourly(row);
        if (p && row('Product Family') === 'Cache Instance' && row('Cache Engine') === 'Redis' && NODE_USAGE.test(row('usageType'))) {
          book.elasticache[row('Instance Type')] = p;
        }
      };
    case 'AmazonRedshift':
      return (row) => {
        const p = hourly(row);
        if (p && row('Product Family') === 'Compute Instance' && NODE.test(row('usageType'))) book.redshift[row('Instance Type')] = p;
      };
    case 'AmazonSageMaker':
      return (row) => {
        const p = hourly(row);
        if (p && row('Component') === 'Notebook' && row('Instance Name')) book.sagemaker[row('Instance Name')] = p;
      };
  }
}

// ─── Regions and versions ────────────────────────────────────────────────────

interface RegionIndex { regions: Record<string, { regionCode: string; currentVersionUrl: string }> }

async function regionIndex(service: Service): Promise<RegionIndex> {
  const res = await fetch(`${AWS}/offers/v1.0/aws/${service}/current/region_index.json`);
  if (!res.ok) throw new Error(`region index for ${service}: HTTP ${res.status}`);
  return (await res.json()) as RegionIndex;
}

async function previouslyPublished(region: string): Promise<Published | null> {
  try {
    const res = await fetch(`${PRICE_BASE_URL}/${region}.json`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as Published) : null;
  } catch {
    return null;
  }
}

const count = (b: PriceBook) =>
  Object.keys(b.ec2).length + Object.keys(b.rds).length + Object.keys(b.elasticache).length + Object.keys(b.redshift).length + Object.keys(b.sagemaker).length;

async function buildRegion(region: string, indexes: Map<Service, RegionIndex>, previous: Published | null): Promise<Published> {
  const sources: Record<string, string> = {};
  for (const s of SERVICES) {
    const url = indexes.get(s)!.regions[region]?.currentVersionUrl;
    if (url) sources[s] = url;
  }
  if (previous && previous.version === 1 && JSON.stringify(previous.sources) === JSON.stringify(sources)) {
    console.log(`${region}: unchanged, copied forward`);
    return previous;
  }

  const book: Published = { version: 1, region, asOf: '', ec2: {}, rds: {}, elasticache: {}, redshift: {}, sagemaker: {}, sources };
  for (const s of SERVICES) {
    if (!sources[s]) continue; // service not offered in this region
    const published = await streamPrices(`${AWS}${sources[s].replace(/index\.json$/, 'index.csv')}`, collect(s, book));
    if (s === 'AmazonEC2') book.asOf = published;
  }
  if (book.nat && !(book.nat.hourly > 0 && book.nat.perGb > 0)) delete book.nat;

  // Guard against a broken or half-empty AWS file replacing good prices.
  if (Object.keys(book.ec2).length < 100) throw new Error(`${region}: only ${Object.keys(book.ec2).length} EC2 prices found`);
  if (previous && count(book) < count(previous) * 0.7) {
    throw new Error(`${region}: ${count(book)} prices found, far fewer than the ${count(previous)} published before`);
  }
  console.log(`${region}: ${Object.keys(book.ec2).length} EC2, ${Object.keys(book.rds).length} RDS, ${Object.keys(book.elasticache).length} ElastiCache, ${Object.keys(book.redshift).length} Redshift, ${Object.keys(book.sagemaker).length} SageMaker; AWS published ${book.asOf}`);
  return book;
}

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const out = arg('--out') ?? 'site/prices/v1';
  fs.mkdirSync(out, { recursive: true });

  const indexes = new Map<Service, RegionIndex>();
  for (const s of SERVICES) indexes.set(s, await regionIndex(s));
  const all = Object.keys(indexes.get('AmazonEC2')!.regions).filter((r) => /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(r) && !r.includes('-gov-') && !r.startsWith('cn-'));
  const regions = arg('--regions')?.split(',') ?? all.sort();

  const failed: string[] = [];
  const summary: Record<string, { asOf: string }> = {};
  for (const region of regions) {
    const previous = await previouslyPublished(region);
    try {
      const book = await buildRegion(region, indexes, previous);
      fs.writeFileSync(path.join(out, `${region}.json`), JSON.stringify(book));
      summary[region] = { asOf: book.asOf };
    } catch (err: any) {
      console.error(`FAILED ${err?.message ?? err}`);
      failed.push(region);
      // Keep yesterday's file rather than publishing nothing for this region.
      if (previous) {
        fs.writeFileSync(path.join(out, `${region}.json`), JSON.stringify(previous));
        summary[region] = { asOf: previous.asOf };
      }
    }
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ version: 1, builtAt: new Date().toISOString(), regions: summary }));
  if (failed.length) {
    console.error(`${failed.length} region(s) failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && /build-prices\.ts$/.test(process.argv[1])) await main();
