// Moneybook export import. Moneybook collects most Taiwanese banks into five CSV files:
//   帳戶（accounts：balances and credit lines）、交易明細（transactions：bank accounts and cards）、
//   帳單（bills：card bills with due dates）、發票（invoices：one row per e-invoice）、發票明細（items）.
// Each part can be imported alone; re-importing the same files adds nothing.
import { live, upsert, ensureIssuer, issuerKey } from './model.js';
import { parseCsv, guessCategory, importBankStatement, cleanMerchant } from './importers.js';
import { issuerOutstanding, loanBalance } from './calc.js';
import { round2, normalizeName, ymd, sum } from './util.js';

const KINDS = [
  ['transactions', ['明細描述', '消費日', '入帳日']],
  ['accounts', ['信用額度', '帳戶金額']],
  ['bills', ['帳單金額', '繳費截止日']],
  ['items', ['品項', '品項單價']],
  ['invoices', ['發票金額', '商家名稱']],
];

/** Which Moneybook export a CSV text is ('transactions' | 'accounts' | 'bills' | 'items' | 'invoices' | null). */
export function moneybookKind(text) {
  const head = String(text || '').replace(/^﻿/, '').split(/\r?\n/, 1)[0];
  return KINDS.find(([, keys]) => keys.every((k) => head.includes(k)))?.[0] || null;
}

export function moneybookRows(text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  const head = (rows[0] || []).map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((c) => String(c).trim()))
    .map((r) => Object.fromEntries(head.map((k, i) => [k, String(r[i] ?? '').trim()])));
}

const day = (s) => String(s || '').replace(/\//g, '-').slice(0, 10);
const money = (s) => Number(String(s || '').replace(/,/g, '')) || 0;
const DAY = 86400000;
const near = (a, b, days) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;

/* ---------- accounts ---------- */

export const moneybookAccountKey = (r) => `${r['機構名稱']}|${r['帳戶名稱']}`;
const accountName = (r) => (r['帳戶名稱'] === r['機構名稱'] ? r['機構名稱'] : `${r['機構名稱']} ${r['帳戶名稱']}`);
const isCardRow = (r) => r['帳戶名稱'] === '信用卡';

export function findMoneybookAccount(ledger, r, rows = []) {
  const key = moneybookAccountKey(r);
  const accs = live(ledger.accounts);
  const free = accs.filter((a) => !a.moneybookKey);
  const hit = accs.find((a) => a.moneybookKey === key)
    || free.find((a) => a.name === accountName(r) || a.name === `${r['機構名稱']} ${r['帳戶名稱']}`);
  if (hit || !rows.length) return hit || null;
  // an account the user named after the bank ("連線銀行", "富邦銀行"): the bank's one account with money in it
  const mine = free.filter((a) => issuerKey(a.name) === issuerKey(r['機構名稱']));
  const theirs = rows.filter((x) => !isCardRow(x) && x['機構名稱'] === r['機構名稱'] && (x['幣別'] || 'TWD') === 'TWD');
  const main = theirs.length === 1 ? theirs[0] : theirs.find((x) => x['帳戶名稱'] === '主帳戶') || (theirs.filter((x) => money(x['帳戶金額'])).length === 1 ? theirs.find((x) => money(x['帳戶金額'])) : null);
  return mine.length === 1 && main === r ? mine[0] : null;
}

function accountType(r) {
  if (/悠遊卡|一卡通|icash|pay/i.test(r['機構名稱'])) return 'ewallet';
  if (/證券|交割/.test(r['帳戶名稱'])) return 'securities';
  return 'bank';
}

function importAccounts(ledger, rows, asOf, report) {
  for (const r of rows.filter((x) => !isCardRow(x))) {
    const balance = round2(money(r['帳戶金額']));
    const a = findMoneybookAccount(ledger, r, rows);
    if (a) {
      const patch = { id: a.id, moneybookKey: moneybookAccountKey(r) };
      // a balance the user set after the export (e.g. a debit Moneybook only saw as 圈存) stays
      if (round2(a.balance) !== balance && !(a.balanceDate && a.balanceDate > asOf)) {
        Object.assign(patch, { balance, balanceDate: asOf });
        report.accounts.push({ name: a.name, from: a.balance, to: balance });
      }
      if (patch.balance !== undefined || a.moneybookKey !== patch.moneybookKey) upsert(ledger, 'accounts', patch);
    } else if (balance) {
      const created = upsert(ledger, 'accounts', {
        name: accountName(r), type: accountType(r), currency: r['幣別'] || 'TWD', balance, balanceDate: asOf,
        moneybookKey: moneybookAccountKey(r), note: 'Moneybook 匯入',
      });
      report.accounts.push({ name: created.name, from: null, to: balance });
    }
  }
}

/** Credit lines; a positive card balance is money the bank owes us (溢繳款). Run after the card rows. */
function importCreditLines(ledger, rows, report) {
  for (const r of rows.filter(isCardRow)) {
    const bank = ensureIssuer(ledger, r['機構名稱']);
    const limit = money(r['信用額度']);
    const balance = money(r['帳戶金額']);
    const patch = {};
    if (limit && Number(bank.limit) !== limit) patch.limit = limit;
    // what the ledger owes this bank without any credit balance, so the credit makes the totals agree
    const owed = issuerOutstanding(ledger, bank.id);
    const before = round2(owed.total + owed.overpaid);
    const overpaid = balance > 0 ? round2(Math.max(0, balance + before)) : 0;
    if ((Number(bank.overpaid) || 0) !== overpaid) patch.overpaid = overpaid;
    if (Object.keys(patch).length) {
      upsert(ledger, 'issuers', { id: bank.id, ...patch });
      report.banks.push({ name: bank.name, ...patch });
    }
    // used credit as Moneybook sees it vs the ledger (Moneybook counts pending authorisations too)
    const held = sum(live(ledger.loans).filter((l) => l.kind === 'installment' && l.issuerId === bank.id), (l) => loanBalance(ledger, l));
    const o = issuerOutstanding(ledger, bank.id);
    const ledgerUsed = round2(Math.max(0, o.total) + held);
    const mbUsed = round2(Math.max(0, -balance));
    if (Math.abs(ledgerUsed - mbUsed) >= 1) report.usageDiff.push({ name: bank.name, moneybook: mbUsed, ledger: ledgerUsed });
  }
}

/* ---------- e-invoices (Moneybook has totals but no invoice numbers) ---------- */

function importMoneybookInvoices(ledger, invRows, itemRows, report) {
  const invoices = live(ledger.transactions).filter((t) => t.source === 'invoice');
  // Inside the period of the MOF export (invoices with numbers), the MOF file is complete and
  // leaves out voided invoices, which Moneybook still lists: there, missing means voided.
  const numbered = invoices.filter((t) => t.invoiceNo).map((t) => t.date).sort();
  const [from, to] = [numbered[0], numbered[numbered.length - 1]];
  const groups = new Map();
  for (const r of invRows) {
    const k = `${day(r['購買時間'])}|${normalizeName(r['商家名稱'])}`;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  for (const [k, rs] of groups) {
    const [date] = k.split('|');
    const same = invoices.filter((t) => t.date === date && normalizeName(t.merchant) === k.slice(11));
    const left = [...same];
    const missing = [];
    for (const r of rs) {
      const total = Math.round(money(r['發票金額']));
      const i = left.findIndex((t) => Math.round(t.amount) === total);
      if (i >= 0) left.splice(i, 1);
      else missing.push({ r, total });
    }
    for (const { r, total } of missing) {
      // the same invoice with a slightly different amount: line items without tax / a discount
      const t = left.length === 1 && missing.length === 1 ? left[0] : null;
      if (t && Math.abs(total - t.amount) <= Math.max(10, total * 0.1)) {
        const diff = round2(total - t.amount);
        upsert(ledger, 'transactions', {
          id: t.id, amount: total, totalFixed: true,
          items: [...(t.items || []), { name: diff > 0 ? '稅額／差額（依發票總額）' : '折讓／差額（依發票總額）', qty: 1, price: diff, amount: diff }],
        });
        report.invoices.fixed.push({ date, merchant: t.merchant, from: t.amount, to: total });
        left.length = 0;
        continue;
      }
      if (from && date >= from && date <= to) {
        report.invoices.voided.push({ date, merchant: r['商家名稱'], amount: total });
        continue;
      }
      const items = itemRows.filter((i) => i['購買時間'] === r['購買時間'] && i['商家名稱'] === r['商家名稱'])
        .map((i) => ({ name: i['品項'], qty: money(i['品項數量']), price: money(i['品項單價']), amount: money(i['總價']) }));
      upsert(ledger, 'transactions', {
        date, amount: total, type: 'expense', source: 'invoice', merchant: r['商家名稱'], items,
        category: guessCategory(r['商家名稱'], items), carrier: r['載具名稱'] || r['載具號碼'], totalFixed: true,
        note: 'Moneybook 匯入（無發票號碼）',
      });
      report.invoices.added.push({ date, merchant: r['商家名稱'], amount: total });
    }
  }
}

/* ---------- card transactions ---------- */

const CARD_CATEGORY = {
  飲食: '餐飲', 交通: '交通', 休閒娛樂: '娛樂', 住家: '日用品', 醫療: '醫療', 購物: '購物', 學習: '教育',
  電子票證加值: '交通', 生活用品: '日用品', 美容美髮: '購物', 保險: '保險', 稅金: '稅費', 通訊: '電信網路', 水電瓦斯: '水電瓦斯',
};
const cardLast4 = (desc) => (String(desc).match(/ - (\d{4})$/) || [])[1] || null;
// Authorisations (尚未請款) show as "類別/商店" with the same consumption and posting day.
const isAuthorisation = (r) => r['消費日'] === r['入帳日'] && /^[^ ]*\//.test(r['明細描述']);
export const moneybookMerchant = (desc) => cleanMerchant(String(desc)
  .replace(/ - [\d*]{4,}.*$/, '').replace(/\s+[a-z .]+\s+tw$/i, ''))
  .replace(/^(?:(?:連支|連加|街口|全支付|悠遊付)[＊*]\s*|M?A-\s*|mf-\s*)/i, '');

function importCards(ledger, rows, report) {
  const cardRows = rows.filter(isCardRow);
  const posted = cardRows.filter((r) => !isAuthorisation(r));
  const byBank = new Map();
  for (const r of cardRows) {
    const amt = money(r['金額']);
    if (!amt || r['分類'] === '繳信用卡費' || /自動扣繳|繳款|感謝您/.test(r['明細描述'])) continue;
    const l4 = cardLast4(r['明細描述']);
    const auth = isAuthorisation(r);
    if (auth && posted.some((p) => money(p['金額']) === amt && cardLast4(p['明細描述']) === l4 && near(day(p['消費日']), day(r['消費日']), 5))) continue;
    const merchant = moneybookMerchant(r['明細描述']) || r['明細描述'];
    const refund = amt > 0;
    const t = {
      date: day(r['消費日']), amount: Math.abs(amt), type: refund ? 'income' : 'expense', source: 'card', paymentMethod: 'card', merchant,
      category: refund ? '退款' : CARD_CATEGORY[r['分類']] || guessCategory(merchant), cardLast4: l4,
    };
    if (day(r['入帳日']) !== t.date) t.postDate = day(r['入帳日']);
    if (auth) t.pending = true;
    if (!byBank.has(r['機構名稱'])) byBank.set(r['機構名稱'], []);
    byBank.get(r['機構名稱']).push(t);
  }
  for (const [bankName, list] of byBank) {
    const bank = ensureIssuer(ledger, bankName);
    // Store names differ between sources, so a charge already imported from the bank's own
    // statement is recognised by bank, date, amount and direction only (multiset).
    const key = (t) => `${t.date}|${round2(t.amount)}|${t.type}`;
    const have = new Map();
    for (const t of live(ledger.transactions).filter((x) => x.source === 'card')) {
      const b = t.issuerId || ledger.cards.find((c) => c.id === t.cardId)?.issuerId;
      if (b === bank.id) have.set(key(t), [...(have.get(key(t)) || []), t]);
    }
    const fresh = [];
    let known = 0;
    for (const t of list) {
      const old = have.get(key(t))?.shift();
      if (old) {
        known++;
        const patch = {};
        if (t.postDate && !old.postDate) patch.postDate = t.postDate;
        if (old.pending && !t.pending) patch.pending = false;
        if (Object.keys(patch).length) upsert(ledger, 'transactions', { id: old.id, ...patch });
        continue;
      }
      fresh.push({ ...t, _unmatchedLast4: t.cardLast4 });
    }
    const cards = live(ledger.cards).filter((c) => c.issuerId === bank.id);
    for (const t of fresh) {
      const c = cards.find((x) => String(x.last4) === String(t.cardLast4));
      if (c) {
        t.cardId = c.id;
        delete t._unmatchedLast4;
      }
    }
    const r = importBankStatement(ledger, { bankId: bank.id, txs: fresh });
    report.cards.push({ name: bank.name, rows: list.length, added: r.added, confirmed: r.confirmed, skipped: known + r.skipped, pending: fresh.filter((x) => x.pending).length, newCards: r.created.map((c) => c.last4) });
  }
}

/* ---------- card bills → per-bank statements ---------- */

function closingFor(bank, due) {
  const sd = Number(bank.statementDay);
  if (!sd) return { date: new Date(Date.parse(due) - 18 * DAY).toISOString().slice(0, 10), estimated: true };
  let [y, m] = due.split('-').map(Number);
  for (let k = 0; k < 3; k++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(sd, last)).padStart(2, '0')}`;
    if (Date.parse(due) - Date.parse(d) >= 7 * DAY) return { date: d, estimated: false };
    m -= 1;
    if (!m) [y, m] = [y - 1, 12];
  }
  return { date: new Date(Date.parse(due) - 18 * DAY).toISOString().slice(0, 10), estimated: true };
}

function importBills(ledger, rows, txRows, asOf, report) {
  for (const r of rows.filter((x) => /信用卡/.test(x['帳單類型'] || '信用卡'))) {
    const bank = ensureIssuer(ledger, r['金融機構']);
    const due = day(r['繳費截止日']);
    const total = round2(money(r['帳單金額']));
    const mine = live(ledger.statements).filter((s) => s.issuerId === bank.id);
    if (mine.some((s) => s.dueDate && near(s.dueDate, due, 5))) {
      report.statements.skipped++;
      continue;
    }
    const closing = closingFor(bank, due);
    const period = closing.date.slice(0, 7);
    if (mine.some((s) => s.period === period)) {
      report.statements.skipped++;
      continue;
    }
    // A bill past its due date when the export was made has been paid (autopay or transfer).
    const paid = due < asOf;
    const payment = paid && txRows.find((p) => p['帳戶名稱'] !== '信用卡' && p['分類'] === '繳信用卡費' && -money(p['金額']) === total
      && issuerKey(p['機構名稱']) === issuerKey(bank.name) && day(p['消費日']) <= day(due) && near(day(p['消費日']), due, 20));
    upsert(ledger, 'statements', {
      issuerId: bank.id, period, closingDate: closing.date, dueDate: due, total, minimum: money(r['最低應繳金額']),
      paidAmount: paid ? total : 0, ...(paid ? { paidDate: payment ? day(payment['消費日']) : due } : {}),
      ...(closing.estimated ? { closingEstimated: true } : {}), source: 'moneybook',
    });
    report.statements.added++;
  }
}

/* ---------- bank-account transactions ---------- */

// Moving money between our own pockets is neither income nor spending.
const WALLET = /口袋帳戶|line ?pay|linepay|連加|連支|街口|一卡通|悠遊付|全支付|icash|儲值|top-?up|手機換匯|cd轉收/i;
const SKIP_CATEGORY = new Set(['繳信用卡費', '外幣買賣', '投資買賣', '電子票證加值', '轉帳']);
const INCOME_CATEGORY = { 薪資: '薪資', 薪水: '薪資', 獎金: '獎金', '發票/彩券中獎': '獎金', 租金: '補助', 補助: '補助', 優惠回饋: '回饋', 利息所得: '利息', 股利: '投資收益', 投資收益: '投資收益', 退款: '退款' };
const EXPENSE_CATEGORY = { ...CARD_CATEGORY, 學貸利息: '貸款利息', 貸款利息: '貸款利息', 現金消費: '現金', 租金: '居住', 房租: '居住', '費用/手續費': '稅費' };
const PAIRABLE = new Set(['尚未分類', '轉帳', '電子票證加值', '']);

/** "借款利息 - 9990000…" → "借款利息"; "合作金庫商業銀行 *******12345" → "合作金庫商業銀行". */
export function bankMerchant(desc) {
  const [head, ...rest] = String(desc).split(' - ');
  const strip = (v) => v.replace(/[*\d]{5,}/g, '').replace(/\s+/g, ' ').trim();
  // "轉帳 - 力麒建設 現金股息" / "消費回饋 - 大戶回饋": the detail names the payer
  const tail = strip(rest.join(' - '));
  return (/[\u4e00-\u9fff]/.test(tail) ? tail : strip(head)) || String(desc);
}

const ruleMatches = (rule, r) => rule.match && String(r['明細描述']).toLowerCase().includes(String(rule.match).toLowerCase())
  && (rule.amount === undefined || rule.amount === null || rule.amount === '' || Math.abs(money(r['金額'])) === Number(rule.amount))
  && (!rule.direction || (rule.direction === 'in') === (money(r['金額']) > 0));

/**
 * How one bank row should be recorded: { type: 'income'|'expense', category, merchant } or
 * { skip: reason } or null (unknown — the user decides).
 */
export function classifyBankRow(r, rules = []) {
  const amt = money(r['金額']);
  if (!amt) return { skip: '金額為 0' };
  const rule = rules.find((x) => ruleMatches(x, r));
  if (rule) {
    if (rule.type === 'skip') return { skip: rule.note || '規則：不計收支' };
    return { type: rule.type, category: rule.category, merchant: rule.merchant || bankMerchant(r['明細描述']), rule: true };
  }
  if (SKIP_CATEGORY.has(r['分類'])) return { skip: r['分類'] };
  const merchant = bankMerchant(r['明細描述']);
  // interest paid on a sub-account (口袋帳戶) is income; money moved in and out of it is not
  if (r['分類'] === '利息所得' && amt > 0) return { type: 'income', category: '利息', merchant: /口袋/.test(merchant) ? '口袋帳戶利息' : merchant };
  if (WALLET.test(r['明細描述'])) return { skip: '電子支付／子帳戶' };
  if (amt > 0 && INCOME_CATEGORY[r['分類']]) return { type: 'income', category: INCOME_CATEGORY[r['分類']], merchant };
  if (amt < 0 && EXPENSE_CATEGORY[r['分類']]) {
    const category = EXPENSE_CATEGORY[r['分類']];
    return { type: 'expense', category, merchant: category === '現金' ? '現金提領' : merchant };
  }
  if (/減資退款|現金股息|股息/.test(r['明細描述']) && amt > 0) return { type: 'income', category: '投資收益', merchant };
  if (/現金提|提款|atm/i.test(r['明細描述']) && amt < 0) return { type: 'expense', category: '現金', merchant: '現金提領' };
  return null;
}

export const bankRef = (r, n = 0) => `${moneybookAccountKey(r)}|${day(r['消費日'])}|${money(r['金額'])}|${r['明細描述']}|${n}`;

/** One bank row → transaction (also used when the user classifies an unknown row). */
export function addBankTransaction(ledger, row, { type, category, merchant, note }) {
  const acc = findMoneybookAccount(ledger, row);
  return upsert(ledger, 'transactions', {
    date: day(row['消費日']), amount: Math.abs(money(row['金額'])), type, source: 'bank',
    category: category || (type === 'income' ? '其他收入' : '其他'), merchant: merchant || bankMerchant(row['明細描述']),
    paymentMethod: category === '現金' ? 'cash' : 'transfer', ...(acc ? { accountId: acc.id } : {}),
    bankRef: row.ref, note: note || row['明細描述'],
  });
}

/** Remember how to record rows from this payee (settings.bankRules), e.g. 合作金庫 → 薪資. */
export function addBankRule(ledger, rule) {
  const rules = (ledger.settings.bankRules || []).filter((x) => !(x.match === rule.match && (x.amount ?? '') === (rule.amount ?? '')));
  ledger.settings = { ...ledger.settings, bankRules: [...rules, rule] };
  ledger.updatedAt = new Date().toISOString();
}

function importBankRows(ledger, rows, report) {
  const bankRows = rows.filter((r) => !isCardRow(r) && (r['幣別'] || 'TWD') === 'TWD' && r['是否排除收支'] !== '是');
  // identical rows on the same day get their own reference so both are kept
  const seen = new Map();
  for (const r of bankRows) {
    const base = bankRef(r);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    r.ref = bankRef(r, n);
  }
  // transfers between our own accounts: same amount out of one and into another within a day
  const paired = new Set();
  const pairable = bankRows.filter((r) => PAIRABLE.has(r['分類'] || ''));
  for (const a of pairable) {
    if (paired.has(a.ref) || money(a['金額']) >= 0) continue;
    const b = pairable.find((x) => !paired.has(x.ref) && money(x['金額']) === -money(a['金額']) && moneybookAccountKey(x) !== moneybookAccountKey(a)
      && near(day(x['消費日']), day(a['消費日']), 1));
    if (b) {
      paired.add(a.ref);
      paired.add(b.ref);
    }
  }
  // money parked in a sub-account (口袋帳戶) and taken back later, possibly weeks apart
  const pocket = bankRows.filter((r) => /口袋帳戶/.test(r['明細描述']));
  for (const a of pocket) {
    if (paired.has(a.ref) || money(a['金額']) >= 0) continue;
    const b = pocket.find((x) => !paired.has(x.ref) && money(x['金額']) === -money(a['金額']) && x['消費日'] >= a['消費日']);
    if (b) {
      paired.add(a.ref);
      paired.add(b.ref);
    }
  }
  const have = new Set(live(ledger.transactions).map((t) => t.bankRef).filter(Boolean));
  const rules = ledger.settings.bankRules || [];
  for (const r of bankRows) {
    if (have.has(r.ref)) {
      report.bank.existing++;
      continue;
    }
    const rule = rules.find((x) => ruleMatches(x, r));
    if (paired.has(r.ref) && !(rule && rule.type !== 'skip')) {
      report.bank.transfers++;
      continue;
    }
    const c = classifyBankRow(r, rules);
    if (!c) report.bank.unknown.push(r);
    else if (c.skip) report.bank.skipped++;
    else {
      // already entered by hand (e.g. 記錄入帳 of the salary): same direction and amount within 3 days
      const amt = Math.abs(money(r['金額']));
      const typed = live(ledger.transactions).find((t) => !t.bankRef && (t.source === 'manual' || t.source === 'bill')
        && t.type === c.type && round2(t.amount) === amt && near(t.date, day(r['消費日']), 3));
      if (typed) {
        upsert(ledger, 'transactions', { id: typed.id, bankRef: r.ref });
        report.bank.existing++;
        continue;
      }
      addBankTransaction(ledger, r, c);
      report.bank.added.push({ date: day(r['消費日']), merchant: c.merchant, amount: money(r['金額']), category: c.category });
    }
  }
}

/* ---------- all together ---------- */

/**
 * Import Moneybook exports. `files` maps kind → CSV text (see moneybookKind). Options:
 * balances (default true) — overwrite account balances with Moneybook's.
 */
export function importMoneybook(ledger, files, { balances = true } = {}) {
  const rows = Object.fromEntries(Object.entries(files).filter(([, t]) => t).map(([k, t]) => [k, moneybookRows(t)]));
  const txRows = rows.transactions || [];
  const asOf = txRows.map((r) => day(r['入帳日'] || r['消費日'])).sort().pop() || ymd();
  const report = {
    asOf, accounts: [], banks: [], usageDiff: [], cards: [],
    invoices: { added: [], fixed: [], voided: [] },
    statements: { added: 0, skipped: 0 },
    bank: { added: [], unknown: [], transfers: 0, skipped: 0, existing: 0 },
  };
  if (rows.accounts && balances) importAccounts(ledger, rows.accounts, asOf, report);
  if (rows.invoices) importMoneybookInvoices(ledger, rows.invoices, rows.items || [], report);
  if (txRows.length) importCards(ledger, txRows, report);
  if (rows.bills) importBills(ledger, rows.bills, txRows, asOf, report);
  if (txRows.length) importBankRows(ledger, txRows, report);
  if (rows.accounts) importCreditLines(ledger, rows.accounts, report);
  return report;
}
