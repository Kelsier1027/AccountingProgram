// 分帳: importing a shared-expense app's export (one file per 帳期) and keeping the ledger in step.
// Each expense row is followed by a 應分攤 row; columns are me, then the other person:
//   "26/10/28 金孫燒肉","付款者","2215.0",""      ← who paid
//   "","應分攤","-1107.5","-1107.5"               ← each person's share
//   "26/10/30 還款","還款者","","8492.5"          ← a repayment, with its 收款者 row
// Balance with the other person = Σ(what I paid − my share) − their repayments + mine.
import { live, upsert, remove } from './model.js';
import { parseCsv, guessCategory } from './importers.js';
import { notSpending } from './calc.js';
import { round2, daysBetween, nameSimilarity } from './util.js';

const n = (v) => (v === '' || v === undefined || v === null ? 0 : Math.abs(Number(String(v).replace(/,/g, '')) || 0));

/** Does this text look like the split app's export? */
export const looksLikeSplitCsv = (text) => /費用\/使用者/.test(text) && /應分攤/.test(text);

/** Parse one export: { group, me, other, entries[] } with entries in file order. */
export function parseSplitCsv(text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  const group = (rows[0]?.[0] || '').trim();
  const users = rows.find((r) => r[0] === '費用/使用者') || [];
  const [me, other] = [users[2] || '我', users[3] || '對方'];
  const entries = [];
  const seen = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const m = String(r[0] || '').match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(.*)$/);
    if (!m) continue;
    const date = `20${m[1]}-${m[2]}-${m[3]}`;
    const name = m[4].trim();
    const next = rows[i + 1] || [];
    const key = `${date}|${name}`;
    const nth = seen.get(key) || 0;
    seen.set(key, nth + 1);
    const ref = `${group}|${date}|${name}|${nth}`;
    if (r[1] === '還款者') {
      // who handed money over (還款者) and who got it (收款者)
      entries.push({ kind: 'settle', date, name, ref, fromMe: n(r[2]), fromOther: n(r[3]) });
    } else {
      entries.push({ kind: 'expense', date, name, ref, mePaid: n(r[2]), otherPaid: n(r[3]), mine: n(next[2]), theirs: n(next[3]) });
    }
    i++;
  }
  return { group, me, other, entries };
}

/** Category for a shared expense that is not in the ledger yet. */
export function splitCategory(name) {
  if (/紅包|禮金/.test(name)) return '人情';
  if (/高鐵|台鐵|火車|客運|車票|加油|停車|計程車|uber/i.test(name)) return '交通';
  if (/住宿|飯店|旅館|門票|見面會|演唱會|電影|舞台劇|密室|展覽|樂園|bigbang/i.test(name)) return '娛樂';
  if (/vip|iqiyi|訂閱|會員/i.test(name)) return '訂閱';
  if (/衛生棉|衛生紙|uniqlo|衣/i.test(name)) return '日用品';
  const g = guessCategory(name);
  return g === '其他' ? '餐飲' : g;
}

/** The record that stands for a purchase: the card charge when an invoice was merged into one. */
function lead(ledger, t) {
  if (!t.linkId) return t;
  const link = live(ledger.links).find((l) => l.id === t.linkId);
  return (link && ledger.transactions.find((x) => x.id === link.cardTxId && !x.deleted)) || t;
}

/**
 * Import parsed exports. Options: from (YYYY-MM-DD, earlier rows are skipped), days (date window
 * for finding the ledger record, default 2). Re-importing updates by reference and adds nothing.
 */
export function importSplits(ledger, files, { from = '', days = 2 } = {}) {
  const res = { matched: [], guessed: [], placeholders: [], theyPaid: [], settlements: [], updated: 0, skippedBefore: 0, missing: [] };
  const byRef = new Map(live(ledger.transactions).filter((t) => t.split?.ref).map((t) => [t.split.ref, t]));
  const used = new Set();
  for (const f of files) {
    const who = f.other;
    const refsInFile = new Set();
    let opening = 0;
    for (const e of f.entries) {
      refsInFile.add(e.ref);
      if (from && e.date < from) {
        // not imported one by one, but what it left owing still counts (a later repayment covers it)
        opening += e.kind === 'settle' ? -(e.fromOther - e.fromMe) : e.mePaid - e.mine;
        res.skippedBefore++;
        continue;
      }
      const have = byRef.get(e.ref);
      if (e.kind === 'settle') {
        const amount = round2(e.fromOther - e.fromMe);
        if (!amount) continue;
        const rec = {
          date: e.date, amount: Math.abs(amount), type: amount > 0 ? 'income' : 'expense', source: 'split', category: '其他',
          merchant: amount > 0 ? `${who} 分帳還款` : `還 ${who} 分帳`, paymentMethod: 'transfer',
          split: { with: who, settle: true, ref: e.ref, group: f.group }, note: `${f.group} 帳期`,
        };
        if (have) {
          upsert(ledger, 'transactions', { id: have.id, ...rec });
          res.updated++;
        } else {
          byRef.set(e.ref, upsert(ledger, 'transactions', rec));
          res.settlements.push({ date: e.date, amount });
        }
        continue;
      }
      const split = { with: who, paid: e.mePaid, mine: e.mine, ref: e.ref, group: f.group, label: e.name };
      if (have) {
        // amounts changed in the app since the last import
        const patch = { split: { ...have.split, ...split } };
        if (have.splitPlaceholder || have.source === 'split') patch.amount = e.mePaid || e.mine;
        upsert(ledger, 'transactions', { id: have.id, ...patch });
        res.updated++;
        continue;
      }
      if (!e.mePaid) {
        // the other person paid: my share is my spending, owed to them until settled
        if (!e.mine) continue;
        const t = upsert(ledger, 'transactions', {
          date: e.date, amount: e.mine, type: 'expense', source: 'split', category: splitCategory(e.name), merchant: e.name,
          paymentMethod: 'other', split: { ...split, paidBy: 'other' }, note: `${who} 代付（${f.group}）`,
        });
        byRef.set(e.ref, t);
        res.theyPaid.push({ date: e.date, name: e.name, mine: e.mine });
        continue;
      }
      // I paid: find the charge / invoice already in the ledger
      const cands = live(ledger.transactions)
        .filter((t) => t.type !== 'income' && !t.split && !notSpending(t) && !used.has(t.id)
          && Math.abs((Number(t.amount) || 0) - e.mePaid) < 0.5 && Math.abs(daysBetween(t.date, e.date)) <= days)
        .map((t) => lead(ledger, t))
        .filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i && !t.split && !used.has(t.id));
      const score = (t) => nameSimilarity(t.merchant, e.name) * 2 - Math.abs(daysBetween(t.date, e.date)) * 0.3;
      cands.sort((a, b) => score(b) - score(a));
      const pick = cands[0];
      if (pick) {
        used.add(pick.id);
        upsert(ledger, 'transactions', { id: pick.id, split });
        byRef.set(e.ref, pick);
        (cands.length > 1 ? res.guessed : res.matched).push({ date: e.date, name: e.name, amount: e.mePaid, to: `${pick.date} ${pick.merchant}`, others: cands.length - 1 });
        continue;
      }
      // same shop, same day, different amount (tip, a later discount, a fee the app left out)
      const near = live(ledger.transactions)
        .filter((t) => t.type !== 'income' && !t.split && !notSpending(t) && !used.has(t.id) && Math.abs(daysBetween(t.date, e.date)) <= 1
          && nameSimilarity(t.merchant, e.name) >= 0.6 && Math.abs((Number(t.amount) || 0) - e.mePaid) <= Math.max(50, e.mePaid * 0.2))
        .map((t) => lead(ledger, t)).filter((t) => !t.split && !used.has(t.id))
        .sort((a, b) => Math.abs(a.amount - e.mePaid) - Math.abs(b.amount - e.mePaid));
      if (near[0]) {
        const pick = near[0];
        used.add(pick.id);
        upsert(ledger, 'transactions', { id: pick.id, split });
        byRef.set(e.ref, pick);
        res.guessed.push({ date: e.date, name: e.name, amount: e.mePaid, to: `${pick.date} ${pick.merchant} ${pick.amount}（金額不同）`, others: near.length - 1 });
        continue;
      }
      // not in the ledger (cash, LINE Pay balance, or a card statement not imported yet)
      const t = upsert(ledger, 'transactions', {
        date: e.date, amount: e.mePaid, type: 'expense', source: 'split', category: splitCategory(e.name), merchant: e.name,
        paymentMethod: 'other', splitPlaceholder: true, split, note: `分帳暫記（${f.group}）：帳本找不到這筆付款，之後匯入的刷卡會自動接手`,
      });
      byRef.set(e.ref, t);
      res.placeholders.push({ date: e.date, name: e.name, amount: e.mePaid, mine: e.mine });
    }
    const openRef = `${f.group}|opening`;
    refsInFile.add(openRef);
    opening = round2(opening);
    const openTx = byRef.get(openRef);
    if (opening) {
      const rec = {
        date: from || f.entries[0]?.date, amount: Math.abs(opening), type: 'expense', source: 'split', category: '其他',
        merchant: `${who} 分帳期初餘額`, paymentMethod: 'other', excluded: true,
        split: { with: who, paid: Math.max(0, opening), mine: Math.max(0, -opening), ref: openRef, group: f.group, opening: true },
        note: `${f.group} 帳期在 ${from} 之前的分帳淨額（不逐筆匯入，只計入往來餘額）`,
      };
      byRef.set(openRef, upsert(ledger, 'transactions', openTx ? { id: openTx.id, ...rec } : rec));
    } else if (openTx) remove(ledger, 'transactions', openTx.id);
    // entries removed in the app since the last import of this 帳期
    for (const t of live(ledger.transactions).filter((x) => x.split?.group === f.group && !refsInFile.has(x.split.ref))) {
      res.missing.push({ id: t.id, date: t.date, name: t.split.label || t.merchant });
    }
  }
  return res;
}

/**
 * A card charge or invoice imported later may be the real record behind a 分帳暫記: same amount,
 * within a couple of days. The split moves onto it and the placeholder goes away.
 */
export function absorbSplitPlaceholders(ledger, txIds, days = 2) {
  let n = 0;
  for (const id of txIds) {
    const t = ledger.transactions.find((x) => x.id === id && !x.deleted);
    if (!t || t.split || t.type === 'income') continue;
    const ph = live(ledger.transactions).find((x) => x.splitPlaceholder && Math.abs(x.amount - t.amount) < 0.5 && Math.abs(daysBetween(x.date, t.date)) <= days);
    if (!ph) continue;
    const target = lead(ledger, t);
    if (target.split) continue;
    upsert(ledger, 'transactions', { id: target.id, split: ph.split, ...(ph.category && (!target.category || target.category === '其他') ? { category: ph.category } : {}) });
    remove(ledger, 'transactions', ph.id);
    n++;
  }
  return n;
}
