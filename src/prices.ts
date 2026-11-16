// Loads the day's AWS list prices for a region.
//
// The only network request this plugin makes: an HTTPS GET of a public,
// static JSON file named after the region (for example .../eu-west-1.json).
// It sends nothing about your resources, commands or account. The file is
// cached for 24 hours; if it can't be downloaded, estimates use the built-in
// price tables instead and say so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PriceBook } from './engine/types.ts';

export const PRICE_BASE_URL =
  process.env.OUTSEEN_PRICE_BASE_URL ?? 'https://lahavi.github.io/outseen-cost-approval/prices/v1';

const FRESH_MS = 24 * 3_600_000;
const STALE_OK_MS = 30 * 24 * 3_600_000; // a failed refresh may reuse a file up to 30 days old
const TIMEOUT_MS = 2_000;

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
export const isRegion = (s: string): boolean => REGION.test(s);

export function dataDir(): string {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'outseen-cost-approval');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function valid(book: any, region: string): book is PriceBook {
  return book && book.version === 1 && book.region === region && typeof book.asOf === 'string'
    && typeof book.ec2 === 'object' && Object.keys(book.ec2).length > 50;
}

function readCache(file: string, region: string, maxAgeMs: number): PriceBook | null {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) return null;
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    return valid(book, region) ? book : null;
  } catch {
    return null;
  }
}

/** Today's price list for a region, or null when it isn't available (use the built-in tables). */
export async function loadPriceBook(region: string): Promise<PriceBook | null> {
  if (!isRegion(region)) return null;
  let file: string;
  try {
    file = path.join(dataDir(), `prices-v1-${region}.json`);
  } catch {
    return null;
  }

  const fresh = readCache(file, region, FRESH_MS);
  if (fresh) return fresh;

  if (process.env.OUTSEEN_PRICES_OFFLINE !== '1') {
    try {
      const res = await fetch(`${PRICE_BASE_URL}/${region}.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const book = await res.json();
        if (valid(book, region)) {
          try { fs.writeFileSync(file, JSON.stringify(book)); } catch { /* cache is best-effort */ }
          return book;
        }
      }
    } catch { /* offline, timed out or not published yet */ }
  }
  return readCache(file, region, STALE_OK_MS);
}
