// Reconciliation of credit-card charges ("bank side") against e-invoice / bill / manual records
// ("spend side") so the same purchase is counted once. See .claude/skills/reconciliation.
import { live, upsert, remove } from './model.js';
import { daysBetween, nameSimilarity, round2 } from './util.js';

export const DEFAULT_OPTIONS = { dayWindow: 3, amountTolerance: 0, autoThreshold: 0.85, maxSplit: 3 };

const PLATFORMS = [['foodpanda', /富胖達|foodpanda/i], ['ubereats', /優食|uber ?eats/i]];
const FEE_MAX = 60;

const isCardSide = (t) => t.source === 'card' && t.type !== 'income' && !t.installment && !t.topUp;
const isSpendSide = (t) =>
  t.source !== 'card' && t.type !== 'income' && !t.excluded && (!t.paymentMethod || t.paymentMethod === 'card');

export function scorePair(card, other, opts = DEFAULT_OPTIONS) {
  const amtDiff = Math.abs((Number(card.amount) || 0) - (Number(other.amount) || 0));
  if (amtDiff > opts.amountTolerance + 1e-9) return null;
  const dd = Math.abs(daysBetween(card.date, other.date));
  if (dd > opts.dayWindow) return null;
  const nameSim = nameSimilarity(card.merchant, other.merchant);
  const amountScore = opts.amountTolerance > 0 ? 1 - amtDiff / (opts.amountTolerance * 2) : 1;
  const score = 0.5 * amountScore + 0.3 * (1 - dd / (opts.dayWindow + 1)) + 0.2 * nameSim;
  return { score: round2(score), days: dd, nameSim: round2(nameSim) };
}

function combos(arr, k, start = 0, acc = [], out = []) {
  if (acc.length === k) {
    out.push(acc.slice());
    return out;
  }
  for (let i = start; i < arr.length; i++) {
    acc.push(arr[i]);
    combos(arr, k, i + 1, acc, out);
    acc.pop();
  }
  return out;
}

/**
 * Propose links. Returns { auto: [...], suggested: [...], cardOnly: [...], otherOnly: [...] }
 * Each proposal: { cardTxId, otherTxIds, score, days, kind: 'single'|'split' }
 */
export function findMatches(ledger, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const txs = live(ledger.transactions);
  const cards = txs.filter((t) => isCardSide(t) && !t.linkId);
  const others = txs.filter((t) => isSpendSide(t) && !t.linkId);

  // 1. score every feasible pair
  const pairs = [];
  const candCount = new Map();
  for (const c of cards) {
    for (const o of others) {
      const s = scorePair(c, o, opts);
      if (!s) continue;
      pairs.push({ cardTxId: c.id, otherTxIds: [o.id], ...s, kind: 'single' });
      candCount.set(c.id, (candCount.get(c.id) || 0) + 1);
      candCount.set(o.id, (candCount.get(o.id) || 0) + 1);
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.days - b.days);

  // 2. greedy one-to-one assignment
  const usedCard = new Set();
  const usedOther = new Set();
  const auto = [];
  const suggested = [];
  for (const p of pairs) {
    const o = p.otherTxIds[0];
    if (usedCard.has(p.cardTxId) || usedOther.has(o)) continue;
    usedCard.add(p.cardTxId);
    usedOther.add(o);
    const unique = candCount.get(p.cardTxId) === 1 && candCount.get(o) === 1;
    (p.score >= opts.autoThreshold && unique ? auto : suggested).push(p);
  }

  // 3. split purchases: several invoices on one day at one shop summing to one card charge
  const byId = new Map(txs.map((t) => [t.id, t]));
  for (const c of cards) {
    if (usedCard.has(c.id)) continue;
    const pool = others.filter((o) => !usedOther.has(o.id) && Math.abs(daysBetween(c.date, o.date)) <= opts.dayWindow);
    let found = null;
    for (let k = 2; k <= opts.maxSplit && !found; k++) {
      if (pool.length < k || pool.length > 24) break;
      for (const set of combos(pool, k)) {
        const total = set.reduce((s, o) => s + (Number(o.amount) || 0), 0);
        if (Math.abs(total - c.amount) > opts.amountTolerance + 1e-9) continue;
        const sameDay = set.every((o) => o.date === set[0].date);
        const sameShop = set.every((o) => nameSimilarity(o.merchant, set[0].merchant) >= 0.8);
        if (!sameDay || !sameShop) continue;
        const nameSim = nameSimilarity(c.merchant, set[0].merchant);
        const days = Math.abs(daysBetween(c.date, set[0].date));
        found = {
          cardTxId: c.id, otherTxIds: set.map((o) => o.id), kind: 'split', days, nameSim: round2(nameSim),
          score: round2(0.4 + 0.3 * (1 - days / (opts.dayWindow + 1)) + 0.2 * nameSim),
        };
        break;
      }
    }
    if (found) {
      usedCard.add(c.id);
      found.otherTxIds.forEach((id) => usedOther.add(id));
      suggested.push(found);
    }
  }

  // 4. delivery platforms: the card is charged the whole order, but the platform's own e-invoice
  // covers only its fee (foodpanda 平台費 8–9 元); the restaurant's invoice is separate. The fee
  // invoice is part of that charge, so it is merged into it (same platform, within a day).
  const platformOf = (t) => {
    const name = String(t.merchant || '').replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    return PLATFORMS.find(([, re]) => re.test(name))?.[0];
  };
  const fees = others.filter((o) => !usedOther.has(o.id) && platformOf(o) && o.amount <= FEE_MAX);
  const feePairs = [];
  for (const c of cards) {
    if (usedCard.has(c.id) || !platformOf(c)) continue;
    for (const o of fees) {
      const days = Math.abs(daysBetween(c.date, o.date));
      if (platformOf(o) === platformOf(c) && days <= 1 && o.amount < c.amount) feePairs.push({ c, o, days });
    }
  }
  feePairs.sort((a, b) => a.days - b.days || a.c.date.localeCompare(b.c.date));
  for (const { c, o, days } of feePairs) {
    if (usedCard.has(c.id) || usedOther.has(o.id)) continue;
    usedCard.add(c.id);
    usedOther.add(o.id);
    // the restaurant's own invoice sometimes reaches the carrier too: fee + meal = the charge
    const meal = others.find((r) => !usedOther.has(r.id) && !platformOf(r) && Math.abs(daysBetween(c.date, r.date)) <= 1
      && Math.abs(round2(Number(r.amount) + Number(o.amount)) - Number(c.amount)) <= opts.amountTolerance + 1e-9);
    if (meal) usedOther.add(meal.id);
    suggested.push({ cardTxId: c.id, otherTxIds: meal ? [o.id, meal.id] : [o.id], kind: 'fee', days, nameSim: 1, score: round2((meal ? 0.85 : 0.7) - 0.1 * days) });
  }

  const today = new Date().toISOString().slice(0, 10);
  const age = (t) => Math.max(0, daysBetween(t.date, today));
  return {
    auto,
    suggested,
    cardOnly: cards.filter((c) => !usedCard.has(c.id)).map((t) => ({ tx: t, age: age(t) })),
    otherOnly: others.filter((o) => !usedOther.has(o.id)).map((t) => ({ tx: t, age: age(t) })),
    get: (id) => byId.get(id),
  };
}

/** Create a link (mutates ledger). Throws if any tx is already linked. */
export function applyLink(ledger, { cardTxId, otherTxIds, method = 'manual', score = null }) {
  const tx = (id) => ledger.transactions.find((t) => t.id === id && !t.deleted);
  const card = tx(cardTxId);
  if (!card) throw new Error('找不到刷卡交易');
  if (card.source !== 'card') throw new Error('配對的第一筆必須是刷卡交易');
  const others = otherTxIds.map(tx);
  if (others.some((o) => !o)) throw new Error('找不到要配對的交易');
  if ([card, ...others].some((t) => t.linkId)) throw new Error('有交易已經配對過了，請先解除配對');
  const link = upsert(ledger, 'links', { cardTxId, otherTxIds: [...otherTxIds], method, score });
  // a split recorded on the invoice belongs to the purchase, which the card charge now stands for
  const split = !card.split && others.find((o) => o.split && !o.split.settle)?.split;
  upsert(ledger, 'transactions', { id: card.id, linkId: link.id, ...(split ? { split } : {}) });
  for (const o of others) upsert(ledger, 'transactions', { id: o.id, linkId: link.id, ...(split && o.split === split ? { split: undefined } : {}) });
  return link;
}

export function unlink(ledger, linkId) {
  const link = ledger.links.find((l) => l.id === linkId && !l.deleted);
  if (!link) return;
  for (const id of [link.cardTxId, ...(link.otherTxIds || [])]) {
    const t = ledger.transactions.find((x) => x.id === id && !x.deleted);
    if (t && t.linkId === linkId) {
      const copy = { ...t };
      delete copy.linkId;
      const i = ledger.transactions.indexOf(t);
      ledger.transactions[i] = { ...copy, updatedAt: new Date().toISOString() };
    }
  }
  remove(ledger, 'links', linkId);
}

/** Apply all high-confidence matches. Returns number of links created. */
export function autoMatch(ledger, options) {
  const res = findMatches(ledger, options);
  for (const p of res.auto) applyLink(ledger, { ...p, method: 'auto' });
  return res.auto.length;
}

/**
 * Delete every e-invoice (載具) record dated within [from, to] (inclusive, YYYY-MM-DD), e.g. to
 * redo an import. Links to card charges are undone first so the card side stays intact.
 * Deletions are tombstones, so they reach the other devices on sync.
 */
export function deleteInvoicesInRange(ledger, from, to, { dryRun = false } = {}) {
  const hit = live(ledger.transactions).filter((t) => t.source === 'invoice' && t.date >= from && t.date <= to);
  const linked = hit.filter((t) => t.linkId).length;
  const total = round2(hit.reduce((s, t) => s + (t.type === 'income' ? -1 : 1) * (Number(t.amount) || 0), 0));
  if (!dryRun) {
    for (const t of hit) {
      const cur = ledger.transactions.find((x) => x.id === t.id);
      if (cur?.linkId) unlink(ledger, cur.linkId);
      remove(ledger, 'transactions', t.id);
    }
  }
  return { count: hit.length, linked, total };
}
