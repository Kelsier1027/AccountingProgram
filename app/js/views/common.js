import { store } from '../store.js';
import { live, LABELS, EXPENSE_CATEGORIES, INCOME_CATEGORIES, upsert } from '../core/model.js';
import { esc } from '../ui.js';

const STATUS_TEXT = {
  idle: ['本機', '尚未同步'], local: ['本機', '只存在這台裝置'], pending: ['待同步', '有修改尚未上傳'],
  syncing: ['同步中', '正在與 GitHub 同步'], synced: ['已同步', ''], offline: ['離線', '恢復連線後會自動同步'],
  error: ['同步失敗', ''],
};

/** The red seal on the passbook: shows sync state like a bank's date stamp. */
export function stampHtml() {
  const [word, detail] = STATUS_TEXT[store.status] || STATUS_TEXT.idle;
  const when = store.lastSync ? new Date(store.lastSync) : null;
  const date = when ? `${when.getMonth() + 1}.${when.getDate()}` : '—';
  const title = store.status === 'error' ? store.error : detail || (when ? `上次同步 ${when.toLocaleString('zh-TW')}` : '');
  return `<a class="stamp st-${store.status}" href="#/settings" title="${esc(title)}" aria-label="同步狀態：${esc(word)}${title ? '，' + esc(title) : ''}">
    <span class="stamp-date num">${esc(date)}</span><span class="stamp-word">${esc(word)}</span></a>`;
}

/** Compact sync indicator for the page header. */
export function syncPillHtml() {
  const [word, detail] = STATUS_TEXT[store.status] || STATUS_TEXT.idle;
  const title = store.status === 'error' ? store.error : detail;
  return `<a class="sync-pill st-${store.status}" href="#/settings" title="${esc(title || '')}"><span class="dot" aria-hidden="true"></span>${esc(word)}</a>`;
}

export const accountOptions =(withNone = true) => [
  ...(withNone ? [['', '（不連動帳戶）']] : []),
  ...live(store.ledger.accounts).map((a) => [a.id, `${a.name}${a.currency && a.currency !== 'TWD' ? `（${a.currency}）` : ''}`]),
];
export const cardOptions = (withNone = true) => [
  ...(withNone ? [['', '（無）']] : []),
  ...live(store.ledger.cards).map((c) => [c.id, `${c.name}${c.last4 ? ` ****${c.last4}` : ''}`]),
];
export const opts = (obj) => Object.entries(obj);

/** Adjust an account balance as part of a payment (negative = money out). Must run inside store.commit. */
export function adjustAccount(ledger, accountId, delta) {
  if (!accountId) return;
  const a = ledger.accounts.find((x) => x.id === accountId && !x.deleted);
  if (a) upsert(ledger, 'accounts', { id: a.id, balance: Math.round(((Number(a.balance) || 0) + delta) * 100) / 100 });
}

const splitPartners = () => [...new Set(live(store.ledger.transactions).map((t) => t.split?.with).filter(Boolean))];

export function txFields(type = 'expense', { bankOnly = false } = {}) {
  const cats = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const f = [
    { key: 'type', label: '收支', type: 'select', options: [['expense', '支出'], ['income', '收入']] },
    { key: 'date', label: '日期', type: 'date', required: true },
    { key: 'amount', label: '金額', type: 'number', required: true },
    { key: 'merchant', label: '商家／說明', type: 'text' },
    { key: 'category', label: '類別', type: 'text', datalist: [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES], default: cats[0] },
    { key: 'source', label: '來源', type: 'select', options: opts(LABELS.source) },
    { key: 'paymentMethod', label: '付款方式', type: 'select', options: [['', '未指定'], ...opts(LABELS.payMethod)],
      hint: '設為「現金」或「轉帳」的記錄不會拿去跟刷卡配對。' },
    { key: 'cardId', label: '信用卡', type: 'select', options: () => cardOptions(),
      hint: bankOnly ? '這筆是匯入時沒對到卡號、只記在銀行的明細，可以在這裡指定卡片。' : undefined },
    { key: 'excluded', label: '不計入收支', type: 'checkbox', hint: '別人付的錢（家人的卡、代墊後全額收回…）：保留記錄，但不算在你的收入或支出。' },
    { key: 'splitWith', label: '分帳對象', type: 'text', datalist: splitPartners(), placeholder: '不分帳請留空', hint: '和別人分攤的消費：收支只算你的份，對方的份記成對方欠你（在「借貸」頁的分帳往來）。' },
    { key: 'splitMine', label: '你的份', type: 'number', hint: '對半就填金額的一半；全部是對方的填 0。' },
    { key: 'oneOff', label: '非日常支出（不列入日常支出估計）', type: 'checkbox', hint: '搬家、旅行、添購家電這類一次性的花費：仍算在支出裡，但投資規劃估算每月日常支出時不會用到。' },
    { key: 'topUp', label: '儲值（不算支出）', type: 'checkbox', hint: '儲值到店家 App 或電子錢包（摩斯、星巴克、悠遊卡…）的金額：仍計入卡費與帳戶，但實際消費以使用時的發票計算。' },
    { key: 'invoiceNo', label: '發票號碼', type: 'text' },
    { key: 'note', label: '備註', type: 'textarea', wide: true },
  ];
  f.validate = (v) => (!(v.amount > 0) ? '金額必須大於 0' : v.source === 'card' && !v.cardId && !bankOnly ? '刷卡交易請選擇信用卡' : null);
  return f;
}
