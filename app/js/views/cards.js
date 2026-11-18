// Credit cards, Taiwan style: each bank gives one shared credit limit for all its cards and
// sends one combined statement (one closing day, one due date) covering every card.
import { store } from '../store.js';
import { live, upsert, remove, ensureIssuer, issuerKey } from '../core/model.js';
import { cardOutstanding, issuerUsage, statementsOfIssuer, txIssuerId, billDate } from '../core/calc.js';
import { ymd, ym, addMonths, sum, round2 } from '../core/util.js';
import { esc, money, formDialog, confirmDialog, toast, emptyState } from '../ui.js';
import { accountOptions, adjustAccount } from './common.js';
import { importCardDialog } from './transactions.js';

const issuerName = (L, card) => live(L.issuers).find((i) => i.id === card?.issuerId)?.name || card?.bank || '';
const signed = (t) => (t.type === 'income' ? -1 : 1) * (Number(t.amount) || 0);
const day = (m, d) => `${m}-${String(Math.min(Number(d) || 1, 28)).padStart(2, '0')}`;

const cardFields = () => {
  const f = [
    { key: 'name', label: '卡片名稱（你自己取的）', required: true, placeholder: '例如 Costco 聯名卡' },
    { key: 'issuerName', label: '發卡銀行', required: true, datalist: live(store.ledger.issuers).map((i) => i.name),
      hint: '同一家銀行的卡共用信用額度、合併成一張帳單；額度與結帳日在銀行那一欄設定。' },
    { key: 'last4', label: '卡號末四碼', placeholder: '1234', hint: '匯入帳單時用末四碼找到這張卡。' },
    { key: 'statementLabel', label: '帳單上的名稱', placeholder: '例如 MASTER商務正卡', hint: '帳單上印的卡別（發卡組織、等級），只用來辨認。' },
  ];
  f.validate = (v) => (v.last4 && !/^\d{4}$/.test(v.last4) ? '卡號末四碼請填 4 位數字' : null);
  return f;
};

const issuerFields = [
  { key: 'name', label: '銀行名稱', required: true },
  { key: 'limit', label: '共用信用額度', type: 'number', hint: '這家銀行所有信用卡合計可用的額度，帳單或網銀上查得到。' },
  { key: 'statementDay', label: '結帳日（每月幾號）', type: 'number', step: 1 },
  { key: 'dueDay', label: '繳款截止日（每月幾號）', type: 'number', step: 1 },
  { key: 'note', label: '備註', type: 'textarea', wide: true, placeholder: '例如：臨時額度到 12 月底' },
];

function statementsTable(L, iss) {
  const stmts = statementsOfIssuer(L, iss.id);
  if (!stmts.length) return '<p class="muted small">還沒有帳單。每月收到這家銀行的合併帳單時新增一筆，記錄應繳金額與繳款期限。</p>';
  const cardName = new Map(live(L.cards).map((c) => [c.id, c.name]));
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>期別</th><th>繳款期限</th><th class="r">應繳</th><th class="r hide-sm">已繳</th><th class="r hide-sm">明細合計</th><th></th></tr></thead><tbody>
    ${stmts.map((s) => {
      const txs = live(L.transactions).filter((t) => t.statementId === s.id);
      const detail = round2(sum(txs, signed));
      const byCard = new Map();
      for (const t of txs) byCard.set(t.cardId, (byCard.get(t.cardId) || 0) + signed(t));
      const unpaid = (Number(s.total) || 0) - (Number(s.paidAmount) || 0);
      return `<tr>
        <td class="num">${esc(s.period)}</td><td class="num">${esc(s.dueDate || '')}</td>
        <td class="r">${money(s.total)}${txs.length && Math.abs(detail - s.total) > 0.5 ? ' <span class="tag warn" title="明細加總與帳單金額不同，可能有年費、利息、分期或尚未匯入的明細">差異</span>' : ''}</td>
        <td class="r hide-sm">${money(s.paidAmount || 0)}</td>
        <td class="r hide-sm">${txs.length ? money(detail) : '<span class="muted">—</span>'}</td>
        <td class="r nowrap">${unpaid > 0 ? `<button class="btn primary sm" data-pay="${s.id}">繳費</button>` : '<span class="tag ok">已繳清</span>'}
          <button class="btn ghost sm" data-edit-stm="${s.id}">編輯</button></td></tr>
        ${byCard.size > 1 ? `<tr class="sub-row"><td colspan="6" class="muted small">各卡：${[...byCard].map(([id, v]) => `${esc(id ? cardName.get(id) || '已刪除的卡' : '未指定卡片')} ${money(v)}`).join('、')}</td></tr>` : ''}`;
    }).join('')}</tbody></table></div>`;
}

function cardHtml(L, c, { orphan = false } = {}) {
  const o = cardOutstanding(L, c.id);
  // a card created from a statement still carries the statement's label or "末四碼 1234" as its name
  const unnamed = c.autoCreated && (c.name === c.statementLabel || c.name === `末四碼 ${c.last4}`);
  return `<div class="card-sub">
    <div class="block-head">
      <h3>${esc(c.name)} ${c.last4 ? `<span class="muted num">****${esc(c.last4)}</span>` : ''}
        ${unnamed ? '<span class="tag">從帳單自動建立</span>' : ''}</h3>
      <button class="btn ${unnamed ? 'primary' : 'ghost'} sm" data-edit="${c.id}">${unnamed ? '取名字' : '編輯卡片'}</button>
    </div>
    ${c.statementLabel && c.statementLabel !== c.name ? `<p class="muted small">帳單上顯示：${esc(c.statementLabel)}${c.last4 ? ` 末四碼 ${esc(c.last4)}` : ''}</p>` : ''}
    <div class="kv">
      <div><span>${orphan ? '未繳帳單' : '在未繳帳單中'}</span>${money(o.billed)}</div>
      <div><span>未出帳消費</span>${money(o.unbilled)}</div>
      <div><span>這張卡合計</span>${money(o.total)}</div>
    </div>
  </div>`;
}

/** Charges imported to the bank without a matching card (no card-number column, unknown last4). */
function bankOnly(L, issuerId) {
  const txs = live(L.transactions).filter((t) => t.source === 'card' && !t.cardId && t.issuerId === issuerId);
  if (!txs.length) return '';
  return `<p class="muted small">另有 ${txs.length} 筆明細只記在銀行、沒有指定卡片（合計 ${money(sum(txs, signed))}），已計入這家銀行的帳單與額度。到「收支」編輯明細可以指定卡片。</p>`;
}

function issuerHtml(L, iss) {
  const u = issuerUsage(L, iss.id);
  const pct = u.ratio === null ? null : Math.min(100, u.ratio * 100);
  const level = u.ratio === null ? '' : u.ratio >= 0.9 ? 'crit' : u.ratio >= 0.7 ? 'warn' : '';
  return `<section class="block issuer-block">
    <div class="block-head">
      <h2>${esc(iss.name)} <span class="muted small">${u.cards.length} 張卡・共用額度・合併帳單</span></h2>
      <button class="btn ghost sm" data-edit-iss="${iss.id}">編輯銀行</button>
    </div>
    <div class="kv">
      <div><span>共用額度</span>${u.limit ? money(u.limit) : '<span class="muted">未設定</span>'}</div>
      <div><span>已使用</span>${money(u.used)}</div>
      <div><span>可用額度</span>${u.available === null ? '<span class="muted">—</span>' : money(u.available)}</div>
      <div><span>使用率</span>${pct === null ? '<span class="muted">—</span>' : `<span class="num ${level}">${pct.toFixed(0)}%</span>`}</div>
    </div>
    ${pct === null ? '' : `<div class="meter ${level}" role="meter" aria-label="${esc(iss.name)}額度使用率" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`}
    <div class="kv">
      <div><span>已出帳未繳</span>${money(u.unpaidStatements)}</div>
      <div><span>未出帳消費</span>${money(u.unbilled)}</div>
      ${u.installmentHeld ? `<div><span title="分期還沒出帳的部分，銀行會先從額度扣住">分期占用額度</span>${money(u.installmentHeld)}</div>` : ''}
      <div><span>結帳日／繳款期限</span><span class="num">${iss.statementDay ? `${esc(iss.statementDay)} 日` : '—'}／${iss.dueDay ? `${esc(iss.dueDay)} 日` : '—'}</span></div>
    </div>
    ${iss.note ? `<p class="muted small">${esc(iss.note)}</p>` : ''}
    <h3 class="sub-head">合併帳單 <span class="nowrap"><button class="btn ghost sm" data-imp="${iss.id}">匯入明細</button>
      <button class="btn ghost sm" data-stm="${iss.id}">新增帳單</button></span></h3>
    ${statementsTable(L, iss)}
    <h3 class="sub-head">卡片</h3>
    ${u.cards.map((p) => cardHtml(L, p.card)).join('')}
    ${bankOnly(L, iss.id)}
  </section>`;
}

export function renderCards(root) {
  const L = store.ledger;
  const cards = live(L.cards);
  const issuers = live(L.issuers)
    .filter((i) => cards.some((c) => c.issuerId === i.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  const orphans = cards.filter((c) => !issuers.some((i) => i.id === c.issuerId));
  root.innerHTML = `
  <p class="intro">台灣的信用卡以銀行為單位：同一家銀行的卡共用一個信用額度，消費合併在同一張帳單，一次繳清。直接匯入銀行帳單即可，卡片會依帳單上的末四碼自動建立。</p>
  <div class="toolbar"><button class="btn primary" id="c-imp">匯入信用卡帳單</button><button class="btn ghost" id="c-add">手動新增信用卡</button></div>
  ${cards.length ? issuers.map((i) => issuerHtml(L, i)).join('') + (orphans.length ? `<section class="block">
      <div class="block-head"><h2>未指定銀行</h2></div>
      <p class="notice">這些卡還沒有填發卡銀行，請按「編輯卡片」補上，才能計算共用額度和合併帳單。</p>
      ${orphans.map((c) => cardHtml(L, c, { orphan: true })).join('')}</section>` : '')
    : emptyState('還沒有信用卡。按「匯入信用卡帳單」選擇或貼上銀行帳單，銀行、卡片和當期合併帳單都會自動建立。')}`;

  root.querySelector('#c-add').onclick = () => editCard();
  root.querySelector('#c-imp').onclick = () => importCardDialog();
  root.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editCard(L.cards.find((c) => c.id === b.dataset.edit))));
  root.querySelectorAll('[data-edit-iss]').forEach((b) => (b.onclick = () => editIssuer(L.issuers.find((i) => i.id === b.dataset.editIss))));
  root.querySelectorAll('[data-stm]').forEach((b) => (b.onclick = () => editStatement(b.dataset.stm)));
  root.querySelectorAll('[data-edit-stm]').forEach((b) => (b.onclick = () => {
    const s = L.statements.find((x) => x.id === b.dataset.editStm);
    editStatement(s.issuerId || L.cards.find((c) => c.id === s.cardId)?.issuerId, s);
  }));
  root.querySelectorAll('[data-imp]').forEach((b) => (b.onclick = () => importCardDialog(b.dataset.imp)));
  root.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = () => payStatement(L.statements.find((s) => s.id === b.dataset.pay))));
}

async function editCard(card) {
  const values = card ? { ...card, issuerName: issuerName(store.ledger, card) } : {};
  const v = await formDialog({
    title: card ? '編輯信用卡' : '新增信用卡', fields: cardFields(), values,
    intro: card?.autoCreated ? '這張卡是從帳單自動建立的。替它取個好認的名字；之後匯入時仍會用末四碼對應到這張卡。' : '',
    extraButtons: card ? [{ label: '刪除', value: 'delete', danger: true }] : [],
  });
  if (!v) return;
  if (v.__action === 'delete') {
    if (await confirmDialog(`刪除「${card.name}」？已記錄的刷卡交易會保留。`, '刪除', true)) store.commit((l) => remove(l, 'cards', card.id));
    return;
  }
  const { issuerName: bankName, ...rest } = v;
  const isNewBank = !live(store.ledger.issuers).some((i) => issuerKey(i.name) === issuerKey(bankName));
  const iss = store.commit((l) => {
    const i = ensureIssuer(l, bankName);
    upsert(l, 'cards', { ...rest, issuerId: i.id, bank: i.name, ...(card ? { id: card.id } : {}) });
    return i;
  });
  toast('已儲存');
  if (isNewBank) {
    await new Promise((r) => setTimeout(r, 50));
    await editIssuer(store.ledger.issuers.find((i) => i.id === iss.id), `「${iss.name}」是新的發卡銀行，請填入共用信用額度與合併帳單的結帳日、繳款期限。`);
  }
}

async function editIssuer(iss, intro = '') {
  const hasCards = live(store.ledger.cards).some((c) => c.issuerId === iss.id);
  const v = await formDialog({
    title: iss.name, fields: issuerFields, values: iss, intro: esc(intro),
    extraButtons: hasCards ? [] : [{ label: '刪除銀行', value: 'delete', danger: true }],
  });
  if (!v) return;
  if (v.__action === 'delete') {
    store.commit((l) => remove(l, 'issuers', iss.id));
    return;
  }
  store.commit((l) => {
    upsert(l, 'issuers', { ...v, id: iss.id });
    // keep the denormalised bank name on cards in step (older app versions read it)
    for (const c of live(l.cards).filter((x) => x.issuerId === iss.id && x.bank !== v.name)) upsert(l, 'cards', { id: c.id, bank: v.name });
  });
  toast('已儲存');
}

async function editStatement(issuerId, stm) {
  const L = store.ledger;
  const iss = L.issuers.find((i) => i.id === issuerId);
  if (!iss) {
    toast('這張帳單的卡片還沒有指定銀行，請先編輯卡片補上發卡銀行', 'error');
    return;
  }
  const period = stm?.period || ym(ymd());
  const closing = stm?.closingDate || day(period, iss.statementDay || 1);
  const prevClose = statementsOfIssuer(L, issuerId).filter((s) => s.id !== stm?.id && s.closingDate < closing).map((s) => s.closingDate).sort().pop();
  const values = stm || {
    period, closingDate: closing,
    dueDate: day(Number(iss.dueDay) < Number(iss.statementDay) ? addMonths(period, 1) : period, iss.dueDay || 15), paidAmount: 0,
  };
  const fields = [
    { key: 'period', label: '帳單月份', type: 'month', required: true },
    { key: 'closingDate', label: '結帳日', type: 'date', required: true },
    { key: 'dueDate', label: '繳款截止日', type: 'date', required: true },
    { key: 'total', label: '本期應繳總額', type: 'number', hint: '帳單上的「本期應繳總金額」。留空會用歸入的刷卡明細加總。' },
    { key: 'paidAmount', label: '已繳金額', type: 'number' },
    { key: 'paidDate', label: '繳款日', type: 'date' },
    { key: 'attach', label: '把這家銀行所有卡、上次結帳後到本次結帳日的刷卡明細歸入這張帳單', type: 'checkbox', default: !stm, wide: true },
  ];
  const v = await formDialog({ title: `${iss.name} 合併帳單`, fields, values, extraButtons: stm ? [{ label: '刪除', value: 'delete', danger: true }] : [] });
  if (!v) return;
  if (v.__action === 'delete') {
    if (await confirmDialog('刪除這張帳單？歸入的刷卡明細會改回未出帳。', '刪除', true)) {
      store.commit((l) => {
        for (const t of live(l.transactions).filter((x) => x.statementId === stm.id)) {
          const copy = { ...t };
          delete copy.statementId;
          l.transactions[l.transactions.indexOf(t)] = { ...copy, updatedAt: new Date().toISOString() };
        }
        remove(l, 'statements', stm.id);
      });
    }
    return;
  }
  const { attach, ...rec } = v;
  store.commit((l) => {
    const s = upsert(l, 'statements', { ...rec, issuerId, ...(stm ? { id: stm.id } : {}) });
    if (attach) {
      const txs = live(l.transactions).filter((t) => t.source === 'card' && txIssuerId(l, t) === issuerId && !t.statementId && billDate(t) <= s.closingDate && (!prevClose || billDate(t) > prevClose));
      txs.forEach((t) => upsert(l, 'transactions', { id: t.id, statementId: s.id }));
    }
    if (!(Number(s.total) > 0)) {
      const total = round2(sum(live(l.transactions).filter((t) => t.statementId === s.id), signed));
      upsert(l, 'statements', { id: s.id, total });
    }
  });
  toast('已儲存帳單');
}

async function payStatement(s) {
  const L = store.ledger;
  const iss = L.issuers.find((i) => i.id === (s.issuerId || L.cards.find((c) => c.id === s.cardId)?.issuerId));
  const unpaid = round2((Number(s.total) || 0) - (Number(s.paidAmount) || 0));
  const v = await formDialog({
    title: `繳 ${iss ? iss.name + ' ' : ''}${s.period} 卡費`,
    fields: [
      { key: 'amount', label: '繳款金額', type: 'number', required: true },
      { key: 'date', label: '繳款日', type: 'date', required: true },
      { key: 'accountId', label: '從哪個帳戶扣款', type: 'select', options: () => accountOptions() },
    ],
    values: { amount: unpaid, date: ymd() },
    intro: '一次繳清這家銀行所有卡的合併帳單。繳卡費是把錢從帳戶移到信用卡，不算支出（支出在刷卡時就已計入）。',
    submitLabel: '記錄繳款',
  });
  if (!v) return;
  store.commit((l) => {
    upsert(l, 'statements', { id: s.id, paidAmount: round2((Number(s.paidAmount) || 0) + v.amount), paidDate: v.date });
    adjustAccount(l, v.accountId, -v.amount);
  });
  toast('已記錄繳款');
}
