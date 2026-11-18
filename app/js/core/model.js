import { uid, nowIso } from './util.js';

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = [
  'accounts', 'assets', 'holdings', 'issuers', 'cards', 'statements', 'transactions',
  'links', 'bills', 'loans', 'ious', 'snapshots',
];

export const EXPENSE_CATEGORIES = [
  '餐飲', '日用品', '交通', '居住', '水電瓦斯', '電信網路', '購物', '娛樂',
  '醫療', '教育', '保險', '稅費', '訂閱', '分期', '貸款利息', '人情', '現金', '其他',
];
export const INCOME_CATEGORIES = ['薪資', '獎金', '補助', '回饋', '投資收益', '利息', '退款', '其他收入'];

export const LABELS = {
  accountType: { cash: '現金', bank: '銀行存款', ewallet: '電子支付', securities: '證券交割戶', other: '其他' },
  source: { card: '刷卡', invoice: '載具', manual: '手動', bill: '繳費', bank: '銀行帳戶' },
  billCycle: { monthly: '每月', bimonthly: '每兩月', quarterly: '每季', yearly: '每年', once: '一次' },
  loanKind: { student: '學貸', credit: '信貸', mortgage: '房貸', car: '車貸', installment: '信用卡分期', other: '其他' },
  iouDir: { owedToMe: '別人欠我', iOwe: '我欠別人' },
  payMethod: { card: '信用卡', cash: '現金', transfer: '轉帳', other: '其他' },
};

export function emptyLedger() {
  const l = { schemaVersion: SCHEMA_VERSION, settings: { baseCurrency: 'TWD', upColor: 'red' }, updatedAt: nowIso() };
  for (const c of COLLECTIONS) l[c] = [];
  return l;
}

/** Fill in missing collections so older/hand-edited files still load. */
export function normalizeLedger(l) {
  const out = l && typeof l === 'object' ? l : emptyLedger();
  out.schemaVersion ??= SCHEMA_VERSION;
  out.settings = { baseCurrency: 'TWD', upColor: 'red', ...(out.settings || {}) };
  for (const c of COLLECTIONS) if (!Array.isArray(out[c])) out[c] = [];
  migrateCardsToIssuers(out);
  return out;
}

/* ---------- card issuers (Taiwan: one shared credit limit per bank) ---------- */

const MIGRATION_STAMP = '1970-01-01T00:00:00.000Z';

function hash36(str) {
  let h = 5381;
  for (const ch of str) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36);
}

// Common short / long / English names of Taiwanese card issuers → one key.
const BANK_ALIASES = [
  [/^(台北|臺北)?富邦$|^fubon$|^taipeifubon$/, '富邦'],
  [/^中國信託$|^中信$|^ctbc$/, '中國信託'],
  [/^國泰(世華)?$|^cathay(unitedbank)?$/, '國泰世華'],
  [/^(台灣|臺灣)?玉山$|^esun$|^e\.sun$/, '玉山'],
  [/^台新$|^taishin$/, '台新'],
  [/^永豐$|^sinopac$/, '永豐'],
  [/^合作金庫$|^合庫$/, '合作金庫'],
  [/^第一$|^一銀$/, '第一'],
  [/^(台灣|臺灣)?土地$|^土銀$/, '土地'],
  [/^(台灣|臺灣)$|^台銀$|^臺銀$/, '台灣'],
  [/^(滙豐|匯豐)$|^hsbc$/, '滙豐'],
  [/^花旗$|^citi(bank)?$/, '花旗'],
  [/^星展$|^dbs$/, '星展'],
  [/^渣打$|^standardchartered$/, '渣打'],
  [/^聯邦$|^ubot$/, '聯邦'],
  [/^遠東$|^遠銀$|^fareastern$/, '遠東'],
  [/^新光$|^skbank$/, '新光'],
  [/^凱基$|^kgi$/, '凱基'],
  [/^元大$|^yuanta$/, '元大'],
  [/^兆豐$|^megabank$|^mega$/, '兆豐'],
  [/^(華南|彰化|上海|陽信|將來|樂天|連線|王道)$/, null],
];

/**
 * Bank names as typed vary ("玉山", "玉山銀行", "台北富邦商業銀行", "富邦"); compare on a
 * normalised key so the same bank is never created twice.
 */
export function issuerKey(name) {
  let k = String(name || '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[(（]?(台灣|臺灣|taiwan)[)）]$/i, '')
    .replace(/(股份有限公司|國際商業銀行|商業銀行|銀行|bank|credit ?card|信用卡)$/i, '')
    .replace(/[(（]?(台灣|臺灣|taiwan)[)）]$/i, '')
    .toLowerCase();
  for (const [re, canon] of BANK_ALIASES) {
    if (re.test(k)) {
      if (canon) k = canon;
      break;
    }
  }
  return k;
}

/** Deterministic id: every device that migrates the same bank creates the same record. */
export const issuerIdFor = (name) => `iss_${hash36(issuerKey(name) || name)}`;

/** Find the bank by name or create it (mutates ledger). Returns the issuer. */
export function ensureIssuer(ledger, name) {
  const key = issuerKey(name);
  const found = live(ledger.issuers).find((i) => issuerKey(i.name) === key);
  if (found) return found;
  return upsert(ledger, 'issuers', { id: issuerIdFor(name), name: String(name).trim(), limit: null });
}

/**
 * Older ledgers kept `bank` and `limit` on each card. Move them to one issuer per bank.
 * Idempotent and deterministic (fixed ids and timestamps), so two devices migrating
 * independently produce identical records and nothing conflicts when they merge.
 */
export function migrateCardsToIssuers(ledger) {
  for (const card of ledger.cards) {
    if (card.deleted || card.issuerId || !card.bank) continue;
    const id = issuerIdFor(card.bank);
    let iss = ledger.issuers.find((i) => i.id === id);
    if (!iss) {
      iss = { id, name: String(card.bank).trim(), limit: null, updatedAt: MIGRATION_STAMP };
      ledger.issuers.push(iss);
    }
    if (iss.updatedAt === MIGRATION_STAMP && Number(card.limit) > (Number(iss.limit) || 0)) iss.limit = Number(card.limit);
    card.issuerId = id;
  }
  migrateStatementsToIssuers(ledger);
}

/**
 * Taiwanese banks send one combined statement for all of a customer's cards, so statements
 * and the closing / due days belong to the bank. Older ledgers kept them per card.
 * Deterministic and idempotent like the card migration (no timestamps are changed; the
 * values are derived from the cards, so every device derives the same ones).
 */
export function migrateStatementsToIssuers(ledger) {
  const cardById = new Map(ledger.cards.map((c) => [c.id, c]));
  for (const s of ledger.statements) {
    if (s.deleted || s.issuerId || !s.cardId) continue;
    const iss = cardById.get(s.cardId)?.issuerId;
    if (iss) s.issuerId = iss;
  }
  for (const iss of ledger.issuers) {
    if (iss.deleted) continue;
    const cards = ledger.cards.filter((c) => !c.deleted && c.issuerId === iss.id).sort((a, b) => a.id.localeCompare(b.id));
    if (iss.statementDay == null) {
      const c = cards.find((x) => Number(x.statementDay) > 0);
      if (c) iss.statementDay = Number(c.statementDay);
    }
    if (iss.dueDay == null) {
      const c = cards.find((x) => Number(x.dueDay) > 0);
      if (c) iss.dueDay = Number(c.dueDay);
    }
  }
}

/** Records that are not tombstoned. */
export const live = (arr) => (arr || []).filter((r) => !r.deleted);

export function byId(ledger, coll, id) {
  return (ledger[coll] || []).find((r) => r.id === id && !r.deleted);
}

const PREFIX = {
  accounts: 'acc_', assets: 'ast_', holdings: 'hld_', issuers: 'iss_', cards: 'crd_', statements: 'stm_',
  transactions: 'tx_', links: 'lnk_', bills: 'bil_', loans: 'lon_', ious: 'iou_', snapshots: 'snp_',
};

/** Insert or update a record (mutates ledger). Returns the stored record. */
export function upsert(ledger, coll, rec) {
  const arr = ledger[coll];
  const stamp = nowIso();
  if (rec.id) {
    const i = arr.findIndex((r) => r.id === rec.id);
    if (i >= 0) {
      arr[i] = { ...arr[i], ...rec, updatedAt: stamp };
      ledger.updatedAt = stamp;
      return arr[i];
    }
  }
  const r = { ...rec, id: rec.id || uid(PREFIX[coll] || ''), updatedAt: stamp };
  arr.push(r);
  ledger.updatedAt = stamp;
  return r;
}

/** Tombstone a record so the deletion survives a merge with another device. */
export function remove(ledger, coll, id) {
  const r = (ledger[coll] || []).find((x) => x.id === id);
  if (!r) return;
  for (const k of Object.keys(r)) if (!['id'].includes(k)) delete r[k];
  r.deleted = true;
  r.updatedAt = nowIso();
  ledger.updatedAt = r.updatedAt;
}

/** Unique plaintext list of symbols for the price workflow. */
export function symbolsOf(ledger) {
  return [...new Set(live(ledger.holdings).map((h) => String(h.symbol || '').trim().toUpperCase()).filter(Boolean))].sort();
}

export function currenciesOf(ledger) {
  const set = new Set();
  for (const c of ['accounts', 'assets', 'holdings']) for (const r of live(ledger[c])) if (r.currency && r.currency !== 'TWD') set.add(r.currency);
  return [...set].sort();
}
