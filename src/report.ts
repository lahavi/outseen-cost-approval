// Turns a list of resources into priced lines, a total, and readable text.

import { BUILT_IN_PRICE_DATE } from './engine/built-in-prices.ts';
import { estimateResource } from './engine/estimate.ts';
import { isUnpriced, type CostEstimate, type PriceBook, type ResourceConfig, type Unpriced } from './engine/types.ts';
import { loadPriceBook } from './prices.ts';

/** A resource found in a command, plan or template. */
export interface FoundResource {
  /** What the user would recognise: the command, or the resource's address in the plan. */
  name: string;
  region: string;
  /** Absent when the resource was recognised but its size could not be read. */
  config?: ResourceConfig;
  /** Why there is no config. */
  unreadable?: string;
}

export interface Line {
  name: string;
  region: string;
  estimate?: CostEstimate;
  unpriced?: Unpriced;
}

export interface Report {
  lines: Line[];
  total: number;
  totalLow: number;
  totalHigh: number;
  unpricedCount: number;
  /** One sentence on where the prices came from. */
  priceNote: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function buildReport(found: FoundResource[]): Promise<Report> {
  const books = new Map<string, PriceBook | null>();
  for (const region of new Set(found.filter((f) => f.config).map((f) => f.region))) {
    books.set(region, await loadPriceBook(region));
  }

  const lines: Line[] = found.map((f) => {
    if (!f.config) return { name: f.name, region: f.region, unpriced: { unpriced: true, summary: f.name, reason: f.unreadable ?? 'could not read its size' } };
    const priced = estimateResource(f.config, f.region, books.get(f.region));
    return isUnpriced(priced) ? { name: f.name, region: f.region, unpriced: priced } : { name: f.name, region: f.region, estimate: priced };
  });

  const priced = lines.flatMap((l) => (l.estimate ? [l.estimate] : []));
  const sources = new Set(priced.map((e) => e.priceSource));
  const dates = [...new Set([...books.values()].flatMap((b) => (b ? [b.asOf.slice(0, 10)] : [])))];
  const notes: string[] = [];
  if (sources.has('aws-price-list')) notes.push(`AWS on-demand list prices published ${dates.join(', ')}`);
  if (sources.has('built-in')) notes.push(`built-in us-east-1 list prices from ${BUILT_IN_PRICE_DATE}`);
  if (sources.has('built-in-regional-estimate')) notes.push(`built-in ${BUILT_IN_PRICE_DATE} prices adjusted for the region (today's price list was not available, so this is rougher)`);
  if (sources.has('usage-assumption')) notes.push('assumed usage where the price depends on it');

  return {
    lines,
    total: round(priced.reduce((s, e) => s + e.monthly, 0)),
    totalLow: round(priced.reduce((s, e) => s + e.monthlyLow, 0)),
    totalHigh: round(priced.reduce((s, e) => s + e.monthlyHigh, 0)),
    unpricedCount: lines.length - priced.length,
    priceNote: notes.length ? `Prices: ${notes.join('; ')}.` : '',
  };
}

export function usd(n: number): string {
  return `$${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
}

export const range = (lo: number, hi: number): string => `${usd(lo)}–${usd(hi)}`;

/** A Markdown table for the skill to show. */
export function toMarkdown(r: Report): string {
  const out: string[] = ['| Resource | Region | Monthly estimate | Not included |', '| --- | --- | --- | --- |'];
  for (const l of r.lines) {
    if (l.estimate) {
      out.push(`| ${l.name}: ${l.estimate.summary} | ${l.region} | about ${range(l.estimate.monthlyLow, l.estimate.monthlyHigh)} | ${l.estimate.excludes.slice(0, -1).join(', ')} |`);
    } else {
      out.push(`| ${l.name} | ${l.region} | not priced | ${l.unpriced!.reason} |`);
    }
  }
  out.push('');
  if (r.lines.some((l) => l.estimate)) {
    out.push(`**Total: about ${range(r.totalLow, r.totalHigh)} a month** (point estimate ${usd(r.total)}), at on-demand list prices. Savings Plans, Reserved Instances and negotiated discounts are not applied.`);
  }
  if (r.unpricedCount) out.push(`${r.unpricedCount} resource${r.unpricedCount === 1 ? ' was' : 's were'} not priced and ${r.unpricedCount === 1 ? 'is' : 'are'} not in the total.`);
  if (r.priceNote) out.push(r.priceNote);
  return out.join('\n');
}
