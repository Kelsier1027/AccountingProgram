// 資金缺口預警: will the cash in bank accounts run short in the coming months, by how much and
// when, and what each way of covering it (selling holdings, borrowing, collecting what others owe,
// spending less) would take. Built on the same day-by-day simulation as the investment plan.
import { live } from './model.js';
import { isPlannedItem, valueHolding, splitBalances } from './calc.js';
import { simulate, PLAN_DEFAULTS } from './plan.js';
import { round2, sum, ymd, ym, daysBetween } from './util.js';

export const FORECAST_DEFAULTS = {
  months: 12,
  loanRates: { personal: 4, cashAdvance: 15, revolving: 15 }, // % a year
  cashAdvanceFee: 3.5, // % of the amount, once
  brokerFeeRate: 0.1425, // % (Taiwan); a discount multiplies it
  brokerDiscount: 1,
  brokerMinFee: 20,
  usFeeRate: 0.1, // % for US holdings, incl. FX spread (rough)
};

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** n business days before a date (weekends only; holidays not known). */
function businessDaysBefore(date, n) {
  let d = date;
  while (n > 0) {
    d = addDays(d, -1);
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n--;
  }
  return d;
}

/** Planned one-offs as cash flows; `certain` ones count in both scenarios, the rest only in "expected". */
export function plannedFlows(ledger, scenario) {
  return live(ledger.bills).filter(isPlannedItem)
    .filter((b) => scenario === 'expected' || b.certain)
    .map((b) => ({ date: b.date, amount: round2((b.direction === 'in' ? 1 : -1) * (Number(b.amount) || 0)), label: b.name, kind: b.direction === 'in' ? 'planned-in' : 'planned-out', planned: true }));
}

/** Stretches where the balance is below zero: start, lowest point, recovery, and the payments behind it. */
export function findGaps(timeline, floor = 0) {
  const gaps = [];
  let cur = null;
  for (const t of timeline) {
    if (t.balance < floor) {
      if (!cur) cur = { start: t.date, low: t.balance, lowDate: t.date, end: null };
      if (t.balance < cur.low) Object.assign(cur, { low: t.balance, lowDate: t.date });
    } else if (cur) {
      cur.end = t.date;
      gaps.push(cur);
      cur = null;
    }
  }
  if (cur) gaps.push(cur);
  return gaps.map((g) => {
    const from = addDays(g.start, -7);
    const causes = timeline.filter((t) => t.date >= from && t.date <= g.lowDate).flatMap((t) => t.flows || []).filter((f) => f.amount < 0)
      .sort((a, b) => a.amount - b.amount).slice(0, 6);
    return { ...g, amount: round2(floor - g.low), days: daysBetween(g.start, g.end || timeline[timeline.length - 1].date) + (g.end ? 0 : 1), open: !g.end, causes };
  });
}

/** Month by month: opening, money in, money out (bills, cards, living), closing, lowest. */
function monthly(timeline, opening) {
  const rows = [];
  let prev = opening;
  for (const t of timeline) {
    const m = ym(t.date);
    let r = rows[rows.length - 1];
    if (!r || r.month !== m) {
      r = { month: m, opening: prev, income: 0, out: 0, living: 0, closing: prev, low: Infinity, lowDate: t.date };
      rows.push(r);
    }
    for (const f of t.flows || []) {
      if (f.amount > 0) r.income += f.amount;
      else r.out -= f.amount;
    }
    r.living += t.living || 0;
    r.closing = t.balance;
    if (t.balance < r.low) Object.assign(r, { low: t.balance, lowDate: t.date });
    prev = t.balance;
  }
  return rows.map((r) => ({ ...r, opening: round2(r.opening), income: round2(r.income), out: round2(r.out), living: round2(r.living), closing: round2(r.closing), low: round2(r.low) }));
}

/** What covering a gap of `amount` from `date` for `days` days would take, each way. */
export function remedies(ledger, prices, timeline, gap, opts) {
  const o = { ...FORECAST_DEFAULTS, ...opts };
  const amount = gap.amount;
  const days = Math.max(1, gap.days);
  // sell holdings: gross needed so that what is left after fees and tax covers the gap
  const sell = live(ledger.holdings).map((h) => {
    const v = valueHolding(h, prices);
    if (!v.price || !(Number(h.shares) > 0)) return null;
    const tw = /\.TWO?$/i.test(h.symbol);
    const etf = tw && /^00/.test(h.symbol);
    const tax = tw ? (etf ? 0.1 : 0.3) : 0;
    const feeRate = tw ? o.brokerFeeRate * o.brokerDiscount : o.usFeeRate;
    const fx = v.valueBase && v.value ? v.valueBase / v.value : 1;
    const priceBase = v.price * fx;
    let gross = amount / (1 - (feeRate + tax) / 100);
    if (tw) gross = Math.max(gross, amount + o.brokerMinFee);
    const shares = Math.min(Number(h.shares), tw ? Math.ceil(gross / priceBase) : Math.ceil((gross / priceBase) * 100) / 100);
    const proceeds = shares * priceBase;
    const cost = round2(proceeds * (feeRate + tax) / 100 + (tw ? Math.max(0, o.brokerMinFee - proceeds * feeRate / 100) : 0));
    const settle = tw ? 2 : 5; // T+2 in Taiwan; US T+1 plus the transfer home
    return {
      symbol: h.symbol, name: h.name || h.symbol, shares, enough: shares * priceBase - cost >= amount - 0.5, proceeds: round2(proceeds), cost,
      realized: round2(shares * (v.price - (Number(h.avgCost) || 0)) * fx), sellBy: businessDaysBefore(gap.start, settle), settleDays: settle,
    };
  }).filter(Boolean);
  // borrow for the length of the gap
  const r = o.loanRates;
  const borrow = [
    { kind: 'personal', name: '信貸', rate: r.personal, cost: round2(amount * r.personal / 100 * days / 365), note: '多有開辦費與最短借款期間，適合較大、較長的缺口' },
    { kind: 'cashAdvance', name: '信用卡預借現金', rate: r.cashAdvance, cost: round2(amount * (o.cashAdvanceFee / 100 + r.cashAdvance / 100 * days / 365)), note: `另收手續費約 ${o.cashAdvanceFee}%，利率高，不建議` },
    { kind: 'revolving', name: '信用卡循環（只繳最低）', rate: r.revolving, cost: round2(amount * r.revolving / 100 * days / 365), note: '影響信用紀錄，不建議' },
  ];
  // what others owe me
  const owed = sum(splitBalances(ledger), (s) => Math.max(0, s.balance))
    + sum(live(ledger.ious).filter((i) => i.direction === 'owedToMe' && !i.settled), (i) => Number(i.amount) || 0);
  // spend less: the monthly cut that keeps every day up to the gap's lowest point at or above zero
  const start = timeline[0].date;
  let perMonth = 0;
  for (const t of timeline) {
    if (t.date > gap.lowDate) break;
    const n = daysBetween(start, t.date);
    if (t.balance < 0 && n > 0) perMonth = Math.max(perMonth, (-t.balance / n) * 30);
  }
  return { sell, borrow, collect: round2(Math.min(owed, amount)), owed: round2(owed), spendLess: round2(perMonth) };
}

/** Average change of the balance per full month (negative = running down). */
function trendPerMonth(months) {
  const full = months.slice(1, -1);
  if (!full.length) return 0;
  return round2(sum(full, (m) => m.closing - m.opening) / full.length);
}

/**
 * The forecast for one scenario ('conservative': salary only and certain plans; 'expected': also
 * the planned bonuses and other expected items).
 */
export function cashForecast(ledger, prices, today = ymd(), options = {}) {
  const plan = { ...PLAN_DEFAULTS, ...(ledger.settings?.plan || {}) };
  const o = { ...FORECAST_DEFAULTS, ...(ledger.settings?.forecast || {}), ...options };
  const scenario = o.scenario || 'conservative';
  const horizonDays = daysBetween(today, `${ym(addDays(today, o.months * 30.5))}-28`);
  const sim = simulate(ledger, prices, today, { ...plan, horizonDays, livingMonthly: plan.livingMonthly }, plannedFlows(ledger, scenario));
  const reserve = round2((sim.livingMonthly + sum(live(ledger.bills).filter((b) => !b.kind), (b) => Number(b.amount) || 0)) * (plan.reserveMonths || 0));
  const gaps = findGaps(sim.timeline, 0);
  const belowReserve = reserve > 0 ? findGaps(sim.timeline, reserve) : [];
  const worst = gaps.reduce((w, g) => (!w || g.amount > w.amount ? g : w), null);
  // what has to be found: the deepest point, needed from the first day short, until the last one
  const last = gaps[gaps.length - 1];
  const need = worst ? {
    amount: worst.amount, start: gaps[0].start, lowDate: worst.lowDate, end: last.end, open: last.open,
    days: daysBetween(gaps[0].start, last.end || sim.until) + (last.end ? 0 : 1),
    structural: !!last.open && gaps.length > 1 && gaps.every((g, i) => i === 0 || g.amount >= gaps[i - 1].amount - 1),
    // the big payments between now and the lowest point
    causes: sim.timeline.filter((t) => t.date <= worst.lowDate).flatMap((t) => t.flows || []).filter((f) => f.amount < 0)
      .sort((a, b) => a.amount - b.amount).slice(0, 6).sort((a, b) => a.date.localeCompare(b.date)),
  } : null;
  const months = monthly(sim.timeline, sim.cash.total);
  if (need && trendPerMonth(months) >= 0) need.structural = false;
  return {
    today, scenario, until: sim.until, trend: trendPerMonth(months), cash: sim.cash, livingMonthly: sim.livingMonthly, low: sim.low, reserve,
    timeline: sim.timeline.map(({ date, balance }) => ({ date, balance })), months,
    gaps, belowReserve, worst, first: gaps[0] || null, need,
    remedies: need ? remedies(ledger, prices, sim.timeline, need, o) : null,
    planned: plannedFlows(ledger, scenario),
  };
}
