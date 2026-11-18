// Demo data so the app can be tried without a GitHub repo. All names and numbers are made up.
import { emptyLedger, upsert, ensureIssuer } from './model.js';
import { ymd, addMonths, ym } from './util.js';
import { totals } from './calc.js';

export function sampleLedger(today = new Date()) {
  const l = emptyLedger();
  const month = ym(ymd(today));
  const prev = addMonths(month, -1);
  const d = (m, day) => `${m}-${String(day).padStart(2, '0')}`;
  const thisDay = Math.min(today.getDate(), 28);
  const dayIn = (n) => d(month, Math.max(1, Math.min(thisDay, n)));

  upsert(l, 'accounts', { name: '薪轉帳戶', type: 'bank', currency: 'TWD', balance: 186400 });
  upsert(l, 'accounts', { name: '數位帳戶（高利活存）', type: 'bank', currency: 'TWD', balance: 320000 });
  upsert(l, 'accounts', { name: '錢包現金', type: 'cash', currency: 'TWD', balance: 3200 });
  upsert(l, 'accounts', { name: 'LINE Pay Money', type: 'ewallet', currency: 'TWD', balance: 1580 });
  upsert(l, 'accounts', { name: '美元活存', type: 'bank', currency: 'USD', balance: 2400 });
  upsert(l, 'assets', { name: '機車', value: 45000, currency: 'TWD', note: '估計二手價' });

  upsert(l, 'holdings', { symbol: '2330.TW', name: '台積電', shares: 120, avgCost: 812, currency: 'TWD' });
  upsert(l, 'holdings', { symbol: '0050.TW', name: '元大台灣50', shares: 600, avgCost: 158.4, currency: 'TWD' });
  upsert(l, 'holdings', { symbol: '00878.TW', name: '國泰永續高股息', shares: 2000, avgCost: 21.3, currency: 'TWD' });
  upsert(l, 'holdings', { symbol: 'VT', name: 'Vanguard Total World', shares: 15, avgCost: 112.5, currency: 'USD' });

  const esun = ensureIssuer(l, '玉山銀行');
  const cathay = ensureIssuer(l, '國泰世華');
  upsert(l, 'issuers', { id: esun.id, limit: 120000, statementDay: 5, dueDay: 20 });
  upsert(l, 'issuers', { id: cathay.id, limit: 80000, statementDay: 12, dueDay: 27 });
  const cardA = upsert(l, 'cards', { name: '玉山 Pi 卡', issuerId: esun.id, bank: esun.name, last4: '1234' });
  const cardA2 = upsert(l, 'cards', { name: '玉山 U Bear 卡', issuerId: esun.id, bank: esun.name, last4: '4321' });
  const cardB = upsert(l, 'cards', { name: '國泰 CUBE 卡', issuerId: cathay.id, bank: cathay.name, last4: '5678' });
  upsert(l, 'statements', {
    issuerId: esun.id, period: prev, closingDate: d(prev, 5), dueDate: d(prev, 20), total: 12850, paidAmount: 12850, paidDate: d(prev, 18),
  });
  upsert(l, 'statements', {
    issuerId: cathay.id, period: month, closingDate: d(month, 1), dueDate: d(month, 27), total: 6420, paidAmount: 0,
  });

  // e-invoice side
  const inv = (date, merchant, amount, invoiceNo, items, category) =>
    upsert(l, 'transactions', { date, merchant, amount, invoiceNo, items, category, type: 'expense', source: 'invoice', carrier: '手機條碼 /DEMO123' });
  inv(dayIn(2), '全家便利商店股份有限公司', 85, 'QA00000001', [{ name: '鮮奶', amount: 50 }, { name: '茶葉蛋', amount: 35 }], '餐飲');
  inv(dayIn(3), '全聯實業股份有限公司', 642, 'QA00000002', [{ name: '衛生紙', amount: 299 }, { name: '雞蛋', amount: 89 }, { name: '蔬菜', amount: 254 }], '日用品');
  inv(dayIn(4), '統一星巴克股份有限公司', 155, 'QA00000003', [{ name: '那堤', amount: 155 }], '餐飲');
  inv(dayIn(6), '台灣中油股份有限公司', 520, 'QA00000004', [{ name: '95無鉛汽油', amount: 520 }], '交通');
  inv(dayIn(6), '屈臣氏', 399, 'QA00000005', [{ name: '洗髮精', amount: 399 }], '日用品');
  inv(dayIn(6), '屈臣氏', 129, 'QA00000006', [{ name: '牙膏', amount: 129 }], '日用品');
  inv(dayIn(7), '八方雲集', 110, 'QA00000007', [{ name: '鍋貼', amount: 110 }], '餐飲');

  // card side (descriptor names differ, dates may lag)
  const card = (date, merchant, amount, cardId) =>
    upsert(l, 'transactions', { date, merchant, amount, cardId, type: 'expense', source: 'card', category: '其他', paymentMethod: 'card' });
  card(dayIn(3), '全聯福利中心－台北', 642, cardA.id);
  card(dayIn(5), 'STARBUCKS 統一星巴克', 155, cardA.id);
  card(dayIn(7), '中油直營站', 520, cardB.id);
  card(dayIn(7), '屈臣氏', 528, cardB.id); // two receipts, one swipe
  card(dayIn(8), 'NETFLIX.COM', 390, cardA2.id);

  upsert(l, 'transactions', { date: dayIn(1), merchant: '公司薪資', amount: 52000, type: 'income', source: 'manual', category: '薪資' });
  upsert(l, 'transactions', { date: dayIn(2), merchant: '早餐店', amount: 75, type: 'expense', source: 'manual', category: '餐飲', paymentMethod: 'cash' });

  const rent = upsert(l, 'bills', { name: '房租', category: '居住', amount: 15000, cycle: 'monthly', dueDay: 5, startMonth: addMonths(month, -6), payTo: '房東 王先生', payments: [] });
  upsert(l, 'bills', { name: '電費', category: '水電瓦斯', amount: 1260, cycle: 'bimonthly', dueDay: 15, startMonth: addMonths(month, -4), payTo: '台電', payments: [] });
  upsert(l, 'bills', { name: '手機月租', category: '電信網路', amount: 499, cycle: 'monthly', dueDay: 25, startMonth: addMonths(month, -12), payTo: '電信公司', payments: [] });
  const rentTx = upsert(l, 'transactions', { date: dayIn(4), merchant: '房租', amount: 15000, type: 'expense', source: 'bill', category: '居住', paymentMethod: 'transfer', billId: rent.id });
  rent.payments.push({ period: month, date: dayIn(4), amount: 15000, txId: rentTx.id });

  upsert(l, 'loans', { name: '就學貸款', kind: 'student', lender: '台灣銀行', principal: 240000, balance: 168500, rate: 1.775, monthlyPayment: 2830, dueDay: 1, startDate: '2024-07-01', endDate: '2032-06-30', payments: [] });
  upsert(l, 'loans', { name: '信用貸款', kind: 'credit', lender: '國泰世華', principal: 300000, balance: 214000, rate: 3.2, monthlyPayment: 9100, dueDay: 10, startDate: '2025-03-10', endDate: '2028-03-10', payments: [] });

  upsert(l, 'ious', { direction: 'owedToMe', person: '小明', amount: 3000, date: d(prev, 12), dueDate: d(month, 28), note: '演唱會門票代墊', repayments: [{ date: dayIn(3), amount: 1000 }], settled: false });
  upsert(l, 'ious', { direction: 'iOwe', person: '阿華', amount: 1200, date: dayIn(2), note: '聚餐先付', repayments: [], settled: false });

  // net-worth history for the trend chart
  const now = totals(l, samplePrices());
  for (let i = 11; i >= 1; i--) {
    const nw = Math.round(now.netWorth - i * 9500 + (((i * 7919) % 11000) - 5500));
    const liab = Math.round(now.liabilities + i * 6000);
    upsert(l, 'snapshots', { date: d(addMonths(month, -i), 28), assets: nw + liab, liabilities: liab, netWorth: nw });
  }
  return l;
}

export function samplePrices() {
  return {
    updatedAt: new Date().toISOString(),
    quotes: {
      '2330.TW': { price: 1085, currency: 'TWD', time: new Date().toISOString(), source: 'demo' },
      '0050.TW': { price: 189.35, currency: 'TWD', time: new Date().toISOString(), source: 'demo' },
      '00878.TW': { price: 20.86, currency: 'TWD', time: new Date().toISOString(), source: 'demo' },
      VT: { price: 128.4, currency: 'USD', time: new Date().toISOString(), source: 'demo' },
    },
    fx: { USD: 32.15 },
  };
}
