// Accounts & assets, recurring bills, loans and personal IOUs.
import { store } from '../store.js';
import { live, upsert, remove, LABELS, EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../core/model.js';
import { splitBalances, billStatus, iouRemaining, toBase, loanBalance, loanTerm, installmentsPaid, unlinkedInstallments, isIncomeItem, isPayable, incomeStatus } from '../core/calc.js';
import { addInstallmentPlan, suggestInstallmentPlan } from '../core/importers.js';
import { ymd, round2, sum } from '../core/util.js';
import { esc, money, formDialog, confirmDialog, toast, emptyState } from '../ui.js';
import { accountOptions, adjustAccount, opts } from './common.js';
import { importSplitDialog } from './split.js';

const CUR = [['TWD', '新台幣'], ['USD', '美元'], ['JPY', '日圓'], ['EUR', '歐元'], ['CNY', '人民幣'], ['HKD', '港幣']];

async function crud(coll, title, fields, rec, defaults = {}) {
  const v = await formDialog({ title: `${rec ? '編輯' : '新增'}${title}`, fields, values: rec || defaults, extraButtons: rec ? [{ label: '刪除', value: 'delete', danger: true }] : [] });
  if (!v) return null;
  if (v.__action === 'delete') {
    if (await confirmDialog(`確定刪除這筆${title}？`, '刪除', true)) store.commit((l) => remove(l, coll, rec.id));
    return null;
  }
  store.commit((l) => upsert(l, coll, rec ? { ...v, id: rec.id } : { ...defaults, ...v }));
  toast('已儲存');
  return v;
}

function bindRows(root, coll, handler) {
  root.querySelectorAll(`[data-${coll}]`).forEach((el) => {
    const open = () => handler(store.ledger[coll].find((r) => r.id === el.dataset[coll]));
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
}

/* ---------- accounts & other assets ---------- */
const accFields = [
  { key: 'name', label: '名稱', required: true },
  { key: 'type', label: '類型', type: 'select', options: opts(LABELS.accountType) },
  { key: 'currency', label: '幣別', type: 'select', options: CUR },
  { key: 'balance', label: '目前餘額', type: 'number', required: true },
  { key: 'note', label: '備註', type: 'textarea', wide: true },
];
const assetFields = [
  { key: 'name', label: '名稱', required: true, placeholder: '汽車、保單解約金、黃金…' },
  { key: 'value', label: '估計價值', type: 'number', required: true },
  { key: 'currency', label: '幣別', type: 'select', options: CUR },
  { key: 'note', label: '備註', type: 'textarea', wide: true },
];

export function renderAccounts(root) {
  const L = store.ledger;
  const P = store.prices;
  const acc = live(L.accounts);
  const assets = live(L.assets);
  const fx = (v, c) => (c && c !== 'TWD' ? `<br><span class="muted small">≈ ${money(toBase(v, c, P))}</span>` : '');
  root.innerHTML = `
  <section class="block">
    <div class="block-head"><h2>存款與現金</h2><button class="btn primary sm" id="a-add">新增帳戶</button></div>
    ${acc.length ? `<ul class="rows">${acc.map((a) => `<li class="row" data-accounts="${a.id}" tabindex="0">
      <div class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc(LABELS.accountType[a.type] || '')}${a.note ? ` · ${esc(a.note)}` : ''}</span></div>
      <span class="row-amt">${money(a.balance, { currency: a.currency || 'TWD' })}${fx(a.balance, a.currency)}</span></li>`).join('')}</ul>
      <p class="r">合計 ${money(sum(acc, (a) => toBase(a.balance, a.currency, P)))}</p>` : emptyState('新增你的銀行帳戶、現金與電子支付餘額。')}
  </section>
  <section class="block">
    <div class="block-head"><h2>其他資產</h2><button class="btn ghost sm" id="o-add">新增資產</button></div>
    ${assets.length ? `<ul class="rows">${assets.map((a) => `<li class="row" data-assets="${a.id}" tabindex="0">
      <div class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc(a.note || '')}</span></div>
      <span class="row-amt">${money(a.value, { currency: a.currency || 'TWD' })}${fx(a.value, a.currency)}</span></li>`).join('')}</ul>` : '<p class="muted small">車子、保單價值、黃金等不屬於存款或股票的資產。</p>'}
  </section>`;
  root.querySelector('#a-add').onclick = () => crud('accounts', '帳戶', accFields, null, { type: 'bank', currency: 'TWD' });
  root.querySelector('#o-add').onclick = () => crud('assets', '資產', assetFields, null, { currency: 'TWD' });
  bindRows(root, 'accounts', (r) => crud('accounts', '帳戶', accFields, r));
  bindRows(root, 'assets', (r) => crud('assets', '資產', assetFields, r));
}

/* ---------- recurring bills (待繳) ---------- */
const billFields = [
  { key: 'name', label: '名稱', required: true, placeholder: '房租、電費…' },
  { key: 'category', label: '支出類別', type: 'select', options: EXPENSE_CATEGORIES.map((c) => [c, c]) },
  { key: 'amount', label: '每期金額（約）', type: 'number', required: true },
  { key: 'cycle', label: '週期', type: 'select', options: opts(LABELS.billCycle) },
  { key: 'startMonth', label: '起始月份', type: 'month', required: true, hint: '每兩月、每季的帳單用來推算哪幾個月要繳。' },
  { key: 'dueMonthOffset', label: '繳費月份', type: 'select', options: [['0', '當期月份'], ['-1', '前一個月（例：12 月房租 11 月底前繳）']] },
  { key: 'dueDay', label: '繳費日', type: 'number', step: 1, hint: '超過該月天數時以月底計算；填 31 代表每月最後一天（2 月為 28 或 29 日）。' },
  { key: 'payTo', label: '繳給誰' },
  { key: 'note', label: '備註', type: 'textarea', wide: true },
];
const STATE = { paid: ['ok', '已繳'], due: ['warn', '本期未繳'], overdue: ['crit', '已逾期'], upcoming: ['', '尚未到期'] };

const incomeFields = [
  { key: 'name', label: '名稱', required: true, placeholder: '薪資、租金收入…' },
  { key: 'category', label: '收入類別', type: 'select', options: INCOME_CATEGORIES.map((c) => [c, c]) },
  { key: 'amount', label: '每月約', type: 'number', required: true, hint: '平常的金額；實際入帳金額有小幅變動時會顯示差額。' },
  { key: 'dueDay', label: '入帳日', type: 'number', step: 1, hint: '超過該月天數時以月底計算。' },
  { key: 'payTo', label: '來源', placeholder: '公司名稱' },
  { key: 'match', label: '銀行明細關鍵字', hint: '匯入的銀行明細含這段文字就視為已入帳，例如「合作金庫」。' },
  { key: 'accountId', label: '入帳帳戶', type: 'select', options: () => accountOptions() },
  { key: 'startMonth', label: '起始月份', type: 'month', required: true },
  { key: 'note', label: '備註', type: 'textarea', wide: true },
];
const IN_STATE = { received: ['ok', '已入帳'], late: ['warn', '尚未入帳'], upcoming: ['', '尚未到入帳日'] };

function incomeSection(today) {
  const L = store.ledger;
  const items = live(L.bills).filter(isIncomeItem);
  const rows = items.map((b) => ({ b, s: incomeStatus(L, b, today) }));
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${money(Math.abs(n))}`;
  return `<section class="block">
    <div class="block-head"><h2>每月固定收入</h2><button class="btn ghost sm" id="in-add">新增固定收入</button></div>
    ${rows.length ? `<ul class="rows">${rows.map(({ b, s }) => `<li class="row">
      <div class="row-main" data-income="${b.id}" tabindex="0"><span class="row-title">${esc(b.name)}${b.payTo ? ` <span class="muted small">${esc(b.payTo)}</span>` : ''}</span>
        <span class="row-sub">${esc(s.period)} · 入帳日 <span class="num">${esc(s.dueDate)}</span>
        <span class="tag ${IN_STATE[s.state][0]}">${IN_STATE[s.state][1]}</span>
        ${s.change !== null && s.change !== 0 ? `<span class="muted">比上月 ${signed(s.change)}</span>` : ''}
        ${s.history.length > 1 ? `<span class="muted">近 ${s.history.length} 月：${s.history.map((h) => `${Number(h.month.slice(5))}月 ${money(h.amount)}`).join('、')}</span>` : ''}</span></div>
      <span class="row-amt inc">${s.state === 'received' ? money(s.amount) : `約 ${money(b.amount)}`}</span>
      ${s.state === 'received' ? '' : `<button class="btn primary sm" data-receive="${b.id}">記錄入帳</button>`}
    </li>`).join('')}</ul>` : '<p class="muted small">記錄薪資這類每月固定入帳的收入：匯入銀行明細後自動對應，金額有變動時會標出差額。</p>'}
  </section>`;
}

async function receiveIncome(b) {
  const s = incomeStatus(store.ledger, b, ymd());
  const v = await formDialog({
    title: `記錄 ${b.name}（${s.period}）入帳`,
    fields: [
      { key: 'amount', label: '實際入帳金額', type: 'number', required: true },
      { key: 'date', label: '入帳日', type: 'date', required: true },
      { key: 'accountId', label: '入帳帳戶', type: 'select', options: () => accountOptions() },
    ],
    values: { amount: s.prevAmount ?? b.amount, date: ymd(), accountId: b.accountId || '' },
    intro: '會新增一筆收入並加到帳戶餘額。之後匯入同一筆銀行明細時會自動認出，不會重複記錄。',
    submitLabel: '記錄入帳',
  });
  if (!v) return;
  store.commit((l) => {
    upsert(l, 'transactions', { date: v.date, amount: v.amount, type: 'income', source: 'manual', category: b.category || '薪資', merchant: b.name, paymentMethod: 'transfer', accountId: v.accountId || undefined, billId: b.id });
    adjustAccount(l, v.accountId, v.amount);
  });
  toast('已記錄入帳');
}

export function renderBills(root) {
  const bills = live(store.ledger.bills).filter(isPayable);
  const today = ymd();
  const rows = bills.map((b) => ({ b, s: billStatus(b, today) })).sort((x, y) => x.s.dueDate.localeCompare(y.s.dueDate));
  root.innerHTML = `
  <div class="toolbar"><button class="btn primary" id="b-add">新增待繳項目</button></div>
  <div class="kv"><div><span>本期未繳</span>${money(sum(rows.filter((r) => !r.s.paid && r.s.state !== 'upcoming'), (r) => r.b.amount))}</div>
  <div><span>每月平均</span>${money(sum(bills, (b) => b.amount / ({ monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12, once: Infinity }[b.cycle] || 1)))}</div></div>
  ${rows.length ? `<ul class="rows">${rows.map(({ b, s }) => `<li class="row">
    <div class="row-main" data-bills="${b.id}" tabindex="0"><span class="row-title">${esc(b.name)}</span>
      <span class="row-sub">${esc(LABELS.billCycle[b.cycle] || '')} · ${esc(s.period)} 期 · 繳費日 <span class="num">${esc(s.dueDate)}</span>
      <span class="tag ${STATE[s.state][0]}">${STATE[s.state][1]}</span></span></div>
    <span class="row-amt">${money(s.payment?.amount ?? b.amount)}</span>
    ${s.paid ? `<button class="btn ghost sm" data-unpay="${b.id}">取消繳費</button>` : `<button class="btn primary sm" data-pay="${b.id}">繳費</button>`}
  </li>`).join('')}</ul>` : emptyState('新增房租、水電、電信等固定要繳的款項，按時提醒並自動記成支出。')}
  ${incomeSection(today)}`;
  root.querySelector('#in-add').onclick = () => crud('bills', '固定收入', incomeFields, null, { kind: 'income', cycle: 'monthly', category: '薪資', startMonth: today.slice(0, 7), dueDay: 5, payments: [] });
  root.querySelectorAll('[data-income]').forEach((el) => {
    const open = () => crud('bills', '固定收入', incomeFields, store.ledger.bills.find((b) => b.id === el.dataset.income));
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  root.querySelectorAll('[data-receive]').forEach((btn) => (btn.onclick = () => receiveIncome(store.ledger.bills.find((b) => b.id === btn.dataset.receive))));
  root.querySelector('#b-add').onclick = () => crud('bills', '待繳項目', billFields, null, { cycle: 'monthly', category: '居住', startMonth: today.slice(0, 7), dueDay: 5, payments: [] });
  bindRows(root, 'bills', (r) => crud('bills', '待繳項目', billFields, r));
  root.querySelectorAll('[data-pay]').forEach((btn) => (btn.onclick = () => payBill(store.ledger.bills.find((b) => b.id === btn.dataset.pay))));
  root.querySelectorAll('[data-unpay]').forEach((btn) => (btn.onclick = async () => {
    const b = store.ledger.bills.find((x) => x.id === btn.dataset.unpay);
    const s = billStatus(b, today);
    if (!(await confirmDialog(`取消 ${b.name} ${s.period} 期的繳費紀錄？對應的支出也會刪除。`, '取消繳費', true))) return;
    store.commit((l) => {
      if (s.payment?.txId) remove(l, 'transactions', s.payment.txId);
      upsert(l, 'bills', { id: b.id, payments: (b.payments || []).filter((p) => p.period !== s.period) });
    });
  }));
}

async function payBill(b) {
  const s = billStatus(b, ymd());
  const v = await formDialog({
    title: `繳 ${b.name}（${s.period} 期）`,
    fields: [
      { key: 'amount', label: '金額', type: 'number', required: true },
      { key: 'date', label: '繳費日', type: 'date', required: true },
      { key: 'paymentMethod', label: '付款方式', type: 'select', options: opts(LABELS.payMethod) },
      { key: 'accountId', label: '從哪個帳戶扣款', type: 'select', options: () => accountOptions() },
    ],
    values: { amount: b.amount, date: ymd(), paymentMethod: 'transfer' },
    intro: '會新增一筆支出。用信用卡代繳的話，之後刷卡明細匯入時可在「對帳」合併，不會重複計算。',
    submitLabel: '記錄繳費',
  });
  if (!v) return;
  store.commit((l) => {
    const tx = upsert(l, 'transactions', { date: v.date, amount: v.amount, type: 'expense', source: 'bill', category: b.category || '居住', merchant: b.name, paymentMethod: v.paymentMethod, billId: b.id });
    upsert(l, 'bills', { id: b.id, payments: [...(b.payments || []).filter((p) => p.period !== s.period), { period: s.period, date: v.date, amount: v.amount, txId: tx.id }] });
    if (v.paymentMethod !== 'card') adjustAccount(l, v.accountId, -v.amount);
  });
  toast('已記錄繳費');
}

/* ---------- loans (債務) ---------- */
const loanFields = [
  { key: 'name', label: '名稱', required: true },
  { key: 'kind', label: '種類', type: 'select', options: opts(LABELS.loanKind) },
  { key: 'lender', label: '貸款機構' },
  { key: 'principal', label: '原始本金', type: 'number', required: true },
  { key: 'balance', label: '剩餘本金', type: 'number', required: true },
  { key: 'rate', label: '年利率（%）', type: 'number' },
  { key: 'monthlyPayment', label: '每月應繳', type: 'number' },
  { key: 'term', label: '負債類型', type: 'select', options: [['', '依種類（學貸、信貸、房貸、車貸為長期）'], ['long', '長期負債（不計入淨值）'], ['short', '短期負債']] },
  { key: 'dueDay', label: '每月繳款日', type: 'number', step: 1 },
  { key: 'startDate', label: '開始日', type: 'date' },
  { key: 'endDate', label: '到期日', type: 'date' },
];

export function renderLoans(root) {
  const L = store.ledger;
  const loans = live(L.loans);
  const pendingPlans = unlinkedInstallments(L);
  const bal = (l) => loanBalance(L, l);
  root.innerHTML = `
  <div class="toolbar"><button class="btn primary" id="l-add">新增貸款</button></div>
  ${pendingPlans.length ? `<section class="block"><p class="notice">信用卡明細中有 ${pendingPlans.length} 筆分期款還沒有對應的分期帳務：
    ${pendingPlans.map((t) => `<br>${esc(t.date)} ${esc(t.merchant)} ${money(t.amount)}
      <button class="btn primary sm" data-plan="${t.id}">建立分期帳務</button>`).join('')}</p></section>` : ''}
  <div class="kv"><div><span>短期負債（計入淨值）</span>${money(sum(loans.filter((l) => loanTerm(l) !== 'long'), bal))}</div>
  <div><span>長期負債（另列）</span>${money(sum(loans.filter((l) => loanTerm(l) === 'long'), bal))}</div><div><span>每月應繳合計</span>${money(sum(loans, (l) => l.monthlyPayment))}</div></div>
  ${loans.length ? loans.map((l) => {
    const remaining = bal(l);
    const paid = l.principal ? Math.max(0, Math.min(100, (1 - remaining / l.principal) * 100)) : 0;
    if (l.kind === 'installment') {
      const rows = installmentsPaid(L, l).sort((a, b) => a.date.localeCompare(b.date));
      const done = rows.filter((t) => t.type !== 'income').length;
      return `<section class="block">
        <div class="block-head"><h2 data-loans="${l.id}" tabindex="0" class="link">${esc(l.name)} <span class="muted small">信用卡分期${l.lender ? ` · ${esc(l.lender)}` : ''}</span></h2></div>
        <div class="kv"><div><span>分期總額</span>${money(l.principal)}</div><div><span>尚未出帳</span>${money(remaining)}</div>
        <div><span>期數</span><span class="num">${done}／${esc(l.periods || '—')} 期已出帳</span></div><div><span>每期約</span>${money(l.monthlyPayment || 0)}</div></div>
        <div class="meter" role="meter" aria-label="已出帳比例" aria-valuenow="${paid.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${paid}%"></span></div>
        <p class="muted small">每期分期款會出現在信用卡帳單上，匯入明細時自動對應到這筆分期並減少「尚未出帳」；已出帳的部分算在卡費裡，不會重複計入負債。消費已在購買當天以發票全額計入。${rows.length ? `<br>已出帳：${rows.map((t) => `${esc(t.date)} ${money(t.amount)}`).join('、')}` : ''}</p>
      </section>`;
    }
    return `<section class="block">
      <div class="block-head"><h2 data-loans="${l.id}" tabindex="0" class="link">${esc(l.name)} <span class="muted small">${esc(LABELS.loanKind[l.kind] || '')}${l.lender ? ` · ${esc(l.lender)}` : ''} · ${loanTerm(l) === 'long' ? '長期負債' : '短期負債'}</span></h2>
      <button class="btn primary sm" data-repay="${l.id}">還款</button></div>
      <div class="kv"><div><span>剩餘本金</span>${money(l.balance)}</div><div><span>年利率</span><span class="num">${l.rate ?? '—'}%</span></div>
      <div><span>每月應繳</span>${money(l.monthlyPayment || 0)}</div><div><span>到期</span><span class="num">${esc(l.endDate || '—')}</span></div></div>
      <div class="meter" role="meter" aria-label="已還比例" aria-valuenow="${paid.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${paid}%"></span></div>
      <p class="muted small">已還 ${paid.toFixed(1)}%${(l.payments || []).length ? `｜最近還款 ${esc(l.payments[l.payments.length - 1].date)}` : ''}</p>
    </section>`;
  }).join('') : emptyState('新增學貸、信貸、房貸等，記錄剩餘本金與每月還款。信用卡分期會從刷卡明細自動偵測。')}`;
  root.querySelector('#l-add').onclick = () => crud('loans', '貸款', loanFields, null, { kind: 'student', payments: [] });
  bindRows(root, 'loans', (r) => (r.kind === 'installment' ? editPlan(r) : crud('loans', '貸款', loanFields, r)));
  root.querySelectorAll('[data-repay]').forEach((b) => (b.onclick = () => repayLoan(store.ledger.loans.find((l) => l.id === b.dataset.repay))));
  root.querySelectorAll('[data-plan]').forEach((b) => (b.onclick = () => createPlan(store.ledger.transactions.find((t) => t.id === b.dataset.plan))));
}

const planFields = [
  { key: 'name', label: '名稱', required: true },
  { key: 'principal', label: '分期總額', type: 'number', required: true, hint: '購買金額（通常就是那張發票的總額）。' },
  { key: 'periods', label: '期數', type: 'number', step: 1, required: true },
  { key: 'purchaseDate', label: '購買日', type: 'date' },
];

async function createPlan(t) {
  const g = suggestInstallmentPlan(store.ledger, t);
  const v = await formDialog({
    title: '建立分期帳務', fields: planFields, values: g, submitLabel: '建立',
    intro: g.fromInvoice ? `分期總額取自 ${esc(g.purchaseDate)} 的發票。之後每期分期款匯入時會自動對應，剩餘金額跟著減少。`
      : `找不到對應的發票，分期總額先以「每期 ${t.amount} × ${g.periods} 期」估算，請依帳單更正。`,
  });
  if (!v) return;
  const r = store.commit((l) => addInstallmentPlan(l, { ...g, ...v, periods: Number(v.periods), principal: Number(v.principal) }));
  toast(`已建立分期帳務，對應 ${r.linked} 期已出帳的分期款`);
}

async function editPlan(loan) {
  const v = await formDialog({ title: '編輯分期帳務', fields: planFields, values: { ...loan, purchaseDate: loan.startDate }, extraButtons: [{ label: '刪除', value: 'delete', danger: true }] });
  if (!v) return;
  if (v.__action === 'delete') {
    if (!(await confirmDialog('刪除這筆分期帳務？已出帳的分期款會保留在卡費中。', '刪除', true))) return;
    store.commit((l) => {
      for (const t of installmentsPaid(l, loan)) upsert(l, 'transactions', { id: t.id, installment: { ...t.installment, loanId: undefined } });
      remove(l, 'loans', loan.id);
    });
    return;
  }
  store.commit((l) => upsert(l, 'loans', { id: loan.id, name: v.name, principal: Number(v.principal), periods: Number(v.periods), startDate: v.purchaseDate, monthlyPayment: Math.floor(Number(v.principal) / Number(v.periods)) }));
  toast('已儲存');
}

async function repayLoan(loan) {
  const interest = round2(((Number(loan.balance) || 0) * (Number(loan.rate) || 0)) / 100 / 12);
  const amount = Number(loan.monthlyPayment) || 0;
  const v = await formDialog({
    title: `${loan.name} 還款`,
    fields: [
      { key: 'amount', label: '還款總額', type: 'number', required: true },
      { key: 'interest', label: '其中利息', type: 'number', hint: `依剩餘本金與利率估算約 ${interest} 元，請以銀行明細為準。` },
      { key: 'date', label: '還款日', type: 'date', required: true },
      { key: 'accountId', label: '從哪個帳戶扣款', type: 'select', options: () => accountOptions() },
    ],
    values: { amount, interest: Math.min(interest, amount), date: ymd() },
    intro: '本金部分會降低貸款餘額；利息部分記成「貸款利息」支出。',
    submitLabel: '記錄還款',
  });
  if (!v) return;
  const principalPart = round2(v.amount - (v.interest || 0));
  store.commit((l) => {
    upsert(l, 'loans', { id: loan.id, balance: round2(Math.max(0, loan.balance - principalPart)), payments: [...(loan.payments || []), { date: v.date, amount: v.amount, principalPart }] });
    if (v.interest > 0) upsert(l, 'transactions', { date: v.date, amount: v.interest, type: 'expense', source: 'manual', category: '貸款利息', merchant: `${loan.name} 利息`, paymentMethod: 'transfer' });
    adjustAccount(l, v.accountId, -v.amount);
  });
  toast('已記錄還款');
}

/* ---------- personal IOUs (借貸往來) ---------- */
const iouFields = [
  { key: 'direction', label: '方向', type: 'select', options: opts(LABELS.iouDir) },
  { key: 'person', label: '對象', required: true },
  { key: 'amount', label: '金額', type: 'number', required: true },
  { key: 'date', label: '發生日', type: 'date', required: true },
  { key: 'dueDate', label: '約定還款日', type: 'date' },
  { key: 'note', label: '事由', type: 'textarea', wide: true },
];

export function renderIous(root) {
  const ious = live(store.ledger.ious);
  const group = (dir) => ious.filter((i) => i.direction === dir).sort((a, b) => Number(a.settled) - Number(b.settled) || (a.date || '').localeCompare(b.date || ''));
  const list = (dir) => {
    const items = group(dir);
    return items.length ? `<ul class="rows">${items.map((i) => {
      const rem = iouRemaining(i);
      return `<li class="row ${i.settled ? 'merged' : ''}">
        <div class="row-main" data-ious="${i.id}" tabindex="0"><span class="row-title">${esc(i.person)}</span>
        <span class="row-sub"><span class="num">${esc(i.date || '')}</span>${i.note ? ` · ${esc(i.note)}` : ''}${i.dueDate && !i.settled ? ` · 約定 <span class="num">${esc(i.dueDate)}</span>` : ''}
        ${i.settled ? '<span class="tag ok">已結清</span>' : rem < i.amount ? `<span class="tag">已還 ${money(i.amount - rem)}</span>` : ''}</span></div>
        <span class="row-amt">${money(i.settled ? i.amount : rem)}</span>
        ${i.settled ? '' : `<button class="btn ghost sm" data-repay="${i.id}">${dir === 'owedToMe' ? '收款' : '還款'}</button>`}
      </li>`;
    }).join('')}</ul>` : '<p class="muted small">沒有記錄。</p>';
  };
  const owed = sum(group('owedToMe'), iouRemaining);
  const owe = sum(group('iOwe'), iouRemaining);
  const splits = splitBalances(store.ledger).sort((a, b) => b.last.localeCompare(a.last));
  root.innerHTML = `
  <div class="toolbar"><button class="btn primary" id="i-add">新增借貸</button><button class="btn ghost" id="s-imp">匯入分帳 CSV</button></div>
  <div class="kv"><div><span>別人欠我</span>${money(owed + sum(splits, (s) => Math.max(0, s.balance)))}</div><div><span>我欠別人</span>${money(owe + sum(splits, (s) => Math.max(0, -s.balance)))}</div></div>
  <section class="block"><h2>分帳往來</h2>
    ${splits.length ? `<ul class="rows">${splits.map((s) => `<li class="row">
      <div class="row-main"><span class="row-title">${esc(s.with)}</span>
        <span class="row-sub">${s.count} 筆共同支出 · 你付 ${money(s.paid)}、你的份 ${money(s.mine)} · 已收還款 ${money(s.settledIn)}${s.settledOut ? ` · 你已還 ${money(s.settledOut)}` : ''} · 最近 <span class="num">${esc(s.last)}</span></span></div>
      <span class="row-amt ${s.balance > 0 ? 'inc' : ''}">${s.balance > 0 ? `欠你 ${money(s.balance)}` : s.balance < 0 ? `你欠 ${money(-s.balance)}` : '已結清'}</span>
      ${s.balance ? `<button class="btn ghost sm" data-settle="${esc(s.with)}">${s.balance > 0 ? '收到還款' : '我已還款'}</button>` : ''}
    </li>`).join('')}</ul>` : '<p class="muted small">和伴侶、室友分攤的消費：收支只算你的份，對方的份記在這裡，還款時沖銷。可以匯入分帳 App 的 CSV，或在交易上填「分帳對象」與「你的份」。</p>'}
  </section>
  <section class="block"><h2>別人欠我</h2>${list('owedToMe')}</section>
  <section class="block"><h2>我欠別人</h2>${list('iOwe')}</section>`;
  root.querySelector('#i-add').onclick = () => crud('ious', '借貸', iouFields, null, { direction: 'owedToMe', date: ymd(), repayments: [], settled: false });
  root.querySelector('#s-imp').onclick = () => importSplitDialog();
  root.querySelectorAll('[data-settle]').forEach((b) => (b.onclick = async () => {
    const s = splits.find((x) => x.with === b.dataset.settle);
    const v = await formDialog({
      title: `${s.with}：${s.balance > 0 ? '收到分帳還款' : '分帳還款給對方'}`,
      fields: [{ key: 'amount', label: '金額', type: 'number', required: true }, { key: 'date', label: '日期', type: 'date', required: true }],
      values: { amount: Math.abs(s.balance), date: ymd() },
      intro: '只沖銷分帳餘額，不算收入或支出，也不改帳戶餘額（入帳那筆會隨銀行明細匯入）。',
      submitLabel: '記錄',
    });
    if (!v) return;
    store.commit((l) => upsert(l, 'transactions', {
      date: v.date, amount: v.amount, type: s.balance > 0 ? 'income' : 'expense', source: 'split', category: '其他', paymentMethod: 'transfer',
      merchant: s.balance > 0 ? `${s.with} 分帳還款` : `還 ${s.with} 分帳`, split: { with: s.with, settle: true, ref: `manual|${Date.now().toString(36)}` },
    }));
    toast('已記錄還款');
  }));
  bindRows(root, 'ious', (r) => crud('ious', '借貸', iouFields, r));
  root.querySelectorAll('[data-repay]').forEach((b) => (b.onclick = async () => {
    const i = store.ledger.ious.find((x) => x.id === b.dataset.repay);
    const rem = iouRemaining(i);
    const v = await formDialog({
      title: `${i.person}：${i.direction === 'owedToMe' ? '收款' : '還款'}`,
      fields: [
        { key: 'amount', label: '金額', type: 'number', required: true },
        { key: 'date', label: '日期', type: 'date', required: true },
        { key: 'accountId', label: i.direction === 'owedToMe' ? '存入帳戶' : '從哪個帳戶付', type: 'select', options: () => accountOptions() },
      ],
      values: { amount: rem, date: ymd() },
      submitLabel: '記錄',
    });
    if (!v) return;
    store.commit((l) => {
      const reps = [...(i.repayments || []), { date: v.date, amount: v.amount }];
      upsert(l, 'ious', { id: i.id, repayments: reps, settled: sum(reps, (r) => r.amount) >= i.amount - 0.001 });
      adjustAccount(l, v.accountId, i.direction === 'owedToMe' ? v.amount : -v.amount);
    });
    toast('已記錄');
  }));
}
