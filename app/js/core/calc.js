import { live } from './model.js';
import { sum, round2, ym, addMonths, ymd } from './util.js';

const CYCLE_MONTHS = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 };

/** Convert an amount in `currency` to TWD using prices.fx (TWD per unit). */
export function toBase(amount, currency, prices) {
  if (!currency || currency === 'TWD') return Number(amount) || 0;
  const rate = prices?.fx?.[currency];
  return rate ? (Number(amount) || 0) * rate : Number(amount) || 0;
}

export function hasRate(currency, prices) {
  return !currency || currency === 'TWD' || !!prices?.fx?.[currency];
}

/** Value one holding: price source priority manual > quote > cost. */
export function valueHolding(h, prices) {
  const q = prices?.quotes?.[String(h.symbol || '').toUpperCase()];
  let price;
  let priceSource;
  if (h.manualPrice !== undefined && h.manualPrice !== null && h.manualPrice !== '') {
    price = Number(h.manualPrice);
    priceSource = 'manual';
  } else if (q && Number.isFinite(q.price)) {
    price = q.price;
    priceSource = 'quote';
  } else {
    price = Number(h.avgCost) || 0;
    priceSource = 'cost';
  }
  const currency = h.currency || q?.currency || 'TWD';
  const shares = Number(h.shares) || 0;
  const cost = shares * (Number(h.avgCost) || 0);
  const value = shares * price;
  const pnl = value - cost;
  return {
    price, priceSource, currency, quoteTime: q?.time || null,
    prevClose: q?.prevClose ?? null,
    value, cost, pnl, pnlPct: cost ? pnl / cost : 0,
    valueBase: toBase(value, currency, prices),
    costBase: toBase(cost, currency, prices),
    pnlBase: toBase(pnl, currency, prices),
  };
}

export function iouRemaining(i) {
  if (i.settled) return 0;
  return round2(Math.max(0, (Number(i.amount) || 0) - sum(i.repayments || [], (r) => r.amount)));
}

const signed = (t) => (t.type === 'income' ? -1 : 1) * (Number(t.amount) || 0);
const unpaidOf = (s) => Math.max(0, (Number(s.total) || 0) - (Number(s.paidAmount) || 0));

/** Banks bill by posting date (入帳日), which can fall after the purchase date. */
export const billDate = (t) => t.postDate || t.date;

/** The bank a card transaction belongs to: its own issuerId (bank-only rows), else its card's. */
export function txIssuerId(ledger, t) {
  if (t.issuerId) return t.issuerId;
  return ledger.cards.find((c) => c.id === t.cardId)?.issuerId || null;
}

/** The bank a statement belongs to (older statements were filed under a card). */
export function statementIssuerId(ledger, s) {
  if (s.issuerId) return s.issuerId;
  return ledger.cards.find((c) => c.id === s.cardId)?.issuerId || null;
}

export function statementsOfIssuer(ledger, issuerId) {
  return live(ledger.statements)
    .filter((s) => statementIssuerId(ledger, s) === issuerId)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.closingDate).localeCompare(String(a.closingDate)));
}

/**
 * Outstanding on one bank's combined statement account:
 * unpaid statements + card charges (all its cards) after the last closing date.
 */
export function issuerOutstanding(ledger, issuerId) {
  const stmts = statementsOfIssuer(ledger, issuerId);
  const unpaidStatements = sum(stmts, unpaidOf);
  const lastClose = stmts.map((s) => s.closingDate).filter(Boolean).sort().pop() || '';
  const unbilledTx = live(ledger.transactions).filter(
    (t) => t.source === 'card' && !t.statementId && (!lastClose || billDate(t) > lastClose) && txIssuerId(ledger, t) === issuerId,
  );
  const unbilled = sum(unbilledTx, signed);
  // 溢繳款：the bank holds money of ours (paid too much, refunds after the last bill)
  const overpaid = Number(live(ledger.issuers).find((i) => i.id === issuerId)?.overpaid) || 0;
  return { unpaidStatements: round2(unpaidStatements), unbilled: round2(unbilled), overpaid, total: round2(unpaidStatements + unbilled - overpaid), lastClose };
}

/**
 * One card's part of its bank's balance: charges on the bank's unpaid statements plus
 * charges not yet billed. (Statements are per bank, so this is a breakdown, not a balance.)
 * Cards without a bank fall back to their own statements.
 */
export function cardOutstanding(ledger, cardId) {
  const card = live(ledger.cards).find((c) => c.id === cardId);
  if (card?.issuerId) {
    const o = issuerOutstanding(ledger, card.issuerId);
    const unpaidIds = new Set(statementsOfIssuer(ledger, card.issuerId).filter((s) => unpaidOf(s) > 0).map((s) => s.id));
    const mine = live(ledger.transactions).filter((t) => t.source === 'card' && t.cardId === cardId);
    const billed = sum(mine.filter((t) => t.statementId && unpaidIds.has(t.statementId)), signed);
    const unbilled = sum(mine.filter((t) => !t.statementId && (!o.lastClose || billDate(t) > o.lastClose)), signed);
    return { billed: round2(billed), unbilled: round2(unbilled), total: round2(billed + unbilled), lastClose: o.lastClose };
  }
  const stmts = live(ledger.statements).filter((s) => s.cardId === cardId);
  const unpaidStatements = sum(stmts, unpaidOf);
  const lastClose = stmts.map((s) => s.closingDate).filter(Boolean).sort().pop() || '';
  const unbilled = sum(live(ledger.transactions).filter(
    (t) => t.source === 'card' && t.cardId === cardId && !t.statementId && (!lastClose || billDate(t) > lastClose),
  ), signed);
  return { billed: round2(unpaidStatements), unpaidStatements: round2(unpaidStatements), unbilled: round2(unbilled), total: round2(unpaidStatements + unbilled), lastClose };
}

/**
 * Shared credit line of one bank: every card it issued draws on the same limit,
 * and the bank sends one combined statement for all of them.
 */
export function issuerUsage(ledger, issuerId) {
  const iss = live(ledger.issuers).find((i) => i.id === issuerId);
  const cards = live(ledger.cards).filter((c) => c.issuerId === issuerId);
  const perCard = cards.map((c) => ({ card: c, ...cardOutstanding(ledger, c.id) }));
  const o = issuerOutstanding(ledger, issuerId);
  // Banks hold the not-yet-billed part of an installment plan against the credit line.
  const installmentHeld = round2(sum(live(ledger.loans).filter((l) => l.kind === 'installment' && l.issuerId === issuerId), (l) => loanBalance(ledger, l)));
  const used = round2(Math.max(0, o.total) + installmentHeld);
  const limit = Number(iss?.limit) || 0;
  return {
    issuer: iss, cards: perCard, used, limit, installmentHeld, ...o,
    available: limit ? round2(limit - used) : null,
    ratio: limit ? used / limit : null,
  };
}

/** Total owed on all credit cards: per bank, plus any card not yet assigned to a bank. */
export function cardsOutstandingTotal(ledger) {
  const banks = sum(live(ledger.issuers), (i) => Math.max(0, issuerOutstanding(ledger, i.id).total));
  const orphans = sum(live(ledger.cards).filter((c) => !c.issuerId), (c) => Math.max(0, cardOutstanding(ledger, c.id).total));
  return round2(banks + orphans);
}

/**
 * Credit-card installment plans (kind "installment"): the remaining debt is the price minus
 * every installment that has already appeared on the card (billed or not), because those are
 * already counted in the card's balance. Other loans use their recorded balance.
 */
export function installmentsPaid(ledger, loan) {
  return live(ledger.transactions).filter((t) => t.source === 'card' && t.installment?.loanId === loan.id);
}

export function loanBalance(ledger, loan) {
  if (loan.kind !== 'installment') return Number(loan.balance) || 0;
  const onCard = sum(installmentsPaid(ledger, loan), (t) => (t.type === 'income' ? -1 : 1) * (Number(t.amount) || 0));
  return round2(Math.max(0, (Number(loan.principal) || 0) - onCard));
}

/** Installment rows on the card that no plan claims yet (to offer creating one). */
export function unlinkedInstallments(ledger) {
  const card = live(ledger.transactions).filter((t) => t.source === 'card' && t.installment);
  const shop = (m) => String(m || '').split('分期')[0];
  // a plan cancelled in full ("分期全退", same shop and amount, soon after) needs no tracking
  const refunds = card.filter((t) => t.type === 'income');
  return card.filter((t) => !t.installment.cancelled && !t.installment.loanId && t.type !== 'income'
    && !refunds.some((r) => shop(r.merchant) === shop(t.merchant) && r.amount === t.amount
      && Math.abs(Date.parse(r.date) - Date.parse(t.date)) <= 30 * 86400000));
}

// 學貸、信貸、房貸、車貸預設為長期負債；信用卡分期與其他預設短期。個別貸款可用 term 指定。
const LONG_TERM_KINDS = new Set(['student', 'credit', 'mortgage', 'car']);
export const loanTerm = (loan) => loan.term || (LONG_TERM_KINDS.has(loan.kind) ? 'long' : 'short');

export function totals(ledger, prices) {
  const accounts = sum(live(ledger.accounts), (a) => toBase(a.balance, a.currency, prices));
  const otherAssets = sum(live(ledger.assets), (a) => toBase(a.value, a.currency, prices));
  const holdingVals = live(ledger.holdings).map((h) => valueHolding(h, prices));
  const stocks = sum(holdingVals, (v) => v.valueBase);
  const stockPnl = sum(holdingVals, (v) => v.pnlBase);
  const splits = splitBalances(ledger);
  const receivables = sum(live(ledger.ious).filter((i) => i.direction === 'owedToMe'), iouRemaining) + sum(splits, (s) => Math.max(0, s.balance));
  const payables = sum(live(ledger.ious).filter((i) => i.direction === 'iOwe'), iouRemaining) + sum(splits, (s) => Math.max(0, -s.balance));
  const loanList = live(ledger.loans);
  const loansLong = sum(loanList.filter((l) => loanTerm(l) === 'long'), (l) => loanBalance(ledger, l));
  const loansShort = sum(loanList.filter((l) => loanTerm(l) !== 'long'), (l) => loanBalance(ledger, l));
  const cards = Math.max(0, cardsOutstandingTotal(ledger));
  const assets = accounts + otherAssets + stocks + receivables;
  // 短期負債（卡費、應付、分期等一年內要付的）從淨值扣除；學貸、房貸這類長期負債另列
  const shortTerm = loansShort + payables + cards;
  const liabilities = shortTerm + loansLong;
  return {
    accounts: round2(accounts), otherAssets: round2(otherAssets), stocks: round2(stocks), stockPnl: round2(stockPnl),
    receivables: round2(receivables), payables: round2(payables), cards: round2(cards),
    loans: round2(loansShort + loansLong), loansShort: round2(loansShort), loansLong: round2(loansLong),
    assets: round2(assets), shortTerm: round2(shortTerm), longTerm: round2(loansLong), liabilities: round2(liabilities),
    netWorth: round2(assets - shortTerm), netWorthAll: round2(assets - liabilities),
  };
}

/**
 * Transactions as they should be counted: a linked group (card charge + invoice/bill/manual records)
 * counts once, at the card amount, with category/items borrowed from the other side.
 */
/**
 * Rows that are not our spending or income: installment repayments (the purchase was counted in
 * full), stored-value top-ups (儲值, topUp — the shop's invoices count when it is used) and
 * anything marked excluded (paid by someone else, e.g. a family member's card).
 */
export const notSpending = (t) => (t.source === 'card' && !!t.installment) || !!t.topUp || !!t.excluded || !!t.split?.settle;

/**
 * Shared spending (分帳): the record keeps what was paid, but only my share is my spending.
 * split = { with, paid (what I paid), mine (my share), ref } — the rest is owed by the other person.
 */
export const countedAmount = (t, split = t.split) => (split && !split.settle ? round2(Number(split.mine) || 0) : Number(t.amount) || 0);

/**
 * Running balance with each person I share costs with: positive = they owe me.
 * Every shared expense adds (what I paid − my share); their repayments subtract, mine add.
 */
export function splitBalances(ledger) {
  const by = new Map();
  const row = (who) => {
    if (!by.has(who)) by.set(who, { with: who, balance: 0, paid: 0, mine: 0, settledIn: 0, settledOut: 0, count: 0, last: '' });
    return by.get(who);
  };
  for (const t of live(ledger.transactions)) {
    const s = t.split;
    if (!s?.with) continue;
    const r = row(s.with);
    if (s.settle) {
      if (t.type === 'income') r.settledIn += Number(t.amount) || 0;
      else r.settledOut += Number(t.amount) || 0;
    } else {
      r.paid += Number(s.paid) || 0;
      r.mine += Number(s.mine) || 0;
      r.count++;
    }
    if (t.date > r.last) r.last = t.date;
  }
  return [...by.values()].map((r) => ({ ...r, balance: round2(r.paid - r.mine - r.settledIn + r.settledOut) }));
}

export function effectiveTransactions(ledger) {
  const txs = live(ledger.transactions);
  const byId = new Map(txs.map((t) => [t.id, t]));
  const links = new Map(live(ledger.links).map((l) => [l.id, l]));
  const out = [];
  for (const t of txs) {
    // installment repayments and top-ups are on the card bill, but are not new spending
    if (notSpending(t)) continue;
    const link = t.linkId ? links.get(t.linkId) : null;
    if (link && t.source !== 'card' && link.cardTxId !== t.id) continue; // merged into the card charge
    if (link && link.cardTxId === t.id) {
      const others = (link.otherTxIds || []).map((id) => byId.get(id)).filter(Boolean);
      const lead = others[0];
      // a split may sit on a merged invoice (imported before the card charge was): it still applies
      const split = t.split || others.find((o) => o.split)?.split;
      out.push({
        ...t,
        ...(split ? { split, fullAmount: t.amount, amount: countedAmount(t, split) } : {}),
        category: t.category && t.category !== '其他' ? t.category : lead?.category || t.category || '其他',
        merchant: t.merchant || lead?.merchant,
        items: others.flatMap((o) => o.items || []),
        mergedFrom: others.map((o) => o.id),
      });
      continue;
    }
    out.push(t.split ? { ...t, fullAmount: t.amount, amount: countedAmount(t) } : t);
  }
  return out;
}

export function monthSummary(ledger, month) {
  const txs = effectiveTransactions(ledger).filter((t) => ym(t.date) === month);
  const expense = txs.filter((t) => t.type !== 'income');
  const income = txs.filter((t) => t.type === 'income');
  const byCategory = {};
  for (const t of expense) byCategory[t.category || '其他'] = (byCategory[t.category || '其他'] || 0) + (Number(t.amount) || 0);
  return {
    month,
    expense: round2(sum(expense, (t) => t.amount)),
    income: round2(sum(income, (t) => t.amount)),
    byCategory: Object.entries(byCategory).map(([k, v]) => ({ category: k, amount: round2(v) })).sort((a, b) => b.amount - a.amount),
    count: txs.length,
  };
}

/** The billing period a bill is currently in, given today's month. */
export function billPeriod(bill, month) {
  if (bill.cycle === 'once') return bill.startMonth || month;
  const step = CYCLE_MONTHS[bill.cycle] || 1;
  const start = bill.startMonth || month;
  if (month < start) return start;
  const [sy, sm] = start.split('-').map(Number);
  const [y, m] = month.split('-').map(Number);
  const diff = (y * 12 + m) - (sy * 12 + sm);
  return addMonths(start, diff - (diff % step));
}

const daysIn = (ymStr) => {
  const [y, m] = ymStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Due date of one period. dueDay past the end of a short month means the month's last day
 * (31 → 2/28, 4/30…). dueMonthOffset −1 = pay before the period starts, e.g. December's rent
 * due by the end of November.
 */
export function billDueDate(bill, period) {
  const month = addMonths(period, Number(bill.dueMonthOffset) || 0);
  const day = Math.min(Math.max(1, Number(bill.dueDay) || 1), daysIn(month));
  return `${month}-${String(day).padStart(2, '0')}`;
}

function periodStatus(bill, period, today) {
  const dueDate = billDueDate(bill, period);
  const payment = (bill.payments || []).find((p) => p.period === period);
  const nextPeriod = bill.cycle === 'once' ? null : addMonths(period, CYCLE_MONTHS[bill.cycle] || 1);
  let state = 'upcoming';
  if (payment) state = 'paid';
  else if (today > dueDate) state = 'overdue';
  else if (ym(dueDate) <= ym(today)) state = 'due';
  return { period, dueDate, paid: !!payment, payment, state, nextPeriod };
}

/**
 * The period that needs attention today: this month's period, or — once that is paid — the
 * next one if it is already due this month (rent for December due by November 30).
 */
export function billStatus(bill, today = ymd()) {
  const cur = periodStatus(bill, billPeriod(bill, ym(today)), today);
  if (!cur.paid || !cur.nextPeriod) return cur;
  const next = periodStatus(bill, cur.nextPeriod, today);
  return next.state === 'upcoming' ? cur : next;
}

export function snapshotOf(ledger, prices, date = ymd()) {
  const t = totals(ledger, prices);
  return { date, assets: t.assets, liabilities: t.liabilities, shortTerm: t.shortTerm, longTerm: t.longTerm, netWorth: t.netWorth, netWorthAll: t.netWorthAll };
}

/** "永豐銀行 ****1111" — which bank and card a card transaction went on. */
export function cardLabel(ledger, t) {
  if (t.source !== 'card') return '';
  const card = t.cardId ? ledger.cards.find((c) => c.id === t.cardId) : null;
  const bank = live(ledger.issuers).find((i) => i.id === (t.issuerId || card?.issuerId))?.name || card?.bank || '';
  const last4 = card?.last4 || t.cardLast4;
  return `${bank}${last4 ? ` ****${last4}` : '（未對應卡號）'}`.trim();
}

/* ---------- fixed monthly income (salary): bills with kind "income" ---------- */

export const isIncomeItem = (b) => b.kind === 'income';
/** A planned one-off (預計收支: bonus, trip, gadget) for the cash-flow forecast, not a bill to pay. */
export const isPlannedItem = (b) => b.kind === 'forecast';
/** Recurring bills to pay (rent, utilities…). */
export const isPayable = (b) => !isIncomeItem(b) && !isPlannedItem(b);

/** Income transactions that belong to an income item: recorded for it, or matching its keyword. */
export function incomeReceipts(ledger, item) {
  const key = String(item.match || '').toLowerCase();
  return live(ledger.transactions).filter((t) => t.type === 'income' && !t.excluded && (t.billId === item.id
    || (!t.billId && key && (t.category === item.category || !item.category)
      && [t.merchant, t.note].join(' ').toLowerCase().includes(key))));
}

/**
 * This month's state of an expected income: received (with the actual amount and the change
 * from the expected / previous amount), late, or not due yet.
 */
export function incomeStatus(ledger, item, today = ymd()) {
  const period = billPeriod(item, ym(today));
  const dueDate = billDueDate(item, period);
  const all = incomeReceipts(ledger, item).sort((a, b) => a.date.localeCompare(b.date));
  const got = all.filter((t) => ym(t.date) === period);
  const amount = round2(sum(got, (t) => t.amount));
  const prev = all.filter((t) => ym(t.date) < period);
  const prevMonth = prev.length ? ym(prev[prev.length - 1].date) : null;
  const prevAmount = prevMonth ? round2(sum(prev.filter((t) => ym(t.date) === prevMonth), (t) => t.amount)) : null;
  const state = got.length ? 'received' : today > dueDate ? 'late' : 'upcoming';
  return {
    period, dueDate, state, received: got, amount, expected: Number(item.amount) || 0,
    diff: got.length ? round2(amount - (Number(item.amount) || 0)) : null,
    prevAmount, change: got.length && prevAmount !== null ? round2(amount - prevAmount) : null,
    history: [...new Set(all.map((t) => ym(t.date)))].slice(-6).map((m) => ({ month: m, amount: round2(sum(all.filter((t) => ym(t.date) === m), (t) => t.amount)) })),
  };
}
