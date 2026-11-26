import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, upsert, remove, live, symbolsOf } from '../app/js/core/model.js';
import { totals, effectiveTransactions, monthSummary, billStatus, cardOutstanding, valueHolding } from '../app/js/core/calc.js';
import { findMatches, applyLink, unlink, autoMatch } from '../app/js/core/match.js';
import { parseEInvoice, importInvoices, parseCsv, cardRowsToTransactions, importCardTransactions, guessCategory } from '../app/js/core/importers.js';
import { mergeLedgers } from '../app/js/core/merge.js';
import { encryptJson, decryptJson, utf8ToB64, b64ToUtf8 } from '../app/js/core/crypto.js';
import { parseDate, nameSimilarity } from '../app/js/core/util.js';
import { sampleLedger, samplePrices } from '../app/js/core/sample.js';

test('parseDate handles ROC and compact formats', () => {
  assert.equal(parseDate('2026/11/3'), '2026-11-03');
  assert.equal(parseDate('115/11/03'), '2026-11-03');
  assert.equal(parseDate('1151103'), '2026-11-03');
  assert.equal(parseDate('20261103'), '2026-11-03');
  assert.equal(parseDate('11/03', 2026), '2026-11-03');
  assert.equal(parseDate('garbage'), null);
});

test('name similarity ignores company suffixes and width', () => {
  assert.ok(nameSimilarity('全聯實業股份有限公司', '全聯福利中心－台北') >= 0.3);
  assert.ok(nameSimilarity('ＳＴＡＲＢＵＣＫＳ', 'starbucks') === 1);
  assert.ok(nameSimilarity('全家', 'NETFLIX') < 0.2);
});

test('totals: assets, liabilities, fx and holdings', () => {
  const l = emptyLedger();
  upsert(l, 'accounts', { name: 'a', balance: 1000, currency: 'TWD' });
  upsert(l, 'accounts', { name: 'usd', balance: 10, currency: 'USD' });
  upsert(l, 'holdings', { symbol: '2330.TW', shares: 10, avgCost: 500, currency: 'TWD' });
  upsert(l, 'holdings', { symbol: 'NOQ', shares: 1, avgCost: 100, currency: 'TWD' });
  upsert(l, 'loans', { name: 'x', balance: 300 });
  upsert(l, 'ious', { direction: 'owedToMe', amount: 100, repayments: [{ amount: 40 }] });
  upsert(l, 'ious', { direction: 'iOwe', amount: 50, repayments: [], settled: true });
  const prices = { quotes: { '2330.TW': { price: 600, currency: 'TWD' } }, fx: { USD: 30 } };
  const t = totals(l, prices);
  assert.equal(t.accounts, 1300);
  assert.equal(t.stocks, 6100);
  assert.equal(t.stockPnl, 1000);
  assert.equal(t.receivables, 60);
  assert.equal(t.payables, 0);
  assert.equal(t.netWorth, 1300 + 6100 + 60 - 300);
  assert.equal(valueHolding({ symbol: 'NOQ', shares: 1, avgCost: 100 }, prices).priceSource, 'cost');
  assert.equal(valueHolding({ symbol: '2330.TW', shares: 1, avgCost: 1, manualPrice: 9 }, prices).price, 9);
});

test('card outstanding = unpaid statements + charges after last close', () => {
  const l = emptyLedger();
  const c = upsert(l, 'cards', { name: 'c' });
  upsert(l, 'statements', { cardId: c.id, closingDate: '2026-10-05', total: 1000, paidAmount: 400 });
  upsert(l, 'transactions', { source: 'card', cardId: c.id, date: '2026-10-01', amount: 999, type: 'expense' }); // billed already
  upsert(l, 'transactions', { source: 'card', cardId: c.id, date: '2026-10-10', amount: 200, type: 'expense' });
  upsert(l, 'transactions', { source: 'card', cardId: c.id, date: '2026-10-11', amount: 50, type: 'income' });
  assert.deepEqual(cardOutstanding(l, c.id).total, 750);
});

test('matching: exact, fuzzy name, date lag, split purchase, and dedup in summary', () => {
  const l = sampleLedger(new Date('2026-11-20T12:00:00'));
  const r = findMatches(l);
  const pairs = [...r.auto, ...r.suggested];
  const get = (id) => l.transactions.find((t) => t.id === id);
  const merchantsOf = (p) => [get(p.cardTxId).merchant, ...p.otherTxIds.map((id) => get(id).merchant)];
  assert.ok(pairs.some((p) => merchantsOf(p)[0] === '全聯福利中心－台北'));
  assert.ok(pairs.some((p) => merchantsOf(p)[0].startsWith('STARBUCKS')));
  assert.ok(pairs.some((p) => merchantsOf(p)[0] === '中油直營站'));
  const split = pairs.find((p) => p.kind === 'split');
  assert.ok(split, 'split purchase found');
  assert.equal(split.otherTxIds.length, 2);
  assert.equal(r.cardOnly.length, 1); // NETFLIX has no invoice
  assert.equal(r.cardOnly[0].tx.merchant, 'NETFLIX.COM');

  const before = monthSummary(l, '2026-11').expense;
  for (const p of pairs) applyLink(l, p);
  const after = monthSummary(l, '2026-11').expense;
  assert.equal(before - after, 642 + 155 + 520 + 528);
  // linked card charge borrows the invoice category
  const eff = effectiveTransactions(l).find((t) => t.merchant === '全聯福利中心－台北');
  assert.equal(eff.category, '日用品');
  assert.equal(eff.items.length, 3);

  const linkId = get(split.cardTxId).linkId;
  unlink(l, linkId);
  assert.equal(get(split.cardTxId).linkId, undefined);
  assert.equal(monthSummary(l, '2026-11').expense, after + 528);
});

test('matching respects day window and payment method', () => {
  const l = emptyLedger();
  upsert(l, 'transactions', { source: 'card', date: '2026-11-01', amount: 100, merchant: 'A', type: 'expense' });
  upsert(l, 'transactions', { source: 'invoice', date: '2026-11-09', amount: 100, merchant: 'A', type: 'expense' });
  upsert(l, 'transactions', { source: 'manual', date: '2026-11-01', amount: 100, merchant: 'A', type: 'expense', paymentMethod: 'cash' });
  const r = findMatches(l);
  assert.equal(r.auto.length + r.suggested.length, 0);
  assert.equal(autoMatch(l), 0);
});

test('applyLink refuses double linking', () => {
  const l = emptyLedger();
  const c = upsert(l, 'transactions', { source: 'card', date: '2026-11-01', amount: 100, type: 'expense' });
  const i = upsert(l, 'transactions', { source: 'invoice', date: '2026-11-01', amount: 100, type: 'expense' });
  applyLink(l, { cardTxId: c.id, otherTxIds: [i.id] });
  assert.throws(() => applyLink(l, { cardTxId: c.id, otherTxIds: [i.id] }));
});

test('e-invoice pipe format with details and void invoices', () => {
  const csv = [
    '表頭=M|載具名稱|載具號碼|發票日期|商店統編|商店店名|發票號碼|總金額|發票狀態|',
    '明細=D|發票號碼|小計|品項名稱|',
    'M|手機條碼|/ABC1234|20261103|12345678|全家便利商店|AB12345678|85|開立|',
    'D|AB12345678|50|鮮奶|',
    'D|AB12345678|35|茶葉蛋|',
    'M|手機條碼|/ABC1234|20261104|12345678|全家便利商店|AB12345679|60|作廢|',
  ].join('\n');
  const inv = parseEInvoice(csv);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].date, '2026-11-03');
  assert.equal(inv[0].items.length, 2);
  const l = emptyLedger();
  assert.deepEqual(importInvoices(l, inv), { added: 1, updated: 0, skipped: 0 });
  assert.deepEqual(importInvoices(l, inv), { added: 0, updated: 0, skipped: 1 });
  assert.equal(live(l.transactions)[0].category, '餐飲');
});

test('e-invoice headered CSV', () => {
  const csv = '發票日期,發票號碼,商店店名,總金額,品項名稱,小計\n2026/11/05,XY00000001,全聯,300,米,200\n2026/11/05,XY00000001,全聯,300,蛋,100\n';
  const inv = parseEInvoice(csv);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].amount, 300);
  assert.equal(inv[0].items.length, 2);
});

test('card CSV import with ROC dates, refunds and multiset dedupe', () => {
  const rows = parseCsv('消費日,入帳日,說明,金額\n"115/11/02",115/11/04,"咖啡, 大杯",120\n115/11/02,115/11/04,"咖啡, 大杯",120\n115/11/03,115/11/05,退款 商店,-50\n');
  assert.equal(rows[1][2], '咖啡, 大杯');
  const txs = cardRowsToTransactions(rows, { date: 0, desc: 2, amount: 3 }, 'crd1');
  assert.equal(txs.length, 3);
  assert.equal(txs[2].type, 'income');
  const l = emptyLedger();
  assert.deepEqual(pick(importCardTransactions(l, txs)), { added: 3, skipped: 0 });
  assert.deepEqual(pick(importCardTransactions(l, txs)), { added: 0, skipped: 3 });
});

test('bill status per cycle', () => {
  const b = { cycle: 'bimonthly', startMonth: '2026-07', dueDay: 15, payments: [] };
  assert.equal(billStatus(b, '2026-11-10').period, '2026-11');
  assert.equal(billStatus(b, '2026-12-10').period, '2026-11');
  assert.equal(billStatus(b, '2026-12-10').state, 'overdue');
  b.payments.push({ period: '2026-11' });
  assert.equal(billStatus(b, '2026-12-10').state, 'paid');
  assert.equal(billStatus({ cycle: 'monthly', startMonth: '2026-01', dueDay: 25, payments: [] }, '2026-11-10').state, 'due');
});

test('merge: newer record wins, tombstones propagate, both sides kept', () => {
  const base = emptyLedger();
  const a = upsert(base, 'accounts', { name: 'A', balance: 1 });
  const b = upsert(base, 'accounts', { name: 'B', balance: 1 });
  const phone = structuredClone(base);
  const pc = structuredClone(base);
  const later = (r, ms) => (r.updatedAt = new Date(Date.parse(r.updatedAt) + ms).toISOString());
  upsert(phone, 'accounts', { id: a.id, balance: 5 }); later(phone.accounts[0], 1000);
  remove(pc, 'accounts', b.id); later(pc.accounts[1], 1000);
  upsert(pc, 'accounts', { name: 'C', balance: 3 });
  const { ledger } = mergeLedgers(phone, pc);
  const acc = live(ledger.accounts);
  assert.deepEqual(acc.map((x) => x.name).sort(), ['A', 'C']);
  assert.equal(acc.find((x) => x.name === 'A').balance, 5);
});

test('encryption round trip and wrong password', async () => {
  const obj = { hello: '世界', n: 1 };
  const w = await encryptJson(obj, 'pw');
  assert.deepEqual(await decryptJson(w, 'pw'), obj);
  await assert.rejects(decryptJson(w, 'nope'));
  assert.equal(b64ToUtf8(utf8ToB64('中文 ✓')), '中文 ✓');
});

test('sample ledger computes and lists symbols', () => {
  const l = sampleLedger();
  const t = totals(l, samplePrices());
  assert.ok(t.netWorth > 0);
  assert.deepEqual(symbolsOf(l), ['0050.TW', '00878.TW', '2330.TW', 'VT']);
});

import { normalizeLedger, ensureIssuer, issuerKey, issuerIdFor } from '../app/js/core/model.js';
import { issuerUsage } from '../app/js/core/calc.js';

test('issuers: bank names normalise, ensureIssuer reuses the same bank', () => {
  assert.equal(issuerKey('玉山銀行'), issuerKey('玉山'));
  assert.equal(issuerKey('國泰世華商業銀行'), issuerKey('國泰世華'));
  assert.equal(issuerIdFor('玉山銀行'), issuerIdFor(' 玉山 '));
  const l = emptyLedger();
  const a = ensureIssuer(l, '玉山銀行');
  const b = ensureIssuer(l, '玉山');
  assert.equal(a.id, b.id);
  assert.equal(live(l.issuers).length, 1);
});

test('issuers: legacy cards migrate to one shared line per bank, deterministically', () => {
  const legacy = () => ({
    schemaVersion: 1,
    cards: [
      { id: 'c1', name: 'Pi', bank: '玉山銀行', limit: 100000, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'c2', name: 'UBear', bank: '玉山', limit: 120000, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'c3', name: 'CUBE', bank: '國泰世華', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'c4', name: 'NoBank', updatedAt: '2026-01-01T00:00:00Z' },
    ],
  });
  const phone = normalizeLedger(legacy());
  const pc = normalizeLedger(legacy());
  assert.equal(phone.issuers.length, 2);
  const esun = phone.issuers.find((i) => i.name === '玉山銀行');
  assert.equal(esun.limit, 120000); // the larger of the card limits
  assert.equal(phone.cards[0].issuerId, phone.cards[1].issuerId);
  assert.equal(phone.cards[3].issuerId, undefined);
  assert.deepEqual(phone.issuers, pc.issuers); // same ids and timestamps on every device
  const { ledger } = mergeLedgers(phone, pc);
  assert.equal(ledger.issuers.length, 2); // no duplicates after merging
  // idempotent
  assert.deepEqual(normalizeLedger(structuredClone(phone)).issuers, phone.issuers);
  // a user edit to the limit is not overwritten by a later migration pass
  upsert(phone, 'issuers', { id: esun.id, limit: 50000 });
  normalizeLedger(phone);
  assert.equal(phone.issuers.find((i) => i.id === esun.id).limit, 50000);
});

test('issuers: shared limit is used by all cards of the bank', () => {
  const l = emptyLedger();
  const iss = ensureIssuer(l, '玉山銀行');
  upsert(l, 'issuers', { id: iss.id, limit: 100000 });
  const a = upsert(l, 'cards', { name: 'A', issuerId: iss.id });
  const b = upsert(l, 'cards', { name: 'B', issuerId: iss.id });
  upsert(l, 'statements', { cardId: a.id, closingDate: '2026-11-05', total: 30000, paidAmount: 10000 });
  upsert(l, 'transactions', { source: 'card', cardId: a.id, date: '2026-11-10', amount: 5000, type: 'expense' });
  upsert(l, 'transactions', { source: 'card', cardId: b.id, date: '2026-11-10', amount: 40000, type: 'expense' });
  const u = issuerUsage(l, iss.id);
  assert.equal(u.used, 20000 + 5000 + 40000);
  assert.equal(u.available, 35000);
  assert.equal(u.cards.length, 2);
  assert.ok(Math.abs(u.ratio - 0.65) < 1e-9);
});

test('sample ledger has two cards sharing one bank line', () => {
  const l = normalizeLedger(sampleLedger());
  const esun = l.issuers.find((i) => i.name === '玉山銀行');
  assert.equal(issuerUsage(l, esun.id).cards.length, 2);
});

import { issuerOutstanding, statementsOfIssuer, cardsOutstandingTotal } from '../app/js/core/calc.js';

test('combined statements: one statement per bank covers all its cards', () => {
  const l = emptyLedger();
  const iss = ensureIssuer(l, '玉山銀行');
  upsert(l, 'issuers', { id: iss.id, limit: 100000, statementDay: 5, dueDay: 20 });
  const a = upsert(l, 'cards', { name: 'A', issuerId: iss.id });
  const b = upsert(l, 'cards', { name: 'B', issuerId: iss.id });
  const s = upsert(l, 'statements', { issuerId: iss.id, period: '2026-11', closingDate: '2026-11-05', total: 3000, paidAmount: 1000 });
  upsert(l, 'transactions', { source: 'card', cardId: a.id, date: '2026-11-01', amount: 1000, type: 'expense', statementId: s.id });
  upsert(l, 'transactions', { source: 'card', cardId: b.id, date: '2026-11-02', amount: 2000, type: 'expense', statementId: s.id });
  upsert(l, 'transactions', { source: 'card', cardId: b.id, date: '2026-11-08', amount: 500, type: 'expense' }); // after close
  upsert(l, 'transactions', { source: 'card', cardId: a.id, date: '2026-11-03', amount: 999, type: 'expense' }); // before close, not attached: ignored
  const o = issuerOutstanding(l, iss.id);
  assert.equal(o.unpaidStatements, 2000);
  assert.equal(o.unbilled, 500);
  assert.equal(o.total, 2500);
  assert.equal(issuerUsage(l, iss.id).used, 2500);
  // per-card breakdown
  assert.deepEqual([cardOutstanding(l, a.id).billed, cardOutstanding(l, b.id).billed, cardOutstanding(l, b.id).unbilled], [1000, 2000, 500]);
  // counted once in totals (not once per card)
  assert.equal(cardsOutstandingTotal(l), 2500);
  assert.equal(totals(l, {}).cards, 2500);
});

test('combined statements: legacy per-card statements and closing days move to the bank', () => {
  const l = normalizeLedger({
    cards: [
      { id: 'c1', name: 'Pi', bank: '玉山銀行', statementDay: 5, dueDay: 20, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'c2', name: 'UBear', bank: '玉山', updatedAt: '2026-01-01T00:00:00Z' },
    ],
    statements: [
      { id: 's1', cardId: 'c1', period: '2026-10', closingDate: '2026-10-05', total: 100, paidAmount: 0, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 's2', cardId: 'c2', period: '2026-11', closingDate: '2026-11-05', total: 50, paidAmount: 0, updatedAt: '2026-01-01T00:00:00Z' },
    ],
  });
  const iss = l.issuers[0];
  assert.equal(iss.statementDay, 5);
  assert.equal(iss.dueDay, 20);
  assert.deepEqual(statementsOfIssuer(l, iss.id).map((s) => s.id), ['s2', 's1']);
  assert.equal(issuerOutstanding(l, iss.id).unpaidStatements, 150);
  assert.equal(totals(l, {}).cards, 150);
});

// Same structure as the e-invoice platform's current CSV export (one row per line item; the
// "發票金額" column holds the LINE amount). Made-up stores and items.
const PLATFORM_CSV = [
  '\uFEFF載具自訂名稱,發票日期,發票號碼,發票金額,發票狀態,折讓,賣方統一編號,賣方名稱,賣方地址,買方統編,消費明細_數量,消費明細_單價,消費明細_金額,消費明細_品名',
  '手機條碼,20261116,AA00000001,80,開立已確認,否,11111111,測試餐館,台北市,,1,80,80,口水雞',
  '手機條碼,20261116,AA00000001,500,開立已確認,否,11111111,測試餐館,台北市,,2,250,500,牛頰肉',
  '手機條碼,20261116,AA00000001,58,開立已確認,否,11111111,測試餐館,台北市,,1,58,58,服務費',
  '手機條碼,20261112,AA00000002,24900,開立已確認,否,22222222,測試網購股份有限公司,台北市,,1,24900,24900,除濕機',
  '手機條碼,20261112,AA00000002,-2111,開立已確認,否,22222222,測試網購股份有限公司,台北市,,1,-2111,-2111,活動折扣',
  '手機條碼,20261114,AA00000003,59,開立已確認,否,33333333,好市多股份有限公司測試分公司,台北市,,1,83,59,冷麵',
  '手機條碼,20261114,AA00000003,0,開立已確認,否,33333333,好市多股份有限公司測試分公司,台北市,,1,0,0,贈品',
  '手機條碼,20261114,AA00000004,90,開立已確認,否,44444444,測試加油站,台北市,,2.75,32.7,90,九五無鉛汽油',
  '手機條碼,20261109,AA00000***,,作廢已確認,否,22222222,測試網購股份有限公司,台北市,,,,,',
  '手機條碼,20261108,AA00000005,0,開立已確認,否,55555555,測試商行,台北市,,1,0,0,會員贈品',
  '手機條碼,20261107,AA00000006,-99,開立已確認,否,66666666,測試五金行,台北市,,-1,99,-99,退貨刮刀',
  '捐贈或作廢之發票，字軌號碼均會隱末3碼',
  '注意：本功能所下載之雲端發票明細檔案可能因賣方營業人後續作廢或折讓等原因而產生誤差。',
  '',
].join('\n');

const WALLET_CSV = [
  '消費時間,發票號碼,店家名稱,賣方統編,消費品項,單價,個數,小計,總計,備註',
  '2026/11/01 11:00:21,ZZ00000001,測試生活館,11111111,清潔劑,70,1,53,194,',
  '2026/11/01 11:00:21,ZZ00000001,測試生活館,11111111,拖把,108,1,98,,',
  '2026/11/01 11:00:21,ZZ00000001,測試生活館,11111111,海綿,50,1,43,,',
  '2026/11/02 12:07:24,ZZ00000002,測試加油站,22222222,95無鉛汽油,32.7,3.51,115,112,',
  '2026/11/02 12:07:24,ZZ00000002,測試加油站,22222222,95無鉛汽油折抵額,-1,3,-3,,',
  '2026/11/03 08:00:00,ZZ00000003,測試便利店,33333333,"Cannelé, 兩顆",160,1,160,160,',
  '2026/11/04 09:00:00,ZZ00000004,測試訂閱服務,44444444,Premium,456,1,456,479,',
  '2026/11/05 19:00:00,ZZ00000005,測試壽司店,55555555,壽司,400,2,800,770,',
  '',
].join('\n');

test('發票存摺 app export: 消費時間 / 店家名稱 / 總計 columns, one invoice per number', () => {
  const inv = parseEInvoice(WALLET_CSV);
  const by = Object.fromEntries(inv.map((i) => [i.invoiceNo, i]));
  assert.equal(inv.length, 5);
  assert.equal(by.ZZ00000001.date, '2026-11-01'); // the time of day is dropped
  assert.equal(by.ZZ00000001.merchant, '測試生活館');
  assert.equal(by.ZZ00000001.taxId, '11111111');
  assert.equal(by.ZZ00000001.amount, 194); // sum of the 小計 lines = 總計
  assert.equal(by.ZZ00000001.items.length, 3);
  assert.equal(by.ZZ00000002.amount, 112); // discount line included
  assert.equal(by.ZZ00000002.items[0].qty, 3.51);
  assert.equal(by.ZZ00000003.items[0].name, 'Cannelé, 兩顆'); // quoted comma kept
  assert.equal(by.ZZ00000004.amount, 479); // 總計 includes the tax the line leaves out
  assert.equal(by.ZZ00000005.amount, 770); // and a discount that is not spread over the lines
  // the items still add up to the total, using the line the Moneybook import writes
  assert.deepEqual(by.ZZ00000004.items.at(-1), { name: '稅額／差額（依發票總額）', qty: 1, price: 23, amount: 23 });
  assert.equal(by.ZZ00000005.items.at(-1).name, '折讓／差額（依發票總額）');
  for (const i of inv) assert.equal(i.items.reduce((s, x) => s + x.amount, 0), i.amount);
});

test('guessCategory: Uniqlo (優衣庫) is shopping, 小吃店 is food', () => {
  assert.equal(guessCategory('台灣優衣庫有限公司', [{ name: '服飾', amount: 390 }]), '購物');
  assert.equal(guessCategory('某某小吃店', [{ name: '沙朗牛排', amount: 290 }]), '餐飲');
});

test('發票存摺 import keeps the carrier and the balance line of an invoice already in the ledger', () => {
  const l = emptyLedger();
  upsert(l, 'transactions', { date: '2026-11-04', amount: 479, type: 'expense', source: 'invoice', invoiceNo: 'ZZ00000004', merchant: '測試訂閱服務',
    carrier: '手機條碼', category: '訂閱', items: [{ name: 'Premium', amount: 456, qty: 1, price: 456 }, { name: '稅額／差額（依發票總額）', qty: 1, price: 23, amount: 23 }] });
  const r = importInvoices(l, parseEInvoice(WALLET_CSV));
  assert.equal(r.updated, 0);
  const t = live(l.transactions).find((x) => x.invoiceNo === 'ZZ00000004');
  assert.equal(t.carrier, '手機條碼');
  assert.equal(t.category, '訂閱');
});

test('e-invoice platform CSV: one invoice per number, total = all lines incl. discounts', () => {
  const inv = parseEInvoice(PLATFORM_CSV);
  const by = Object.fromEntries(inv.map((i) => [i.invoiceNo, i]));
  assert.equal(inv.length, 6); // voided invoice and footer notes skipped
  assert.equal(by.AA00000001.amount, 638);
  assert.equal(by.AA00000001.items.length, 3);
  assert.equal(by.AA00000001.merchant, '測試餐館'); // not the tax id column
  assert.equal(by.AA00000001.taxId, '11111111');
  assert.equal(by.AA00000002.amount, 22789); // discount line included
  assert.deepEqual(by.AA00000004.items[0], { name: '九五無鉛汽油', amount: 90, qty: 2.75, price: 32.7 });
  assert.equal(by.AA00000001.carrier, '手機條碼');
});

test('e-invoice import: store decides the category, zero invoices skipped, negative = refund', () => {
  const l = emptyLedger();
  const r = importInvoices(l, parseEInvoice(PLATFORM_CSV));
  assert.deepEqual(r, { added: 5, updated: 0, skipped: 1 });
  const tx = Object.fromEntries(live(l.transactions).map((t) => [t.invoiceNo, t]));
  assert.equal(tx.AA00000003.category, '日用品'); // Costco, even though the item is 冷麵
  assert.equal(tx.AA00000004.category, '交通');
  assert.equal(tx.AA00000006.type, 'income');
  assert.equal(tx.AA00000006.amount, 99);
});

test('e-invoice re-import repairs records from the old parser and keeps user edits', () => {
  const l = emptyLedger();
  // what the old parser stored: first line only, tax id as the store
  const old = upsert(l, 'transactions', {
    date: '2026-11-12', amount: 24900, type: 'expense', source: 'invoice', merchant: '22222222',
    invoiceNo: 'AA00000002', items: [{ name: '除濕機', amount: 24900 }], category: '家電', note: '我的備註',
  });
  const card = upsert(l, 'transactions', { date: '2026-11-12', amount: 22789, type: 'expense', source: 'card', merchant: '測試網購' });
  applyLink(l, { cardTxId: card.id, otherTxIds: [old.id] });
  const r = importInvoices(l, parseEInvoice(PLATFORM_CSV));
  assert.equal(r.updated, 1);
  const fixed = l.transactions.find((t) => t.id === old.id);
  assert.equal(fixed.amount, 22789);
  assert.equal(fixed.merchant, '測試網購股份有限公司');
  assert.equal(fixed.items.length, 2);
  assert.equal(fixed.category, '家電'); // user's edits survive
  assert.equal(fixed.note, '我的備註');
  assert.ok(fixed.linkId); // still merged with the card charge
  assert.deepEqual(importInvoices(l, parseEInvoice(PLATFORM_CSV)), { added: 0, updated: 0, skipped: 6 });
});

test('e-invoice re-import re-guesses categories the user never changed', () => {
  const l = emptyLedger();
  // old parser: store = tax id, so the guess came from the item only (冷麵 -> 餐飲)
  const items = [{ name: '冷麵', amount: 59 }];
  const t = upsert(l, 'transactions', {
    date: '2026-11-14', amount: 59, type: 'expense', source: 'invoice', merchant: '33333333',
    invoiceNo: 'AA00000003', items, category: guessCategory('33333333', items),
  });
  assert.equal(t.category, '餐飲');
  importInvoices(l, parseEInvoice(PLATFORM_CSV));
  assert.equal(l.transactions.find((x) => x.id === t.id).category, '日用品'); // Costco
});

import { last4Of, assignCards } from '../app/js/core/importers.js';
const pick = ({ added, skipped }) => ({ added, skipped });
import { txIssuerId } from '../app/js/core/calc.js';

test('card import goes to a bank: rows split to cards by last four digits', () => {
  assert.equal(last4Of('****-****-****-1234'), '1234');
  assert.equal(last4Of('正卡 4311-12**-****-５６７８'), '5678');
  assert.equal(last4Of(''), null);
  const l = emptyLedger();
  const iss = ensureIssuer(l, '玉山銀行');
  const pi = upsert(l, 'cards', { name: 'Pi', issuerId: iss.id, last4: '1234' });
  const ub = upsert(l, 'cards', { name: 'UBear', issuerId: iss.id, last4: '5678' });
  const rows = parseCsv('消費日,卡號,說明,金額\n2026/11/01,****1234,全聯,642\n2026/11/02,****5678,星巴克,155\n2026/11/03,****9999,未知卡,100\n');
  const target = { issuerId: iss.id, cards: [pi, ub], defaultCardId: undefined };
  const txs = cardRowsToTransactions(rows, { date: 0, card: 1, desc: 2, amount: 3 }, target);
  assert.deepEqual(txs.map((t) => t.cardId), [pi.id, ub.id, undefined]);
  assert.ok(txs.every((t) => t.issuerId === iss.id));
  assert.equal(txs[2]._unmatchedLast4, '9999');
  assert.deepEqual(pick(importCardTransactions(l, txs)), { added: 3, skipped: 0 });
  const stored = live(l.transactions);
  assert.ok(stored.every((t) => !('_unmatchedLast4' in t)));
  // the bank-only row still counts for the bank
  assert.equal(issuerOutstanding(l, iss.id).unbilled, 897);
  assert.equal(txIssuerId(l, stored[2]), iss.id);
  // re-import with a default card (no auto-create): duplicates are detected per bank, nothing added
  const again = cardRowsToTransactions(rows, { date: 0, card: 1, desc: 2, amount: 3 }, { ...target, defaultCardId: pi.id });
  assignCards(l, iss.id, again, { autoCreate: false, defaultCardId: pi.id });
  assert.equal(again[2].cardId, pi.id);
  assert.deepEqual(pick(importCardTransactions(l, again)), { added: 0, skipped: 3 });
  // no card column: everything goes to the default card
  const noCol = cardRowsToTransactions(rows, { date: 0, desc: 2, amount: 3 }, { ...target, defaultCardId: ub.id });
  assert.ok(noCol.every((t) => t.cardId === ub.id));
});

import { deleteInvoicesInRange } from '../app/js/core/match.js';

test('bulk delete of e-invoice records in a date range', () => {
  const l = emptyLedger();
  const a = upsert(l, 'transactions', { source: 'invoice', date: '2026-10-31', amount: 10, type: 'expense', invoiceNo: 'A1' });
  const b = upsert(l, 'transactions', { source: 'invoice', date: '2026-11-01', amount: 20, type: 'expense', invoiceNo: 'A2' });
  const c = upsert(l, 'transactions', { source: 'invoice', date: '2026-11-30', amount: 30, type: 'expense', invoiceNo: 'A3' });
  const m = upsert(l, 'transactions', { source: 'manual', date: '2026-11-10', amount: 40, type: 'expense' });
  const card = upsert(l, 'transactions', { source: 'card', date: '2026-11-01', amount: 20, type: 'expense' });
  applyLink(l, { cardTxId: card.id, otherTxIds: [b.id] });
  assert.deepEqual(deleteInvoicesInRange(l, '2026-11-01', '2026-11-30', { dryRun: true }), { count: 2, linked: 1, total: 50 });
  assert.equal(live(l.transactions).length, 5); // dry run changes nothing
  const r = deleteInvoicesInRange(l, '2026-11-01', '2026-11-30');
  assert.equal(r.count, 2);
  const left = live(l.transactions).map((t) => t.id).sort();
  assert.deepEqual(left, [a.id, m.id, card.id].sort()); // other months, manual and card kept
  assert.equal(l.transactions.find((t) => t.id === card.id).linkId, undefined); // card charge unlinked
  assert.equal(live(l.links).length, 0);
  assert.ok(l.transactions.find((t) => t.id === b.id).deleted); // tombstone for sync
  // the invoices can be imported again afterwards
  assert.equal(importInvoices(l, [{ invoiceNo: 'A2', date: '2026-11-01', merchant: 'x', amount: 20, items: [] }]).added, 1);
  void c;
});

import { findHeaderRow, guessCardColumns, statementMeta, importBankStatement, cleanCell, applyStatementMeta } from '../app/js/core/importers.js';

// Same layout as a statement page copied from a Taiwanese bank's website (tab separated,
// summary blocks above the table, card sections, a payment row, markdown links). Made-up values.
const PASTED_STATEMENT = [
  '帳單年月\t信用額度\t國內預借現金額度\t帳單結帳日\t繳款截止日\t循環信用利率',
  '115/11\t100,000\t10,000\t115/11/14\t115/11/30\t8.62%',
  '前期應繳總額\t \t繳(退)金額\t \t本期調整金額\t \t本期新增\t \t本期應繳總額(註三)\t最低應繳金額',
  '1,000\t-\t1,000\t-\t0\t+\t900\t=\t900\t90',
  '您已辦妥自動轉帳',
  '消費日期\t消費說明\t入帳日期\t外幣折算日/幣別\t外幣金額/消費地\t臺幣金額',
  '　\t前期應繳總額\t　\t　\t　\t1,000',
  '115/11/02\t自動扣繳\t115/11/03\t　\t　\t-1,000',
  'MASTER商務正卡末４碼1111\t\t\t\t',
  '115/10/20\t[測試量販店](https://bank.example/x?a=1&#)\t115/10/21\tTWD\t\t600',
  '115/11/10\t[測試量販店](https://bank.example/x?a=1&#)\t115/11/11\tTWD\t\t100',
  'VISA御璽卡 末4碼:2222\t\t\t\t',
  '115/11/11\t測試咖啡\t115/11/12\tTWD\t\t250',
  '115/11/12\t退款 測試咖啡\t115/11/13\tTWD\t\t-50',
  '　\t本期應繳總額\t　\tTWD\t　\t900',
].join('\n');

test('pasted bank statement: header row, statement facts, card sections, payments', () => {
  const rows = parseCsv(PASTED_STATEMENT);
  const h = findHeaderRow(rows);
  assert.equal(rows[h][0], '消費日期');
  const cols = guessCardColumns(rows[h]);
  assert.deepEqual(cols, { date: 0, desc: 1, amount: 5, card: -1, post: 2 });
  const meta = statementMeta(rows);
  assert.deepEqual(meta, { period: '2026-11', limit: 100000, closingDate: '2026-11-14', dueDate: '2026-11-30', previousTotal: 1000, total: 900, minimum: 90 });
  const txs = cardRowsToTransactions(rows.slice(h), { ...cols, card: undefined }, { issuerId: 'x', cards: [] });
  assert.equal(txs.length, 4); // payment row and total lines skipped
  assert.deepEqual(txs.map((t) => [t.cardLast4, t._cardLabel, t.merchant, t.amount, t.type]), [
    ['1111', 'MASTER商務正卡', '測試量販店', 600, 'expense'],
    ['1111', 'MASTER商務正卡', '測試量販店', 100, 'expense'],
    ['2222', 'VISA御璽卡', '測試咖啡', 250, 'expense'],
    ['2222', 'VISA御璽卡', '退款 測試咖啡', 50, 'income'],
  ]);
  assert.equal(cleanCell('[A店](https://x.y/z?q=1&#)'), 'A店');
});

test('statement import without any card set up: bank and cards are created, statement filed', () => {
  const l = emptyLedger();
  const rows = parseCsv(PASTED_STATEMENT);
  const h = findHeaderRow(rows);
  const txs = cardRowsToTransactions(rows.slice(h), { ...guessCardColumns(rows[h]), card: undefined }, { cards: [] });
  const r = importBankStatement(l, { bankName: '測試銀行', txs, meta: statementMeta(rows) });
  assert.equal(r.added, 4);
  assert.deepEqual(r.created.map((c) => [c.name, c.last4, c.statementLabel, c.autoCreated]), [
    ['MASTER商務正卡', '1111', 'MASTER商務正卡', true], ['VISA御璽卡', '2222', 'VISA御璽卡', true]]);
  const bank = l.issuers.find((i) => i.id === r.issuerId);
  assert.deepEqual([bank.name, bank.limit, bank.statementDay, bank.dueDay], ['測試銀行', 100000, 14, 30]);
  assert.deepEqual([r.statement.period, r.statement.total, r.statement.dueDate, r.statement.minimum], ['2026-11', 900, '2026-11-30', 90]);
  assert.ok(live(l.transactions).every((t) => t.statementId === r.statement.id && t.issuerId === r.issuerId && t.cardId));
  assert.ok(live(l.transactions).every((t) => !('_cardLabel' in t)));
  assert.equal(issuerOutstanding(l, r.issuerId).total, 900);
  // the user renames a card; the next import still finds it by its last four digits
  const master = r.created[0];
  upsert(l, 'cards', { id: master.id, name: '我的好市多卡' });
  const again = cardRowsToTransactions(rows.slice(h), { ...guessCardColumns(rows[h]), card: undefined }, { cards: live(l.cards).filter((c) => c.issuerId === r.issuerId) });
  const r2 = importBankStatement(l, { bankId: r.issuerId, txs: again, meta: statementMeta(rows) });
  assert.deepEqual([r2.added, r2.skipped, r2.created.length], [0, 4, 0]);
  assert.equal(live(l.statements).length, 1); // same period updated, not duplicated
  assert.equal(live(l.cards).length, 2);
});

test('bank aliases: the same issuer is never created twice', () => {
  for (const [a, b] of [['台北富邦商業銀行', '富邦銀行'], ['Fubon', '富邦'], ['國泰', '國泰世華商業銀行'], ['中信銀行', '中國信託'], ['星展(台灣)', '星展銀行'], ['滙豐(台灣)商業銀行', '匯豐']]) {
    assert.equal(issuerKey(a), issuerKey(b), `${a} = ${b}`);
  }
  assert.notEqual(issuerKey('華南銀行'), issuerKey('彰化銀行'));
  const l = emptyLedger();
  const a = ensureIssuer(l, '富邦銀行');
  assert.equal(ensureIssuer(l, '台北富邦銀行').id, a.id);
  assert.equal(live(l.issuers).length, 1);
});

import { parseLayoutStatement, layoutToTransactions, looksLikeLayoutText } from '../app/js/core/importers.js';

// Same layout as a bank's PDF export run through `pdftotext -layout` (made-up stores and amounts).
const LAYOUT_POSTED = `                                                                                    1/2
202611 已請款消費明細
       臺幣                              3                                  1,050
消費明細
 交易日期         入帳日期         卡片末四碼                  消費說明     臺幣金額      幣別   消費金額

 2026/10/21   2026/10/28    1111     連支＊測試煎餅              300

 2026/10/22   2026/10/29    2222     A- 測試加油站（Ｄ２１        800
                                                              2/2
2026/11/02   2026/11/02   2222   SPORT 卡豐點折抵回饋金       -50
2026/11/03   2026/11/04   1111   測試超市      1,000
`;
const LAYOUT_PENDING = ` 卡別   卡片末四碼   手機信用卡   授權日期         授權時間         消費類別/商店名稱        授權金額(臺幣)    消費國別   授權結果

 正卡    1111     否     2026/11/16   19:06:33   餐廳/LINE Pay              125    TW     成功

                                              電腦軟
 正卡    1111     否     2026/11/14   21:59:58   體/ANTHROPIC*             630    US     成功
                                              CLAUDE SUB
 正卡    1111     否     2026/11/14   18:19:35   餐廳/LINE Pay              580    TW     成功
 正卡    2222     是     2026/11/13   10:00:00   測試超市                  999    TW     失敗
 正卡    1111     否     2026/11/02   12:00:00   生鮮超市/測試超市        1,000    TW     成功
`;

test('aligned-text statements (PDF): rows, wrapped names, prefixes, refunds', () => {
  assert.ok(looksLikeLayoutText(LAYOUT_POSTED));
  assert.ok(!looksLikeLayoutText('消費日,說明,金額\n2026/11/01,a,1\n'));
  const p = parseLayoutStatement(LAYOUT_POSTED);
  assert.equal(p.pending, false);
  assert.deepEqual(p.rows.map((r) => [r.date, r.last4, r.amount]), [
    ['2026-10-21', '1111', 300], ['2026-10-22', '2222', 800], ['2026-11-02', '2222', -50], ['2026-11-03', '1111', 1000]]);
  const { txs } = layoutToTransactions(LAYOUT_POSTED, {});
  assert.deepEqual(txs.map((t) => t.merchant), ['測試煎餅', '測試加油站（Ｄ２１', 'SPORT 卡豐點折抵回饋金', '測試超市']);
  assert.equal(txs[2].type, 'income');
  const q = layoutToTransactions(LAYOUT_PENDING, {});
  assert.equal(q.pending, true);
  assert.deepEqual(q.txs.map((t) => [t.merchant, t.amount, t.cardLast4]), [
    ['餐廳/LINE Pay', 125, '1111'], ['電腦軟體/ANTHROPIC* CLAUDE SUB', 630, '1111'], ['餐廳/LINE Pay', 580, '1111'], ['生鮮超市/測試超市', 1000, '1111']]);
  assert.ok(q.txs.every((t) => t.pending)); // the 失敗 authorisation is skipped
});

test('pending authorisations are confirmed by the posted charge, not added twice', () => {
  const l = emptyLedger();
  const pend = layoutToTransactions(LAYOUT_PENDING, {}).txs;
  const r1 = importBankStatement(l, { bankName: '測試銀行', txs: pend });
  assert.deepEqual([r1.added, r1.created.length], [4, 1]);
  const card = live(l.cards)[0];
  const posted = layoutToTransactions(LAYOUT_POSTED, { cards: [card] }).txs;
  const r2 = importBankStatement(l, { bankId: r1.issuerId, txs: posted });
  assert.equal(r2.confirmed, 1); // 11/02 pending 1,000 ⇒ 11/03 posted 1,000 on card 1111
  assert.equal(r2.added, 3);
  const t = live(l.transactions).find((x) => x.authorizedMerchant === '生鮮超市/測試超市');
  assert.deepEqual([t.pending, t.date, t.merchant], [false, '2026-11-03', '測試超市']);
  assert.equal(live(l.transactions).length, 7);
  assert.equal(live(l.transactions).filter((x) => x.pending).length, 3);
  // importing the authorisations again adds nothing
  assert.equal(importBankStatement(l, { bankId: r1.issuerId, txs: layoutToTransactions(LAYOUT_PENDING, { cards: live(l.cards) }).txs }).added, 0);
});

import { installmentOf, cleanMerchant } from '../app/js/core/importers.js';

test('installments: flagged, kept on the card bill, not counted as spending or matched', () => {
  assert.deepEqual(installmentOf('網路家庭分期０１－１０'), { no: 1, of: 10 });
  assert.deepEqual(installmentOf('網路家庭分期全退０１期'), { cancelled: true });
  assert.equal(installmentOf('全家便利商店'), null);
  assert.equal(cleanMerchant('全家便利商店－常興店     TAIPEI       TW'), '全家便利商店－常興店');
  assert.equal(cleanMerchant('Ｓｕｂｗａｙ－瑞光店     TAIPEI CITY  TW'), 'Ｓｕｂｗａｙ－瑞光店');
  assert.equal(cleanMerchant('網路家庭分期０１－１０   '), '網路家庭分期０１－１０');
  const csv = '交易序號,消費日,入帳日,摘要,卡號末四碼,新臺幣金額\n'
    + '1,2026/11/11,2026/11/16,"網路家庭分期０１－１０   ",1111,"2,287"\n'
    + '2,2026/11/08,2026/11/11,"網路家庭分期０１－３０   ",1111,868\n'
    + '3,2026/11/08,2026/11/12,"網路家庭分期全退０１期   ",1111,-868\n'
    + '4,2026/11/12,2026/11/16,全家便利商店－常興店     TAIPEI       TW,1111,39\n';
  const rows = parseCsv(csv);
  const l = emptyLedger();
  const txs = cardRowsToTransactions(rows, { ...guessCardColumns(rows[0]), skipHeader: true }, { cards: [] });
  assert.deepEqual(txs.map((t) => t.merchant), ['網路家庭分期０１－１０', '網路家庭分期０１－３０', '網路家庭分期全退０１期', '全家便利商店－常興店']);
  const r = importBankStatement(l, { bankName: '測試銀行', txs });
  // the full-price purchase is on the e-invoice
  upsert(l, 'transactions', { source: 'invoice', date: '2026-11-11', amount: 22789, type: 'expense', merchant: '網路家庭', invoiceNo: 'X1' });
  upsert(l, 'transactions', { source: 'invoice', date: '2026-11-11', amount: 2287, type: 'expense', merchant: '別家', invoiceNo: 'X2' });
  assert.equal(monthSummary(l, '2026-11').expense, 22789 + 2287 + 39); // installments excluded
  assert.equal(issuerOutstanding(l, r.issuerId).total, 2287 + 868 - 868 + 39); // but owed on the card
  const m = findMatches(l);
  assert.ok([...m.auto, ...m.suggested].every((p) => !l.transactions.find((t) => t.id === p.cardTxId).installment));
});

import { linkInstallments, addInstallmentPlan, suggestInstallmentPlan } from '../app/js/core/importers.js';
import { loanBalance, unlinkedInstallments } from '../app/js/core/calc.js';

test('installment plan: remaining debt shrinks as installments reach the card, no double counting', () => {
  const l = emptyLedger();
  const csv = (no) => `交易序號,消費日,入帳日,摘要,卡號末四碼,新臺幣金額\n1,2026/${String(10 + no).padStart(2, '0')}/11,2026/11/16,"網路家庭分期０${no}－１０   ",1111,"${no === 1 ? '2,287' : '2,278'}"\n`;
  const imp = (no, bankId) => {
    const rows = parseCsv(csv(no));
    const txs = cardRowsToTransactions(rows, { ...guessCardColumns(rows[0]), skipHeader: true }, { cards: live(l.cards) });
    return importBankStatement(l, bankId ? { bankId, txs } : { bankName: '中國信託', txs });
  };
  const r1 = imp(1);
  upsert(l, 'transactions', { source: 'invoice', date: '2026-11-12', amount: 22789, type: 'expense', merchant: '網路家庭國際資訊股份有限公司', invoiceNo: 'X1', items: [{ name: '除濕機', amount: 24900 }, { name: '折扣', amount: -2111 }] });
  const pend = unlinkedInstallments(l);
  assert.equal(pend.length, 1);
  const g = suggestInstallmentPlan(l, pend[0]);
  assert.deepEqual([g.principal, g.periods, g.fromInvoice, g.shop, g.purchaseDate], [22789, 10, true, '網路家庭', '2026-11-12']);
  assert.equal(g.name, '網路家庭分期（除濕機）');
  const { loan, linked } = addInstallmentPlan(l, g);
  assert.equal(linked, 1);
  assert.equal(loanBalance(l, loan), 22789 - 2287);
  assert.equal(unlinkedInstallments(l).length, 0);
  // liabilities: card owes installment 1, plan owes the rest — together exactly the price
  const t1 = totals(l, {});
  assert.equal(t1.cards + t1.loans, 22789);
  // the next month's installment is linked on import and moves from the plan to the card
  imp(2, r1.issuerId);
  assert.equal(loanBalance(l, loan), 22789 - 2287 - 2278);
  const t2 = totals(l, {});
  assert.equal(t2.cards + t2.loans, 22789);
  // spending is the invoice only
  assert.equal(monthSummary(l, '2026-11').expense, 22789);
  assert.equal(linkInstallments(l, live(l.transactions)), 0); // nothing left to link
  // the credit line holds the whole remaining plan: used = on card + not yet billed = price
  upsert(l, 'issuers', { id: r1.issuerId, limit: 380000 });
  const u = issuerUsage(l, r1.issuerId);
  assert.equal(u.installmentHeld, 22789 - 2287 - 2278);
  assert.equal(u.used, 22789);
  assert.equal(u.available, 380000 - 22789);
  // the card balance (what is owed now) is unchanged
  assert.equal(issuerOutstanding(l, r1.issuerId).total, 2287 + 2278);
});

test('installment cancelled in full is not offered as a plan', () => {
  const l = emptyLedger();
  upsert(l, 'transactions', { source: 'card', date: '2026-11-08', amount: 868, type: 'expense', merchant: '網路家庭分期０１－３０', installment: { no: 1, of: 30 } });
  upsert(l, 'transactions', { source: 'card', date: '2026-11-08', amount: 868, type: 'income', merchant: '網路家庭分期全退０１期', installment: { cancelled: true } });
  assert.equal(unlinkedInstallments(l).length, 0);
});

test('billing follows the posting date: bought before closing, posted after → next bill', () => {
  const l = emptyLedger();
  const rows = parseCsv('交易序號,消費日,入帳日,摘要,卡號末四碼,新臺幣金額\n1,2026/10/25,2026/10/28,統一超商,1111,84\n2,2026/10/20,2026/10/22,全家,1111,50\n');
  const cols = guessCardColumns(rows[0]);
  assert.equal(cols.post, 2);
  const txs = cardRowsToTransactions(rows, { ...cols, skipHeader: true }, { cards: [] });
  assert.deepEqual(txs.map((t) => t.postDate), ['2026-10-28', '2026-10-22']);
  const r = importBankStatement(l, { bankName: '測試銀行', txs });
  applyStatementMeta(l, r.issuerId, { period: '2026-10', closingDate: '2026-10-27', total: 50 });
  // the 10/22-posted charge is on October's bill (attached? no: only by date), the 10/28 one is unbilled
  assert.equal(issuerOutstanding(l, r.issuerId).unbilled, 84);
  // older imports without postDate get it filled in when the file is imported again
  const l2 = emptyLedger();
  const bare = txs.map(({ postDate, ...t }) => t);
  const r2 = importBankStatement(l2, { bankName: '測試銀行', txs: bare });
  assert.ok(live(l2.transactions).every((t) => !t.postDate));
  importBankStatement(l2, { bankId: r2.issuerId, txs: cardRowsToTransactions(rows, { ...cols, skipHeader: true }, { cards: live(l2.cards) }) });
  assert.deepEqual(live(l2.transactions).map((t) => t.postDate).sort(), ['2026-10-22', '2026-10-28']);
  // aligned text: the second date is the posting date
  const p = parseLayoutStatement(' 2026/10/21   2026/10/28    1111     測試店              300\n');
  assert.equal(p.rows[0].postDate, '2026-10-28');
});

test('Moneybook import: accounts, credit lines, cards, bills, bank rows; re-import adds nothing', async () => {
  const { moneybookKind, importMoneybook, addBankRule } = await import('../app/js/core/moneybook.js');
  const { issuerUsage } = await import('../app/js/core/calc.js');
  const H = '金融機構/手動新增,身分證字號,機構名稱,帳戶名稱,分類,明細描述,幣別,金額,消費日,入帳日,標籤,備註,帳戶停用時間,是否排除收支';
  const row = (bank, acc, cat, desc, amt, d, p = d) => `${bank},X,${bank},${acc},${cat},${desc},TWD,${amt},${d},${p},,,,否`;
  const files = {
    accounts: ['金融機構/手動新增,身分證字號,機構名稱,帳戶名稱,幣別,信用額度,帳戶金額,可用額度,帳戶停用時間',
      '甲銀行,X,甲銀行,活存,TWD,0,1000,0,', '乙銀行,X,乙銀行,活存,TWD,0,500,0,',
      '甲銀行,X,甲銀行,信用卡,TWD,50000,-300,49700,', '乙銀行,X,乙銀行,信用卡,TWD,30000,100,30100,'].join('\n'),
    transactions: [H,
      row('甲銀行', '信用卡', '飲食', '早餐店 - 1234', -300, '2026/11/02', '2026/11/04'),
      row('甲銀行', '信用卡', '飲食', '餐廳/LINE Pay - 1234', -300, '2026/11/02'), // its authorisation
      row('甲銀行', '活存', '尚未分類', '某某公司薪資', 40000, '2026/11/05'),
      row('甲銀行', '活存', '尚未分類', '乙銀行1234', -2000, '2026/11/06'),
      row('乙銀行', '活存', '尚未分類', '跨行轉入 - 123456789', 2000, '2026/11/06'),
      row('乙銀行', '活存', '學貸利息', '借款利息 - 999000000000001', -134, '2026/11/02'),
      row('乙銀行', '活存', '繳信用卡費', '信用卡費 - 1234', -800, '2026/10/10'),
      row('乙銀行', '活存', '尚未分類', 'line pay money儲值交易', -500, '2026/11/07'),
    ].join('\n'),
    bills: ['金融機構,帳單類型,帳單金額,最低應繳金額,繳費截止日', '甲銀行,信用卡,800.00,100.00,2026/10/10', '甲銀行,信用卡,0.00,0.00,2026/12/10'].join('\n'),
  };
  assert.equal(moneybookKind(files.accounts), 'accounts');
  assert.equal(moneybookKind(files.transactions), 'transactions');
  assert.equal(moneybookKind(files.bills), 'bills');
  const l = emptyLedger();
  upsert(l, 'issuers', { id: 'iss_a', name: '甲銀行', statementDay: 26, dueDay: 10 });
  const r = importMoneybook(l, files);
  assert.equal(live(l.accounts).length, 2);
  assert.equal(r.cards[0].added, 1, 'authorisation of a posted charge is not added again');
  assert.equal(live(l.transactions).find((t) => t.source === 'card').postDate, '2026-11-04');
  const stm = live(l.statements).find((s) => s.dueDate === '2026-10-10');
  assert.equal(stm.closingDate, '2026-09-26');
  assert.equal(stm.paidAmount, 800);
  assert.equal(stm.paidDate, '2026-10-10');
  assert.equal(live(l.statements).find((s) => s.dueDate === '2026-12-10').paidAmount, 0, 'future bills stay unpaid');
  assert.equal(r.bank.transfers, 2, 'transfer between own accounts');
  assert.deepEqual(r.bank.added.map((t) => t.category), ['貸款利息']);
  assert.equal(r.bank.unknown.length, 1);
  // a credit balance on the card is money the bank owes us
  const b = live(l.issuers).find((i) => i.name === '乙銀行');
  assert.equal(b.overpaid, 100);
  assert.equal(issuerUsage(l, b.id).used, 0);
  // a rule decides the unknown row; importing again adds only that
  addBankRule(l, { match: '某某公司', type: 'income', category: '薪資' });
  const n = live(l.transactions).length;
  const r2 = importMoneybook(l, files);
  assert.equal(live(l.transactions).length, n + 1);
  assert.equal(r2.bank.added[0].category, '薪資');
  assert.equal(r2.statements.added, 0);
  assert.equal(r2.cards[0].added, 0);
  assert.equal(importMoneybook(l, files).bank.added.length, 0);
});

test('Moneybook invoices: totals fix line sums, missing ones inside the MOF period are voided', async () => {
  const { importMoneybook } = await import('../app/js/core/moneybook.js');
  const l = emptyLedger();
  upsert(l, 'transactions', { date: '2026-10-01', amount: 456, type: 'expense', source: 'invoice', merchant: 'Google', invoiceNo: 'AB1', items: [{ name: 'x', amount: 456 }] });
  upsert(l, 'transactions', { date: '2026-10-20', amount: 50, type: 'expense', source: 'invoice', merchant: '全家', invoiceNo: 'AB2', items: [] });
  const invoices = ['載具號碼,載具名稱,購買時間,商家名稱,發票金額', '/A,,2026-10-01 10:00:00,Google,479.00',
    '/A,,2026-10-05 10:00:00,文采,868.00', '/A,,2026-09-30 18:00:00,和德昌,709.00'].join('\n');
  const items = ['載具號碼,載具名稱,購買時間,商家名稱,品項,品項數量,品項單價,總價', '/A,,2026-09-30 18:00:00,和德昌,堡,1,709,709'].join('\n');
  const r = importMoneybook(l, { invoices, items });
  assert.equal(live(l.transactions).find((t) => t.invoiceNo === 'AB1').amount, 479);
  assert.deepEqual(r.invoices.voided.map((i) => i.merchant), ['文采']);
  assert.equal(r.invoices.added[0].merchant, '和德昌');
  // the MOF file imported again keeps the corrected total
  importInvoices(l, [{ invoiceNo: 'AB1', date: '2026-10-01', amount: 456, merchant: 'Google', items: [{ name: 'x', amount: 456 }] }]);
  assert.equal(live(l.transactions).find((t) => t.invoiceNo === 'AB1').amount, 479);
  assert.equal(importMoneybook(l, { invoices, items }).invoices.added.length, 0);
});

test('bill due dates follow month length and can fall in the previous month', async () => {
  const { billDueDate } = await import('../app/js/core/calc.js');
  const b = { cycle: 'monthly', startMonth: '2026-11', dueDay: 31, payments: [] };
  assert.equal(billDueDate(b, '2027-02'), '2027-02-28');
  assert.equal(billDueDate(b, '2028-02'), '2028-02-29');
  assert.equal(billDueDate(b, '2026-11'), '2026-11-30');
  // rent for December is paid by the end of November
  const rent = { cycle: 'monthly', startMonth: '2026-11', dueDay: 31, dueMonthOffset: -1, payments: [{ period: '2026-11' }] };
  assert.equal(billDueDate(rent, '2026-12'), '2026-11-30');
  assert.equal(billDueDate(rent, '2027-03'), '2027-02-28');
  const s = billStatus(rent, '2026-11-17');
  assert.deepEqual([s.period, s.dueDate, s.state], ['2026-12', '2026-11-30', 'due']);
  assert.equal(billStatus(rent, '2026-12-01').state, 'overdue');
  rent.payments.push({ period: '2026-12' });
  // December paid: January's rent (due 12/31) is the next thing to pay
  assert.deepEqual([billStatus(rent, '2026-12-05').period, billStatus(rent, '2026-12-05').state], ['2027-01', 'due']);
});

test('long-term loans are listed apart from net worth', () => {
  const l = emptyLedger();
  upsert(l, 'accounts', { name: 'a', balance: 1000 });
  upsert(l, 'loans', { name: '學貸', kind: 'student', balance: 5000 });
  upsert(l, 'loans', { name: '借款', kind: 'other', balance: 200 });
  upsert(l, 'loans', { name: '信貸但一年內還清', kind: 'credit', term: 'short', balance: 100 });
  const t = totals(l, {});
  assert.deepEqual([t.shortTerm, t.longTerm, t.netWorth, t.netWorthAll], [300, 5000, 700, -4300]);
});

test('delivery platform fee invoices merge into the order charge', () => {
  const l = emptyLedger();
  const card = upsert(l, 'transactions', { date: '2026-11-05', amount: 359, type: 'expense', source: 'card', cardId: 'c', merchant: 'ｆｏｏｄｐａｎｄａ－Ｅ' });
  upsert(l, 'transactions', { date: '2026-11-05', amount: 9, type: 'expense', source: 'invoice', merchant: '富胖達股份有限公司' });
  upsert(l, 'transactions', { date: '2026-11-05', amount: 9, type: 'expense', source: 'invoice', merchant: '全家便利商店' });
  const m = findMatches(l);
  const fee = m.suggested.filter((p) => p.kind === 'fee');
  assert.equal(fee.length, 1);
  assert.equal(fee[0].cardTxId, card.id);
  assert.match(l.transactions.find((t) => t.id === fee[0].otherTxIds[0]).merchant, /富胖達/);
});

test('top-ups are on the card but not spending; platform fee + restaurant invoice = the charge', async () => {
  const { notSpending } = await import('../app/js/core/calc.js');
  const l = emptyLedger();
  upsert(l, 'transactions', { date: '2026-10-23', amount: 500, type: 'expense', source: 'card', cardId: 'c', merchant: '安心食品', topUp: true });
  upsert(l, 'transactions', { date: '2026-10-23', amount: 369, type: 'expense', source: 'invoice', merchant: '安心食品服務股份有限公司' });
  assert.equal(monthSummary(l, '2026-10').expense, 369);
  assert.ok(notSpending({ source: 'card', topUp: true }));
  assert.equal(findMatches(l).suggested.length + findMatches(l).auto.length, 0, 'a top-up is not matched to invoices');
  const card = upsert(l, 'transactions', { date: '2026-11-02', amount: 689, type: 'expense', source: 'card', cardId: 'c', merchant: '富胖達－樂興牛排館' });
  upsert(l, 'transactions', { date: '2026-11-02', amount: 9, type: 'expense', source: 'invoice', merchant: '富胖達股份有限公司' });
  upsert(l, 'transactions', { date: '2026-11-02', amount: 680, type: 'expense', source: 'invoice', merchant: '樂興牛排館' });
  const fee = findMatches(l).suggested.find((p) => p.cardTxId === card.id);
  assert.equal(fee.kind, 'fee');
  assert.equal(fee.otherTxIds.length, 2);
});

test('brand aliases: invoice company names match card statement brands', () => {
  assert.ok(nameSimilarity('連支＊麥當勞', '和德昌股份有限公司台北舊宗二分公司') >= 0.9);
  assert.ok(nameSimilarity('LPEPI*McDonalds', '和德昌股份有限公司') >= 0.9);
  assert.ok(nameSimilarity('連加＊ＬＩＮＥＰＡＹ＊ＣｏｕＰＡＮｇ', '酷澎股份有限公司') >= 0.9);
  assert.ok(nameSimilarity('全家', '萊爾富') < 0.5);
});

test('excluded rows, card labels and fixed monthly income', async () => {
  const { cardLabel, incomeStatus } = await import('../app/js/core/calc.js');
  const { importMoneybook } = await import('../app/js/core/moneybook.js');
  const l = emptyLedger();
  upsert(l, 'issuers', { id: 'iss_x', name: '永豐銀行' });
  upsert(l, 'cards', { id: 'crd_x', name: '大戶卡', last4: '1111', issuerId: 'iss_x' });
  const c = upsert(l, 'transactions', { date: '2026-11-02', amount: 100, type: 'expense', source: 'card', cardId: 'crd_x', merchant: 'x' });
  assert.equal(cardLabel(l, c), '永豐銀行 ****1111');
  assert.equal(cardLabel(l, { source: 'card', issuerId: 'iss_x' }), '永豐銀行（未對應卡號）');
  upsert(l, 'transactions', { date: '2026-11-03', amount: 479, type: 'expense', source: 'invoice', merchant: 'Google', excluded: true });
  assert.equal(monthSummary(l, '2026-11').expense, 100, 'paid by someone else');
  assert.equal(findMatches(l).suggested.length, 0);
  // salary: matched by keyword, change from last month shown
  const pay = upsert(l, 'bills', { kind: 'income', name: '薪資', category: '薪資', amount: 47000, cycle: 'monthly', dueDay: 5, startMonth: '2026-10', match: '合作金庫' });
  upsert(l, 'transactions', { date: '2026-10-05', amount: 48800, type: 'income', source: 'bank', category: '薪資', merchant: '薪資（合作金庫）' });
  assert.equal(incomeStatus(l, pay, '2026-11-04').state, 'upcoming');
  assert.equal(incomeStatus(l, pay, '2026-11-06').state, 'late');
  upsert(l, 'transactions', { date: '2026-11-05', amount: 45678, type: 'income', source: 'manual', category: '薪資', merchant: '薪資', billId: pay.id });
  const s = incomeStatus(l, pay, '2026-11-06');
  assert.deepEqual([s.state, s.amount, s.change, s.diff], ['received', 45678, -3122, -1322]);
  // the bank export of the same salary does not add it again
  const H = '金融機構/手動新增,身分證字號,機構名稱,帳戶名稱,分類,明細描述,幣別,金額,消費日,入帳日,標籤,備註,帳戶停用時間,是否排除收支';
  const r = importMoneybook(l, { transactions: `${H}\n連線銀行,X,連線銀行,主帳戶,薪資,合作金庫商業銀行 *******12345,TWD,45678,2026/11/05,2026/11/05,,,,否` });
  assert.equal(r.bank.added.length, 0);
  assert.equal(live(l.transactions).filter((t) => t.type === 'income').length, 2);
});

test('investment plan: upcoming payments first, reserve kept, the rest can be invested', async () => {
  const { investmentPlan } = await import('../app/js/core/plan.js');
  const l = emptyLedger();
  upsert(l, 'accounts', { name: '活存', type: 'bank', balance: 100000 });
  upsert(l, 'accounts', { name: '證券戶', type: 'securities', balance: 50000 });
  upsert(l, 'issuers', { id: 'iss_a', name: '甲銀行', statementDay: 20, dueDay: 5 });
  upsert(l, 'transactions', { date: '2026-11-10', amount: 6000, type: 'expense', source: 'card', issuerId: 'iss_a', merchant: 'x' });
  upsert(l, 'bills', { name: '房租', category: '居住', amount: 10000, cycle: 'monthly', dueDay: 31, dueMonthOffset: -1, startMonth: '2026-11', payments: [{ period: '2026-11' }] });
  upsert(l, 'bills', { kind: 'income', name: '薪資', category: '薪資', amount: 50000, cycle: 'monthly', dueDay: 5, startMonth: '2026-11', match: '公司' });
  upsert(l, 'transactions', { date: '2026-11-05', amount: 50000, type: 'income', source: 'bank', category: '薪資', merchant: '公司' });
  const r = investmentPlan(l, {}, '2026-11-17', { horizonDays: 30, reserveMonths: 1, livingMonthly: 15000 });
  assert.equal(r.cash.total, 100000, 'securities cash is not spending money');
  assert.deepEqual(r.flows.map((f) => [f.date, f.amount]), [['2026-11-30', -10000], ['2026-12-05', -6000], ['2026-12-05', 50000]]);
  // lowest point just before payday: 100000 − 10000 rent − 18 days of cash spending (card share 0 here)
  assert.equal(r.low.date, '2026-12-04');
  assert.equal(Math.round(r.low.balance), 100000 - 10000 - 15000 / 30 * 17);
  assert.equal(r.reserve, 25000);
  assert.equal(r.investNow, Math.round(r.low.balance - 25000));
  assert.equal(r.monthlySurplus, 25000);
  assert.equal(r.verdict, 'invest');
  // not enough cash: no investment, and the gap is reported
  const tight = investmentPlan(l, {}, '2026-11-17', { horizonDays: 30, reserveMonths: 4, livingMonthly: 15000 });
  assert.equal(tight.investNow, 0);
  assert.equal(tight.verdict, 'hold');
});

test('pay slips become salary income; a bank deposit gets the detail; bonuses are their own income', async () => {
  const { importPayslips, checkPayslip } = await import('../app/js/core/payslip.js');
  const l = emptyLedger();
  const bank = upsert(l, 'transactions', { date: '2026-10-05', amount: 48800, type: 'income', source: 'bank', category: '薪資', merchant: '薪資（合作金庫）' });
  const doc = {
    employer: '公司', payday: 5,
    slips: [
      { month: '2026-08', earnings: { 本薪: 48900, 伙食津貼: 2400 }, deductions: { 勞保費: 1145 }, gross: 51300, deductionTotal: 1145, net: 50155 },
      { month: '2026-09', earnings: { 本薪: 48900 }, deductions: { 勞保費: 500 }, gross: 48900, deductionTotal: 500, net: 48400 },
      { month: '2026-10', earnings: { 本薪: 100 }, deductions: {}, gross: 100, deductionTotal: 0, net: 90 },
    ],
    bonuses: [{ month: '2026-04', name: '績效獎金', gross: 96888, tax: 4844, net: 92044, paidDate: '2026-04-15' }],
  };
  assert.equal(checkPayslip(doc.slips[2]).length, 1, 'totals that do not add up are rejected');
  const r = importPayslips(l, doc);
  assert.deepEqual([r.added, r.attached, r.bonuses, r.errors.length, r.differences.length], [1, 1, 1, 1, 1]);
  const aug = live(l.transactions).find((t) => t.payslip === '2026-08');
  assert.deepEqual([aug.date, aug.amount, aug.category], ['2026-09-05', 50155, '薪資']);
  assert.equal(aug.items.find((i) => i.name === '勞保費').amount, -1145);
  const sep = live(l.transactions).find((t) => t.id === bank.id);
  assert.deepEqual([sep.payslip, sep.amount], ['2026-09', 48800], 'the bank amount stays');
  const n = live(l.transactions).length;
  importPayslips(l, doc);
  assert.equal(live(l.transactions).length, n, 're-import adds nothing');
  assert.equal(monthSummary(l, '2026-04').income, 92044);
});

test('one-off spending still counts as spending but not in the daily average', async () => {
  const { livingEstimate } = await import('../app/js/core/plan.js');
  const l = emptyLedger();
  upsert(l, 'transactions', { date: '2026-11-02', amount: 3000, type: 'expense', source: 'manual', merchant: '日常', category: '餐飲' });
  const card = upsert(l, 'transactions', { date: '2026-11-01', amount: 1000, type: 'expense', source: 'card', cardId: 'c', merchant: '小北' });
  const inv = upsert(l, 'transactions', { date: '2026-11-01', amount: 1000, type: 'expense', source: 'invoice', merchant: '文采', oneOff: true });
  // before the first card statement only invoices exist: that stretch is not averaged
  upsert(l, 'transactions', { date: '2026-10-20', amount: 9999, type: 'expense', source: 'invoice', merchant: '更早' });
  applyLink(l, { cardTxId: card.id, otherTxIds: [inv.id] });
  const r = livingEstimate(l, '2026-11-30');
  assert.equal(r.monthly, 3000, 'the flag on the merged invoice is enough');
  assert.equal(r.markedTotal, 1000);
  assert.equal(monthSummary(l, '2026-11').expense, 4000);
});

test('split app import: my share counts, the rest is owed, repayments settle, re-import adds nothing', async () => {
  const { parseSplitCsv, importSplits, absorbSplitPlaceholders } = await import('../app/js/core/split.js');
  const { splitBalances, totals } = await import('../app/js/core/calc.js');
  const csv = [
    '"2026/10","","","建立時間","2026-10-01"', '"費用/使用者","","我","她"',
    '"26/10/30 還款","還款者","","500.0"', '"","收款者","-500.0",""',
    '"26/10/28 燒肉","付款者","2000.0",""', '"","應分攤","-1000.0","-1000.0"',
    '"26/10/25 拉麵","付款者","710.0","10.0"', '"","應分攤","-405.0","-315.0"',
    '"26/10/20 演唱會","付款者","","3000.0"', '"","應分攤","-1500.0","-1500.0"',
    '"26/10/10 早午餐","付款者","300.0",""', '"","應分攤","-150.0","-150.0"',
    '"26/09/20 舊的","付款者","400.0",""', '"","應分攤","","-400.0"',
  ].join('\n');
  const f = parseSplitCsv(csv);
  assert.deepEqual([f.group, f.me, f.other, f.entries.length], ['2026/10', '我', '她', 6]);
  const l = emptyLedger();
  const card = upsert(l, 'transactions', { date: '2026-10-28', amount: 2000, type: 'expense', source: 'card', cardId: 'c', merchant: '燒肉店', category: '餐飲' });
  const r = importSplits(l, [f], { from: '2026-10-01' });
  assert.deepEqual([r.matched.length, r.placeholders.length, r.theyPaid.length, r.settlements.length, r.skippedBefore], [1, 2, 1, 1, 1]);
  assert.equal(live(l.transactions).find((t) => t.id === card.id).split.mine, 1000);
  // balance: 1000 (燒肉) + 305 (拉麵) − 1500 (她付演唱會) + 150 (早午餐) + 400 (before the start date) − 500 repaid
  assert.equal(splitBalances(l)[0].balance, -145);
  assert.equal(totals(l, {}).payables, 145);
  // October spending = my shares only
  assert.equal(monthSummary(l, '2026-10').expense, 1000 + 405 + 1500 + 150);
  assert.equal(monthSummary(l, '2026-10').income, 0, 'a repayment is not income');
  const n = live(l.transactions).length;
  importSplits(l, [f], { from: '2026-10-01' });
  assert.equal(live(l.transactions).length, n);
  // the card statement for 早午餐 arrives later: it takes over the placeholder
  const later = upsert(l, 'transactions', { date: '2026-10-11', amount: 300, type: 'expense', source: 'card', cardId: 'c', merchant: '早午餐店' });
  assert.equal(absorbSplitPlaceholders(l, [later.id]), 1);
  assert.equal(live(l.transactions).length, n);
  assert.equal(live(l.transactions).find((t) => t.id === later.id).split.mine, 150);
  assert.equal(splitBalances(l)[0].balance, -145);
});

test('cash forecast: gap date and size, scenarios, planned items, remedies', async () => {
  const { cashForecast, findGaps } = await import('../app/js/core/forecast.js');
  const l = emptyLedger();
  upsert(l, 'accounts', { name: '活存', type: 'bank', balance: 10000 });
  upsert(l, 'bills', { name: '房租', category: '居住', amount: 12000, cycle: 'monthly', dueDay: 1, startMonth: '2026-12', payments: [] });
  upsert(l, 'bills', { kind: 'income', name: '薪資', category: '薪資', amount: 10000, cycle: 'monthly', dueDay: 5, startMonth: '2026-12' });
  upsert(l, 'bills', { kind: 'forecast', name: '年終', direction: 'in', amount: 50000, date: '2027-02-15', certain: false });
  upsert(l, 'holdings', { symbol: '0050.TW', shares: 1000, avgCost: 50, currency: 'TWD' });
  l.settings.plan = { livingMonthly: 0, reserveMonths: 0 };
  const prices = { quotes: { '0050.TW': { price: 100, currency: 'TWD' } } };
  const c = cashForecast(l, prices, '2026-11-17', { scenario: 'conservative', months: 6 });
  assert.equal(c.need.start, '2026-12-01');
  // −2,000 on 12/1, +10,000 on 12/5, −2,000 a month after: deepest at the last rent before the end
  assert.ok(c.need.amount >= 2000);
  assert.ok(c.need.structural);
  const sell = c.remedies.sell[0];
  assert.ok(sell.enough && sell.shares * 100 - sell.cost >= c.need.amount);
  assert.equal(sell.sellBy, '2026-11-27', 'T+2 business days before 12/1 (a Tuesday)');
  const e = cashForecast(l, prices, '2026-11-17', { scenario: 'expected', months: 6 });
  assert.ok(e.need.end, 'the bonus closes the gap in the expected scenario');
  assert.ok(e.need.amount < c.need.amount);
  assert.deepEqual(findGaps([{ date: '2026-12-01', balance: 5 }, { date: '2026-12-02', balance: -3 }, { date: '2026-12-03', balance: 1 }]).map((g) => [g.start, g.end, g.amount]), [['2026-12-02', '2026-12-03', 3]]);
});

// ---- 備款時程 (payment schedule) -------------------------------------------------------------
function scheduleLedger(cash) {
  const l = emptyLedger();
  upsert(l, 'accounts', { name: '活存', type: 'bank', balance: cash });
  upsert(l, 'issuers', { id: 'iss_a', name: '甲銀行', statementDay: 19, dueDay: 6 });
  // 12/06 is a Sunday: pay on Friday 12/04
  upsert(l, 'statements', { issuerId: 'iss_a', period: '2026-11', closingDate: '2026-11-19', dueDate: '2026-12-06', total: 9000, paidAmount: 0 });
  // a bank without closing / due days: the date of its charges is a guess (30 days out → Saturday 12/26 → Friday 12/25)
  upsert(l, 'issuers', { id: 'iss_b', name: '乙銀行' });
  upsert(l, 'transactions', { date: '2026-11-20', amount: 3000, type: 'expense', source: 'card', issuerId: 'iss_b', merchant: 'x' });
  upsert(l, 'bills', { name: '房租', category: '居住', amount: 10000, cycle: 'monthly', dueDay: 31, dueMonthOffset: -1, startMonth: '2026-11', payments: [{ period: '2026-11' }] });
  upsert(l, 'bills', { kind: 'income', name: '薪資', category: '薪資', amount: 50000, cycle: 'monthly', dueDay: 5, startMonth: '2026-11', match: '公司' });
  upsert(l, 'transactions', { date: '2026-11-05', amount: 50000, type: 'income', source: 'bank', category: '薪資', merchant: '公司' });
  return l;
}

test('payment schedule: weekend payments move to Friday, estimates and guessed dates are marked', async () => {
  const { paymentSchedule, payDate, yearEnd } = await import('../app/js/core/schedule.js');
  assert.equal(payDate('2026-12-05'), '2026-12-04'); // Saturday
  assert.equal(payDate('2026-12-06'), '2026-12-04'); // Sunday
  assert.equal(payDate('2026-12-07'), '2026-12-07'); // Monday
  assert.equal(yearEnd('2026-06-01'), '2026-12-31');
  assert.equal(yearEnd('2026-12-20'), '2027-12-31', 'a year that is nearly over looks at the next one');

  const s = paymentSchedule(scheduleLedger(40000), {}, '2026-11-26', { horizonDays: 60 });
  assert.deepEqual(s.rows.map((r) => [r.date, r.balance]), [
    ['2026-11-30', 30000], ['2026-12-04', 21000], ['2026-12-05', 71000], ['2026-12-25', 68000], ['2026-12-31', 58000], ['2027-01-05', 108000],
  ]);
  const card = s.rows[1].items[0];
  assert.deepEqual([card.dueDate, card.shifted], ['2026-12-06', true]);
  const guess = s.rows[3].items[0];
  assert.deepEqual([guess.estimated, guess.dateGuess], [true, true]);
  assert.equal(s.rows[0].items[0].estimated, undefined, 'rent is a fixed amount');
  assert.equal(s.rows[2].items[0].shifted, false, 'income is not moved');
  assert.deepEqual(s.warnings.guessed, ['乙銀行']);
  assert.equal(s.estimatedTotal, 3000);
  assert.equal(s.ok, true);
  assert.equal(s.first, null);
  assert.equal(s.totalNeed, 0);
  assert.equal(s.cash.total, 40000);
});

test('payment schedule: how much has to be raised by when, and a later gap only needs the difference', async () => {
  const { paymentSchedule } = await import('../app/js/core/schedule.js');
  const l = scheduleLedger(5000);
  upsert(l, 'ious', { person: '友', direction: 'iOwe', amount: 90000, dueDate: '2027-01-10' }); // Sunday → Friday 1/8
  const s = paymentSchedule(l, {}, '2026-11-26', { horizonDays: 75 });
  const by = Object.fromEntries(s.rows.map((r) => [r.date, r]));
  // rent on 11/30 leaves −5000, the card bill on 12/04 −14000; salary on 12/05 brings it back
  assert.deepEqual([by['2026-11-30'].shortfall, by['2026-11-30'].raise], [5000, 5000]);
  assert.deepEqual([by['2026-12-04'].shortfall, by['2026-12-04'].raise, by['2026-12-04'].need], [14000, 9000, 14000]);
  assert.equal(by['2026-12-05'].raise, 0);
  // 1/8: repaying 90000 → −17000, then rent on Friday 1/29 (due Sunday 1/31) → −27000
  assert.deepEqual([by['2027-01-08'].balance, by['2027-01-29'].balance], [-17000, -27000]);
  assert.equal(s.episodes.length, 2);
  assert.deepEqual(
    s.episodes.map((e) => [e.start, e.end, e.amount, e.additional]),
    [['2026-11-30', '2026-12-05', 14000, 14000], ['2027-01-08', '2027-02-05', 27000, 13000]],
  );
  assert.equal(s.totalNeed, 27000, 'money raised for the first gap is still there for the second');
  assert.equal(s.ok, false);
  assert.deepEqual([s.low.date, s.low.balance], ['2027-01-29', -27000]);
});

test('payment schedule: the overview alert only shows a gap that starts soon', async () => {
  const { paymentAlert } = await import('../app/js/core/schedule.js');
  assert.deepEqual(paymentAlert(scheduleLedger(5000), {}, '2026-11-26', 30), { start: '2026-11-30', end: '2026-12-05', amount: 14000, days: 4 });
  assert.equal(paymentAlert(scheduleLedger(40000), {}, '2026-11-26', 30), null, 'enough money: no alert');
  // repaying 70000 on 12/30 (34 days away) and the January rent on 12/31 leave a gap until the 1/5 salary
  const l = scheduleLedger(40000);
  upsert(l, 'ious', { person: '友', direction: 'iOwe', amount: 70000, dueDate: '2026-12-30' });
  assert.equal(paymentAlert(l, {}, '2026-11-26', 30), null, 'it starts after the 30 days: not shown yet');
  assert.deepEqual(paymentAlert(l, {}, '2026-11-26', 40), { start: '2026-12-30', end: '2027-01-05', amount: 12000, days: 34 });
});

test('payment schedule: an overdue payment is due today and keeps its original date', async () => {
  const { paymentSchedule } = await import('../app/js/core/schedule.js');
  const l = emptyLedger();
  upsert(l, 'accounts', { name: '活存', type: 'bank', balance: 1000 });
  upsert(l, 'issuers', { id: 'iss_a', name: '甲銀行', statementDay: 19, dueDay: 6 });
  upsert(l, 'statements', { issuerId: 'iss_a', period: '2026-10', closingDate: '2026-10-19', dueDate: '2026-11-06', total: 4000, paidAmount: 0 });
  const s = paymentSchedule(l, {}, '2026-11-26', { horizonDays: 30 });
  assert.equal(s.rows.length, 1);
  assert.deepEqual([s.rows[0].date, s.rows[0].items[0].dueDate, s.rows[0].shortfall], ['2026-11-26', '2026-11-06', 3000]);
});

test('CLI bank: showing a bank never rewrites the ledger; only a real change is saved', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../tools/ledger.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'ledger-bank-'));
  try {
    const file = join(dir, 'ledger.json');
    const l = emptyLedger();
    upsert(l, 'issuers', { id: 'iss_a', name: '甲銀行', limit: 100000, statementDay: 20, dueDay: 5 });
    writeFileSync(file, `${JSON.stringify(l, null, 1)}\n`);
    const bytes = () => readFileSync(file, 'utf8');
    const run = (...args) => spawnSync(process.execPath, [cli, 'bank', ...args, '--file', file], { encoding: 'utf8' });
    const issuers = () => live(JSON.parse(bytes()).issuers);
    const original = bytes();

    // only looking, and setting what is already set: the file is not touched
    const show = run('--bank', '甲銀行');
    assert.equal(show.status, 0);
    assert.match(show.stdout, /甲銀行.*結帳日 20.*繳款日 5/);
    assert.equal(bytes(), original, 'a query must not rewrite the ledger');
    assert.equal(run('--bank', '甲銀行', '--statement-day', '20', '--due-day', '5').status, 0);
    assert.equal(bytes(), original, 'setting the same values is not a change');

    // a bank that does not exist is an error, not a new bank
    const missing = run('--bank', '不存在銀行');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /找不到銀行/);
    assert.equal(bytes(), original);

    // a real change is saved
    assert.equal(run('--bank', '甲銀行', '--statement-day', '27').status, 0);
    assert.equal(issuers().find((i) => i.id === 'iss_a').statementDay, 27);
    assert.notEqual(bytes(), original);

    // a new bank needs at least one setting
    assert.equal(run('--bank', '乙銀行', '--limit', '50000').status, 0);
    assert.equal(issuers().find((i) => i.name === '乙銀行')?.limit, 50000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
