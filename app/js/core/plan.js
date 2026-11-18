// 投資規劃：how much of the cash in bank accounts can go into the portfolio without leaving any
// upcoming payment short. Projects every known inflow and outflow day by day over a horizon,
// finds the lowest balance, and keeps a safety reserve on top of it.
import { live } from './model.js';
import {
  statementsOfIssuer, issuerOutstanding, loanBalance, billStatus, billDueDate, billPeriod, isIncomeItem, isPayable, isPlannedItem, incomeStatus,
  effectiveTransactions, notSpending, iouRemaining, toBase, valueHolding,
} from './calc.js';
import { round2, sum, ymd, ym, addMonths, daysBetween } from './util.js';

export const PLAN_DEFAULTS = { horizonDays: 60, reserveMonths: 1, livingMonthly: null, oneOffThreshold: 5000, includeIncome: true };
// spending on a card is paid when its bill is due: on average about this many days later
const CARD_LAG_DAYS = 35;
const CASH_TYPES = new Set(['bank', 'cash', 'ewallet']);
const CYCLE = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 };

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const clampDay = (month, day) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(Math.max(1, Number(day) || 1), last)).padStart(2, '0')}`;
};
/** First date on or after `from` whose day of month is `day` (short months use their last day). */
function nextDay(from, day) {
  const here = clampDay(ym(from), day);
  return here >= from ? here : clampDay(addMonths(ym(from), 1), day);
}

/** Money we can spend now: bank, cash and e-wallet balances (securities cash and other assets excluded). */
export function liquidCash(ledger, prices) {
  const accounts = live(ledger.accounts).filter((a) => CASH_TYPES.has(a.type || 'bank'));
  return {
    total: round2(sum(accounts, (a) => toBase(a.balance, a.currency, prices))),
    accounts: accounts.map((a) => ({ name: a.name, balance: round2(toBase(a.balance, a.currency, prices)), balanceDate: a.balanceDate || null })),
  };
}

/**
 * Typical monthly day-to-day spending: the last 90 days of counted spending, leaving out what
 * the projection already schedules (bill payments and the categories bills cover, installment
 * purchases) and one-off large purchases.
 */
export function livingEstimate(ledger, today = ymd(), { oneOffThreshold = PLAN_DEFAULTS.oneOffThreshold } = {}) {
  // only the stretch where card statements are in the ledger too: invoices alone (older months)
  // would make card spending look like cash and leave the card share wrong
  const firstCard = live(ledger.transactions).filter((t) => t.source === 'card').map((t) => t.date).sort()[0];
  const from = [addDays(today, -90), firstCard || ''].sort().pop();
  const billCats = new Set(live(ledger.bills).filter(isPayable).map((b) => b.category).filter(Boolean));
  const planInvoices = new Set(live(ledger.loans).map((l) => l.invoiceTxId).filter(Boolean));
  const all = effectiveTransactions(ledger).filter((t) => t.type !== 'income' && !notSpending(t) && t.date >= from && t.date <= today);
  const scheduled = (t) => t.billId || billCats.has(t.category) || planInvoices.has(t.id) || (t.mergedFrom || []).some((id) => planInvoices.has(id));
  // marked by the user as not day-to-day (moving house…), on the charge or on a merged invoice
  const byId = new Map(ledger.transactions.map((t) => [t.id, t]));
  const marked = (t) => !!t.oneOff || (t.mergedFrom || []).some((id) => byId.get(id)?.oneOff);
  const excluded = all.filter((t) => !scheduled(t) && marked(t));
  const oneOffs = all.filter((t) => !scheduled(t) && !marked(t) && t.amount > oneOffThreshold);
  const used = all.filter((t) => !scheduled(t) && !marked(t) && t.amount <= oneOffThreshold);
  const first = used.map((t) => t.date).sort()[0];
  const days = first ? Math.max(30, daysBetween(first, today) + 1) : 30;
  const total = sum(used, (t) => t.amount);
  const byCategory = {};
  for (const t of used) byCategory[t.category || '其他'] = (byCategory[t.category || '其他'] || 0) + t.amount;
  return {
    monthly: round2((total / days) * 30), days, cardShare: total ? sum(used.filter((t) => t.source === 'card'), (t) => t.amount) / total : 0,
    byCategory: Object.entries(byCategory).map(([category, v]) => ({ category, monthly: round2((v / days) * 30) })).sort((a, b) => b.monthly - a.monthly),
    oneOffs: oneOffs.map((t) => ({ date: t.date, merchant: t.merchant, amount: t.amount })),
    marked: excluded.map((t) => ({ date: t.date, merchant: t.merchant, amount: t.amount })),
    markedTotal: round2(sum(excluded, (t) => t.amount)),
  };
}

/** Every dated cash movement we already know about within the horizon. */
export function scheduledFlows(ledger, today, until, { includeIncome = true } = {}) {
  const out = [];
  const add = (date, amount, label, kind) => { if (amount && date <= until) out.push({ date: date < today ? today : date, amount: round2(amount), label, kind }); };

  // credit cards, per bank: unpaid statements on their due dates, unbilled charges on the next due date
  for (const iss of live(ledger.issuers)) {
    const stmts = statementsOfIssuer(ledger, iss.id);
    for (const s of stmts) {
      const unpaid = Math.max(0, (Number(s.total) || 0) - (Number(s.paidAmount) || 0));
      if (unpaid) add(s.dueDate || today, -unpaid, `${iss.name} ${s.period} 帳單`, 'card');
    }
    const o = issuerOutstanding(ledger, iss.id);
    const unbilled = round2(o.unbilled - (o.overpaid || 0));
    const closing = iss.statementDay ? nextDay(addDays(o.lastClose || today, 1) > today ? addDays(o.lastClose || today, 1) : today, iss.statementDay) : null;
    const due = closing && iss.dueDay ? nextDay(addDays(closing, 5), iss.dueDay) : addDays(today, 30);
    if (unbilled > 0) add(due, -unbilled, `${iss.name} 未出帳（${closing ? `${closing.slice(5)} 結帳` : '結帳日未知，估 30 天後'}）`, 'card');
    // installment plans: the rest of the periods land on the following bills, one a month
    for (const l of live(ledger.loans).filter((x) => x.kind === 'installment' && x.issuerId === iss.id)) {
      let left = loanBalance(ledger, l);
      const each = Number(l.monthlyPayment) || (l.periods ? Number(l.principal) / Number(l.periods) : left);
      for (let k = 1; left > 0.5 && k <= 60; k++) {
        const part = Math.min(each, left);
        add(clampDay(addMonths(ym(due), k), iss.dueDay || Number(due.slice(8))), -part, `${l.name} 第 ${k} 期後續`, 'installment');
        left -= part;
      }
    }
  }

  // recurring bills (rent, utilities, interest) and fixed income (salary)
  for (const b of live(ledger.bills).filter((x) => !isPlannedItem(x))) {
    const income = isIncomeItem(b);
    if (income && !includeIncome) continue;
    const step = CYCLE[b.cycle] || 1;
    let period;
    if (income) {
      const s = incomeStatus(ledger, b, today);
      period = s.state === 'received' || s.dueDate < today ? addMonths(s.period, step) : s.period; // a late salary is not counted on
    } else {
      const s = billStatus(b, today);
      period = s.paid ? s.nextPeriod : s.period;
    }
    for (let i = 0; period && i < 24; i++, period = b.cycle === 'once' ? null : addMonths(period, step)) {
      const date = billDueDate(b, period);
      if (date > until) break;
      add(date, income ? Number(b.amount) : -Number(b.amount), `${b.name}（${period}）`, income ? 'income' : 'bill');
    }
  }

  // other loans with a monthly payment and no bill of their own
  const billed = new Set(live(ledger.bills).map((b) => b.loanId).filter(Boolean));
  for (const l of live(ledger.loans).filter((x) => x.kind !== 'installment' && !billed.has(x.id) && Number(x.monthlyPayment) > 0)) {
    for (let d = nextDay(today, l.dueDay || 1); d <= until; d = clampDay(addMonths(ym(d), 1), l.dueDay || 1)) add(d, -Number(l.monthlyPayment), `${l.name} 月付`, 'loan');
  }

  // money we owe people: on the agreed date, or by the end of the horizon
  for (const i of live(ledger.ious).filter((x) => x.direction === 'iOwe' && !x.settled)) {
    add(i.dueDate && i.dueDate <= until ? i.dueDate : until, -iouRemaining(i), `還 ${i.person}`, 'iou');
  }
  // same day: payments before money coming in (conservative)
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
}

/**
 * The whole plan: day-by-day projected balance, the lowest point, the reserve to keep, and what
 * can be invested now and each month.
 */
/**
 * Day-by-day projected balance: known flows (plus `extra` ones, e.g. planned items) and
 * day-to-day spending. Each day records the balance and what was spent / came in.
 */
export function simulate(ledger, prices, today, opts, extra = []) {
  const until = addDays(today, opts.horizonDays);
  const cash = liquidCash(ledger, prices);
  const living = livingEstimate(ledger, today, opts);
  const livingMonthly = opts.livingMonthly ?? living.monthly;
  const daily = livingMonthly / 30;
  const flows = [...scheduledFlows(ledger, today, until, opts), ...extra.filter((f) => f.date >= today && f.date <= until)]
    .sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  const byDay = new Map();
  for (const f of flows) byDay.set(f.date, [...(byDay.get(f.date) || []), f]);

  let balance = cash.total;
  let low = { date: today, balance };
  const timeline = [];
  const cardShare = living.cardShare || 0;
  for (let d = today, i = 0; d <= until; d = addDays(d, 1), i++) {
    // day-to-day spending: cash and e-wallet as it happens, the card part when that bill is due
    let living = 0;
    if (i > 0) living += daily * (1 - cardShare);
    if (i > CARD_LAG_DAYS) living += daily * cardShare;
    balance -= living;
    const today_ = byDay.get(d) || [];
    for (const f of today_) balance += f.amount;
    timeline.push({ date: d, balance: round2(balance), living: round2(living), flows: today_ });
    if (balance < low.balance) low = { date: d, balance: round2(balance) };
  }
  return { until, cash, living, livingMonthly, daily, flows, timeline, low };
}

export function investmentPlan(ledger, prices, today = ymd(), options = {}) {
  const opts = { ...PLAN_DEFAULTS, ...(ledger.settings?.plan || {}), ...options };
  const { until, cash, living, livingMonthly, flows, timeline: days, low } = simulate(ledger, prices, today, opts);
  const timeline = days.map(({ date, balance }) => ({ date, balance }));

  // a month of fixed outflows (bills, loans, installments) plus day-to-day spending
  const monthlyFixed = round2(sum(live(ledger.bills).filter(isPayable), (b) => Number(b.amount) / (CYCLE[b.cycle] || 12))
    + sum(live(ledger.loans).filter((l) => l.kind === 'installment' && loanBalance(ledger, l) > 0), (l) => Number(l.monthlyPayment) || 0)
    + sum(live(ledger.loans).filter((l) => l.kind !== 'installment' && !live(ledger.bills).some((b) => b.loanId === l.id)), (l) => Number(l.monthlyPayment) || 0));
  const monthlyOut = round2(monthlyFixed + livingMonthly);
  const reserve = round2(monthlyOut * opts.reserveMonths);
  const monthlyIncome = round2(sum(live(ledger.bills).filter(isIncomeItem), (b) => Number(b.amount) / (CYCLE[b.cycle] || 12)));
  const investNow = round2(Math.max(0, low.balance - reserve));
  const monthlySurplus = round2(monthlyIncome - monthlyOut);

  const holdings = live(ledger.holdings).map((h) => ({ h, v: valueHolding(h, prices) })).filter((x) => x.v.valueBase > 0);
  const portfolio = sum(holdings, (x) => x.v.valueBase);
  const allocation = investNow > 0 && portfolio > 0
    ? holdings.sort((a, b) => b.v.valueBase - a.v.valueBase).map(({ h, v }) => ({
      symbol: h.symbol, name: h.name || h.symbol, weight: v.valueBase / portfolio, amount: round2((investNow * v.valueBase) / portfolio),
    }))
    : [];

  let verdict;
  if (low.balance < 0) verdict = 'short';
  else if (investNow > 0) verdict = 'invest';
  else verdict = 'hold';
  const staleAccounts = cash.accounts.filter((a) => a.balanceDate && daysBetween(a.balanceDate, today) > 14);

  return {
    today, until, options: opts, cash, living: { ...living, used: livingMonthly, overridden: opts.livingMonthly != null },
    flows, timeline, low, reserve, monthlyFixed, monthlyOut, monthlyIncome, monthlySurplus,
    investNow, investMonthly: round2(Math.max(0, monthlySurplus)), verdict, shortfall: round2(Math.max(0, reserve - low.balance)),
    allocation, staleAccounts,
  };
}
