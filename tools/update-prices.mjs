#!/usr/bin/env node
// Fetch latest quotes and FX rates server-side (no CORS) and write data/prices.json.
// Usage: node tools/update-prices.mjs [dataDir=data]
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'data';
const UA = { 'User-Agent': 'Mozilla/5.0 (personal-ledger price updater)' };

async function readJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function yahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || !Number.isFinite(m.regularMarketPrice)) throw new Error(`Yahoo ${symbol}: no price`);
  return {
    price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose ?? null, currency: m.currency || null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : new Date().toISOString(), source: 'yahoo',
  };
}

let twseCache;
async function twse(code) {
  if (!twseCache) {
    twseCache = new Map();
    const sources = [
      ['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', (r) => [r.Code, Number(r.ClosingPrice)]],
      ['https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', (r) => [r.SecuritiesCompanyCode, Number(r.Close)]],
    ];
    for (const [url, pick] of sources) {
      try {
        const res = await fetch(url, { headers: UA });
        if (!res.ok) continue;
        for (const r of await res.json()) {
          const [c, p] = pick(r);
          if (c && Number.isFinite(p) && p > 0) twseCache.set(c, p);
        }
      } catch (e) {
        console.warn(`TW fallback ${url}: ${e.message}`);
      }
    }
  }
  const p = twseCache.get(code);
  if (!p) throw new Error(`TWSE/TPEx ${code}: not found`);
  return { price: p, currency: 'TWD', time: new Date().toISOString(), source: 'twse' };
}

async function quote(symbol) {
  try {
    return await yahoo(symbol);
  } catch (e) {
    const m = symbol.match(/^([0-9A-Z]+)\.(TW|TWO)$/);
    if (!m) throw e;
    console.warn(`${e.message}; trying TWSE/TPEx`);
    return twse(m[1]);
  }
}

const ledgerPath = join(dir, 'ledger.json');
const symbolsDoc = await readJson(join(dir, 'symbols.json'), { symbols: [] });
const ledger = existsSync(ledgerPath) ? await readJson(ledgerPath, {}) : {};
const fromLedger = ledger.encrypted ? [] : (ledger.holdings || []).filter((h) => !h.deleted).map((h) => h.symbol);
const symbols = [...new Set([...(symbolsDoc.symbols || []), ...fromLedger].map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];

const pricesPath = join(dir, 'prices.json');
const prices = await readJson(pricesPath, { quotes: {}, fx: {} });
prices.quotes ||= {};
prices.fx ||= {};
let changed = 0;
const failed = [];

for (const s of symbols) {
  try {
    const q = await quote(s);
    prices.quotes[s] = q;
    changed++;
    console.log(`${s}\t${q.price} ${q.currency || ''}\t(${q.source})`);
  } catch (e) {
    failed.push(s);
    console.warn(`! ${s}: ${e.message}`);
  }
}

// FX for every non-TWD currency seen in quotes or the plaintext ledger
const currencies = new Set(Object.values(prices.quotes).map((q) => q.currency).filter((c) => c && c !== 'TWD'));
if (!ledger.encrypted) for (const c of ['accounts', 'assets', 'holdings']) for (const r of ledger[c] || []) if (r.currency && r.currency !== 'TWD') currencies.add(r.currency);
for (const c of symbolsDoc.currencies || []) if (c !== 'TWD') currencies.add(c);
currencies.add('USD');
for (const c of currencies) {
  try {
    const q = await yahoo(`${c}TWD=X`);
    prices.fx[c] = Math.round(q.price * 10000) / 10000;
    changed++;
    console.log(`FX ${c}/TWD\t${prices.fx[c]}`);
  } catch (e) {
    console.warn(`! FX ${c}: ${e.message}`);
  }
}

if (changed) {
  prices.updatedAt = new Date().toISOString();
  await writeFile(pricesPath, JSON.stringify(prices, null, 1) + '\n');
}
console.log(`updated ${changed}, failed ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
if (symbols.length && failed.length === symbols.length) process.exitCode = 1;
