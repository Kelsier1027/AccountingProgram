// Pay slips (薪資明細表) → salary income. The slips are transcribed into data/payslips/payslips.json;
// each one becomes (or enriches) the salary income of the month it is paid in.
import { live, upsert } from './model.js';
import { addMonths, round2, sum, daysBetween } from './util.js';

/** Problems in a slip: its totals must add up (應發 − 應扣 = 實發). */
export function checkPayslip(s) {
  const out = [];
  if (!/^\d{4}-\d{2}$/.test(s.month || '')) out.push('month 必須是 YYYY-MM');
  const earn = round2(sum(Object.values(s.earnings || {})));
  const ded = round2(sum(Object.values(s.deductions || {})));
  if (s.gross !== undefined && earn !== s.gross) out.push(`應發項目合計 ${earn} ≠ 應發合計 ${s.gross}`);
  if (s.deductionTotal !== undefined && ded !== s.deductionTotal) out.push(`應扣項目合計 ${ded} ≠ 應扣合計 ${s.deductionTotal}`);
  if (round2(earn - ded) !== s.net) out.push(`應發 ${earn} − 應扣 ${ded} ≠ 實發 ${s.net}`);
  return out;
}

/** The day the salary for `month` arrives: payday of the next month unless the slip says otherwise. */
export const payDate = (s, payday = 5) => s.paidDate || `${addMonths(s.month, 1)}-${String(payday).padStart(2, '0')}`;

/**
 * Add each slip as salary income on its pay date, with the earnings and deductions as line items.
 * A salary already in the ledger (from the bank, within 3 days, same amount) gets the slip's
 * details instead of a second record; re-importing updates instead of duplicating.
 */
export function importPayslips(ledger, doc) {
  const payday = doc.payday || 5;
  const item = live(ledger.bills).find((b) => b.kind === 'income' && b.category === '薪資');
  const res = { added: 0, updated: 0, attached: 0, bonuses: 0, errors: [], differences: [] };
  for (const s of doc.slips || []) {
    const problems = checkPayslip(s);
    if (problems.length) {
      res.errors.push(`${s.month}：${problems.join('；')}`);
      continue;
    }
    const date = payDate(s, payday);
    const items = [
      ...Object.entries(s.earnings).map(([name, amount]) => ({ name, amount })),
      ...Object.entries(s.deductions).filter(([, v]) => v).map(([name, amount]) => ({ name, amount: -amount })),
    ];
    const fields = {
      payslip: s.month, items, gross: s.gross, ...(item ? { billId: item.id } : {}),
      note: [`${s.month} 薪資明細：應發 ${s.gross}、應扣 ${s.deductionTotal}${s.pension ? `；勞退公司提 ${s.pension.employerMonthly}（累計 ${s.pension.employerCumulative}）` : ''}`, ...(s.notes || [])].join('；'),
    };
    const txs = live(ledger.transactions);
    const mine = txs.find((t) => t.payslip === s.month);
    // the salary as it arrived in the bank: the bank amount is what really came in, the slip adds the detail
    const fromBank = !mine && txs.find((t) => t.type === 'income' && !t.payslip && t.source === 'bank'
      && Math.abs(daysBetween(t.date, date)) <= 3 && (t.category === '薪資' || (item && t.billId === item.id)));
    if (mine) {
      upsert(ledger, 'transactions', { id: mine.id, ...fields, ...(mine.source === 'bank' ? {} : { amount: s.net }) });
      res.updated++;
    } else if (fromBank) {
      const diff = round2(fromBank.amount - s.net);
      upsert(ledger, 'transactions', { id: fromBank.id, ...fields, ...(diff ? { note: `${fields.note}；實際入帳 ${fromBank.amount}，比明細表實發 ${s.net} ${diff > 0 ? '多' : '少'} ${Math.abs(diff)}` } : {}) });
      if (diff) res.differences.push(`${s.month}：銀行入帳 ${fromBank.amount}，明細表實發 ${s.net}（差 ${diff > 0 ? '+' : ''}${diff}）`);
      res.attached++;
    } else {
      upsert(ledger, 'transactions', {
        date, amount: s.net, type: 'income', source: 'manual', category: '薪資', paymentMethod: 'transfer',
        merchant: `薪資（${doc.employer || '公司'} ${s.month.replace('-', '/')}）`, ...fields,
        ...(item?.accountId ? { accountId: item.accountId } : {}),
      });
      res.added++;
    }
  }
  // bonuses (年終、績效、員工酬勞): income of their own on the day paid
  for (const b of doc.bonuses || []) {
    if (round2(b.gross - (b.tax || 0)) !== b.net) {
      res.errors.push(`${b.name}：${b.gross} − 稅 ${b.tax || 0} ≠ 實付 ${b.net}`);
      continue;
    }
    const key = `bonus:${b.month}:${b.name}`;
    const fields = {
      date: b.paidDate || `${b.month}-15`, amount: b.net, type: 'income', source: 'manual', category: '獎金', paymentMethod: 'transfer',
      merchant: `${b.name}（${doc.employer || '公司'}）`, payslip: key, gross: b.gross,
      items: [{ name: b.name, amount: b.gross }, ...(b.tax ? [{ name: '所得稅（5%）', amount: -b.tax }] : [])],
      note: [b.formula, b.dateEstimated ? '入帳日為推估' : ''].filter(Boolean).join('；'),
      ...(item?.accountId ? { accountId: item.accountId } : {}),
    };
    const mine = live(ledger.transactions).find((t) => t.payslip === key);
    upsert(ledger, 'transactions', mine ? { id: mine.id, ...fields } : fields);
    if (mine) res.updated++;
    else res.bonuses++;
  }
  return res;
}
