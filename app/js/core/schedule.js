// 備款時程：by which date does how much money have to be ready, and for which payments.
// Starts from the cash in bank accounts and walks the known payments (bills, card statements,
// charges not billed yet, installments, loan interest) and fixed income (salary) in date order.
// Day-to-day spending and planned one-offs (bonuses) are left out on purpose: this is the list of
// what is already owed, not a forecast. Built on scheduledFlows() of the cash-flow plan.
import { scheduledFlows, liquidCash } from './plan.js';
import { round2, sum, ymd, daysBetween } from './util.js';

export const SCHEDULE_DEFAULTS = { horizonDays: 60 };

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** A payment due on a weekend has to be made on the Friday before (public holidays are not known). */
export function payDate(date) {
  const w = weekday(date);
  if (w === 6) return addDays(date, -1);
  if (w === 0) return addDays(date, -2);
  return date;
}

/** Last day of this year, or of next year when this one is nearly over. */
export function yearEnd(today = ymd()) {
  const end = `${today.slice(0, 4)}-12-31`;
  return daysBetween(today, end) < 30 ? `${Number(today.slice(0, 4)) + 1}-12-31` : end;
}

/**
 * The payment schedule.
 *   rows:     one per day with a payment or income — items, what goes out / comes in, the balance
 *             after, `shortfall` (how far below zero the balance drops that day, before income of
 *             the same day) and `raise` (how much more has to be added by that day than by the
 *             days before, so that the balance never goes below zero).
 *   episodes: each stretch of days the balance is below zero — start (the day the money has to be
 *             there), end (the day income brings it back, or null), amount (the lowest point) and
 *             additional (the extra money needed compared with the earlier episodes).
 */
export function paymentSchedule(ledger, prices, today = ymd(), options = {}) {
  const opts = { ...SCHEDULE_DEFAULTS, ...options };
  const until = opts.until || addDays(today, opts.horizonDays);
  const cash = liquidCash(ledger, prices);

  // a due date up to two days past the end can still move into the window (weekend → Friday)
  const items = scheduledFlows(ledger, today, addDays(until, 2), { includeIncome: true })
    .map((f) => {
      const out = f.amount < 0;
      const moved = out ? payDate(f.date) : f.date;
      const date = moved < today ? today : moved;
      return { ...f, date, dueDate: f.overdue || f.date, shifted: out && date !== f.date, due: out };
    })
    .filter((i) => i.date <= until)
    // same day: payments before money coming in (conservative)
    .sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  const byDate = new Map();
  for (const i of items) byDate.set(i.date, [...(byDate.get(i.date) || []), i]);

  let balance = cash.total;
  let need = 0;
  const rows = [];
  for (const [date, list] of byDate) {
    const outflow = round2(-sum(list.filter((i) => i.amount < 0), (i) => i.amount));
    const inflow = round2(sum(list.filter((i) => i.amount > 0), (i) => i.amount));
    const low = round2(balance - outflow);
    balance = round2(low + inflow);
    const shortfall = Math.max(0, round2(-low));
    const raise = Math.max(0, round2(shortfall - need));
    need = Math.max(need, shortfall);
    rows.push({ date, items: list, outflow, inflow, balance, low, shortfall, raise, need });
  }

  const episodes = [];
  let ep = null;
  let needBefore = 0;
  for (const r of rows) {
    if (r.low < 0) {
      if (!ep) ep = { start: r.date, end: null, lowDate: r.date, lowBalance: r.low, needBefore };
      if (r.low < ep.lowBalance) { ep.lowBalance = r.low; ep.lowDate = r.date; }
    }
    if (ep && r.balance >= 0) { ep.end = r.date; episodes.push(ep); ep = null; }
    if (!ep) needBefore = r.need;
  }
  if (ep) episodes.push(ep);
  const last = rows.length ? rows[rows.length - 1].need : 0;
  episodes.forEach((e, k) => {
    e.amount = round2(-e.lowBalance);
    // the money raised for an earlier episode stays in the account, so a later one needs less
    const upTo = episodes[k + 1] ? episodes[k + 1].needBefore : last;
    e.additional = round2(upTo - e.needBefore);
    delete e.needBefore;
  });

  let low = { date: today, balance: cash.total };
  for (const r of rows) if (r.low < low.balance) low = { date: r.date, balance: r.low };

  // things that make the dates or amounts less certain
  const guessed = [...new Set(items.filter((i) => i.dateGuess).map((i) => i.label.split(' ')[0]))];
  const estimatedTotal = round2(-sum(items.filter((i) => i.estimated), (i) => i.amount));
  const staleAccounts = cash.accounts.filter((a) => a.balanceDate && daysBetween(a.balanceDate, today) > 14);

  return {
    today, until, cash, rows, episodes, low,
    ok: !episodes.length,
    first: episodes[0] || null,
    totalNeed: last,
    estimatedTotal,
    warnings: { guessed, staleAccounts },
    outflowTotal: round2(sum(rows, (r) => r.outflow)),
    inflowTotal: round2(sum(rows, (r) => r.inflow)),
  };
}

/**
 * For the overview: the first stretch of days with too little money, when it starts within
 * `withinDays`. Looks further ahead than that so that the amount covers the whole stretch.
 */
export function paymentAlert(ledger, prices, today = ymd(), withinDays = 30) {
  const s = paymentSchedule(ledger, prices, today, { horizonDays: Math.max(60, withinDays + 30) });
  const e = s.first;
  if (!e || daysBetween(today, e.start) > withinDays) return null;
  return { start: e.start, end: e.end, amount: e.additional, days: daysBetween(today, e.start) };
}
