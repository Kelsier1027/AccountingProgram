// Importers for e-invoice carrier exports and credit-card statement CSVs.
import { parseDate, num, round2, normalizeName } from './util.js';
import { live, upsert, ensureIssuer } from './model.js';
import { absorbSplitPlaceholders } from './split.js';

/** RFC-4180-ish CSV parser. Auto-detects delimiter among , ; \t | */
export function parseCsv(text, delimiter) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = delimiter || [',', '\t', ';', '|'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()));
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()));
  return rows;
}

const VOID = /作廢|註銷|void/i;

/**
 * Parse the Ministry of Finance e-invoice export.
 * Pipe format:  M|載具名稱|載具號碼|發票日期|商店統編|商店店名|發票號碼|總金額|發票狀態|
 *               D|發票號碼|小計|品項名稱|
 * Also accepts a headered CSV that has 發票號碼 / 發票日期 / 店名 / 金額 columns (one row per invoice or per item).
 */
export function parseEInvoice(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const invoices = new Map();

  const pipeLines = lines.filter((l) => /^(M|D)\|/.test(l));
  if (pipeLines.length) {
    for (const l of pipeLines) {
      const c = l.split('|').map((x) => x.trim());
      if (c[0] === 'M') {
        const [, carrierName, carrierNo, date, taxId, shop, invNo, total, status] = c;
        if (VOID.test(status || '')) continue;
        invoices.set(invNo, {
          invoiceNo: invNo, date: parseDate(date), merchant: shop, taxId, amount: num(total),
          carrier: [carrierName, carrierNo].filter(Boolean).join(' '), items: [],
        });
      } else if (c[0] === 'D') {
        const [, invNo, sub, name] = c;
        const inv = invoices.get(invNo);
        if (inv) inv.items.push({ name, amount: num(sub) });
      }
    }
    return [...invoices.values()].filter((i) => i.date && i.invoiceNo);
  }

  // headered CSV variant: the platform's current export has one row per line item, each row
  // repeating the invoice header. Its "發票金額" column holds the LINE amount (it equals
  // 消費明細_金額), so the invoice total must be the sum of all lines, discounts included.
  const rows = parseCsv(src);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  // Columns are found by names in priority order: exact header first, then "contains".
  // (A plain "contains" scan picked 賣方統一編號 for 賣方 and 發票金額 for 金額.)
  const col = (...names) => {
    for (const n of names) {
      const i = head.findIndex((h) => h === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = head.findIndex((h) => h.toLowerCase().includes(n.toLowerCase()));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iNo = col('發票號碼', 'invoice');
  const iDate = col('發票日期', '消費日期', '日期', 'date');
  const iShop = col('賣方名稱', '商店名稱', '店名', '商店店名', 'merchant');
  const iTaxId = col('賣方統一編號', '商店統編', '賣方統編');
  const iTotal = col('發票總金額', '總金額', '發票金額', 'total');
  const iItem = col('消費明細_品名', '品名', '品項名稱', '品項', 'item');
  const iSub = col('消費明細_金額', '明細金額', '小計', '品項金額', 'amount');
  const iQty = col('消費明細_數量', '數量', 'qty');
  const iPrice = col('消費明細_單價', '單價', 'price');
  const iStatus = col('發票狀態', '狀態', 'status');
  const iCarrier = col('載具自訂名稱', '載具名稱', '載具', 'carrier');
  if (iNo < 0 || iDate < 0) return [];
  const itemAmountCol = iSub >= 0 && iSub !== iTotal ? iSub : -1;
  const totals = new Map(); // invoiceNo -> values seen in the total column
  let lastItem = null;
  for (const r of rows.slice(1)) {
    // a product name with a line break is exported unquoted: the rest of the name is a row of its own
    if (r.length === 1 && lastItem && r[0].trim() && !/捐贈或作廢|注意：/.test(r[0])) {
      lastItem.name = `${lastItem.name} ${r[0].trim()}`;
      continue;
    }
    lastItem = null;
    const no = (r[iNo] || '').trim();
    const date = parseDate(r[iDate]);
    if (!no || !date) continue; // footer notes, blank lines
    if (iStatus >= 0 && VOID.test(r[iStatus] || '')) continue;
    let inv = invoices.get(no);
    if (!inv) {
      inv = {
        invoiceNo: no, date, merchant: iShop >= 0 ? (r[iShop] || '').trim() : '',
        taxId: iTaxId >= 0 ? r[iTaxId] : undefined,
        carrier: iCarrier >= 0 ? r[iCarrier] : '', items: [],
      };
      invoices.set(no, inv);
      totals.set(no, []);
    }
    if (iTotal >= 0 && r[iTotal] !== '') totals.get(no).push(num(r[iTotal]));
    const name = iItem >= 0 ? (r[iItem] || '').trim() : '';
    const lineAmount = itemAmountCol >= 0 ? num(r[itemAmountCol]) : iTotal >= 0 ? num(r[iTotal]) : 0;
    if (name || lineAmount) {
      const item = { name: name || '（未命名品項）', amount: lineAmount };
      if (iQty >= 0 && r[iQty] !== '') item.qty = num(r[iQty]);
      if (iPrice >= 0 && r[iPrice] !== '') item.price = num(r[iPrice]);
      inv.items.push(item);
      lastItem = item;
    }
  }
  for (const inv of invoices.values()) {
    const itemSum = round2(inv.items.reduce((s, i) => s + i.amount, 0));
    const t = totals.get(inv.invoiceNo) || [];
    const repeatedTotal = t.length && t.every((v) => v === t[0]) ? t[0] : null;
    // A real per-invoice total is repeated unchanged on every row; when it varies per row it is
    // a line amount. Prefer the line items whenever they exist.
    inv.amount = inv.items.length && (itemAmountCol >= 0 || repeatedTotal === null) ? itemSum : repeatedTotal ?? itemSum;
  }
  return [...invoices.values()];
}

const CATEGORY_HINTS = [
  [/爭鮮|壽司|迴轉|skylark|sukiya|すき家|吉野家|潮味決|煎餅|早餐|牛肉麵|拉麵|火鍋|涮涮|燒肉|便當|自助餐/i, '餐飲'],
  [/全家|7-?eleven|統一超商|萊爾富|ok超商|麥當勞|摩斯|星巴克|路易莎|餐|飯|麵|食|咖啡|便當|飲/i, '餐飲'],
  [/富胖達|foodpanda|優食|uber ?eats/i, '餐飲'],
  [/全聯|家樂福|好市多|costco|屈臣氏|康是美|寶雅|大買家|美廉社|康達盛通|生活館|五金|宜家|ikea|特力屋|無印良品|小北百貨|生鮮超市|超市/i, '日用品'],
  [/中油|台塑石油|捷運|高鐵|台鐵|uber|計程車|停車|悠遊卡|一卡通|加油|汽油|威摩|wemo|gogoro|和雲|和運|租車|車輛租賃|irent|hoing/i, '交通'],
  [/台電|電力|自來水|瓦斯|天然氣/i, '水電瓦斯'],
  [/中華電信|台灣大哥大|遠傳|台灣之星|亞太電信|寬頻|光世代|網路費|上網|月租費/i, '電信網路'],
  [/醫院|診所|藥局|藥妝/i, '醫療'],
  [/電影|影城|netflix|spotify|steam|valve|遊戲|健身|健康世界|world ?gy|百樂園|旅行社|易遊網/i, '娛樂'],
  [/momo|富邦媒體|蝦皮|pchome|網路家庭|博客來|amazon|uniqlo|購物|小米|燦坤|全國電子|順發/i, '購物'],
  [/anthropic|openai|apple distribution|google|microsoft|adobe|自動扣款|subscription|訂閱|in-app|無廣告/i, '訂閱'],
  // food words on the line items (stores like 和德昌 = a McDonald's franchise say nothing)
  [/料理|小館|餐館|堡|薯|雞塊|雞翅|拉麵|河粉|粄條|春捲|三明治|甜甜圈|可麗露|飯糰|手卷|牛肉湯|豆漿|奶茶|可頌|鍋|蛋撻|盤|壽司|丼|爭鮮|肯德基/, '餐飲'],
];

export function guessCategory(merchant, items = []) {
  const half = (v) => String(v || '').replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  merchant = half(merchant);
  items = items.map((i) => ({ ...i, name: half(i.name) }));
  // The store says more than its items: a Costco receipt with 冷麵 on it is still 日用品.
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(merchant || '')) return cat;
  const text = items.map((i) => i.name).join(' ');
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(text)) return cat;
  return '其他';
}

/** Add parsed invoices to the ledger, skipping invoice numbers already present. */
/**
 * Add parsed invoices to the ledger. Invoice numbers already present are updated when the file
 * says something different (amount, items, store) — that repairs records imported by an older,
 * buggy parser — while the user's own edits (category, note, payment method, links) are kept.
 * Invoices that net to zero (gifts only) are skipped; a negative net is a refund.
 */
export function importInvoices(ledger, invoices) {
  const addedIds = [];
  const byNo = new Map(live(ledger.transactions).filter((t) => t.invoiceNo).map((t) => [t.invoiceNo, t]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const inv of invoices) {
    const net = round2(inv.amount);
    const fields = {
      date: inv.date, amount: Math.abs(net), type: net < 0 ? 'income' : 'expense',
      merchant: inv.merchant, items: inv.items, carrier: inv.carrier,
      ...(inv.taxId ? { taxId: inv.taxId } : {}),
    };
    let existing = byNo.get(inv.invoiceNo);
    if (!existing) {
      // the same invoice added earlier without its number (from Moneybook): give it the number
      const bare = live(ledger.transactions).find((t) => t.source === 'invoice' && !t.invoiceNo && t.date === inv.date
        && Math.round(t.amount) === Math.round(Math.abs(net)) && normalizeName(t.merchant) === normalizeName(inv.merchant));
      if (bare) {
        upsert(ledger, 'transactions', { id: bare.id, invoiceNo: inv.invoiceNo, items: inv.items, ...(inv.taxId ? { taxId: inv.taxId } : {}) });
        byNo.set(inv.invoiceNo, bare);
        updated++;
        continue;
      }
    }
    if (existing) {
      const same = existing.amount === fields.amount && existing.type === fields.type && existing.merchant === fields.merchant
        && JSON.stringify(existing.items || []) === JSON.stringify(fields.items);
      // a total confirmed from another source (Moneybook's 發票金額, incl. tax the line items miss) stays
      if (same || existing.source !== 'invoice' || existing.totalFixed) skipped++;
      else {
        // A category that is still the automatic guess for the old (wrong) data was never
        // chosen by the user, so guess again from the corrected store and items.
        // ("其他" is the fallback when nothing matched, so it counts as never chosen too.)
        const autoCategory = !existing.category || existing.category === '其他'
          || existing.category === guessCategory(existing.merchant, existing.items || []);
        const category = net < 0 ? '退款' : guessCategory(fields.merchant, fields.items);
        upsert(ledger, 'transactions', { id: existing.id, ...fields, ...(autoCategory ? { category } : {}) });
        updated++;
      }
      continue;
    }
    if (net === 0) {
      skipped++;
      continue;
    }
    const t = upsert(ledger, 'transactions', {
      ...fields, source: 'invoice', invoiceNo: inv.invoiceNo,
      category: net < 0 ? '退款' : guessCategory(inv.merchant, inv.items),
    });
    byNo.set(inv.invoiceNo, t);
    addedIds.push(t.id);
    added++;
  }
  const splitsAbsorbed = absorbSplitPlaceholders(ledger, addedIds);
  return { added, updated, skipped, ...(splitsAbsorbed ? { splitsAbsorbed } : {}) };
}

/** The bank a card transaction belongs to: its own issuerId, else its card's bank. */
function txBank(ledger, t) {
  if (t.issuerId) return t.issuerId;
  return ledger?.cards?.find((c) => c.id === t.cardId)?.issuerId || null;
}

/**
 * Duplicate key for card transactions. Taiwanese statements are per bank, so the key is the
 * bank (falling back to the card for cards without one): re-importing a statement must not add
 * rows again even if a row is now assigned to a different card of the same bank.
 */
export const fingerprint = (t, ledger) =>
  `${txBank(ledger, t) || t.cardId || ''}|${t.date}|${round2(t.amount)}|${t.type}|${normalizeName(t.merchant)}`;

const REFUND = /退款|退貨|refund|credit|回饋|折抵/i;

/** Last four digits found in a cell such as "1234", "****-1234", "正卡 4311-****-****-1234". */
export function last4Of(cell) {
  const digits = String(cell || '').replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).match(/\d{4}(?!.*\d)/);
  return digits ? digits[0] : null;
}

const toHalf = (v) => String(v || '').replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
/**
 * Store name from a statement cell: drops the location some banks append after a run of spaces
 * ("全家便利商店－常興店     TAIPEI       TW" → "全家便利商店－常興店") before tidying up.
 */
export const cleanMerchant = (v) => cleanCell(String(v || '').replace(/\s{2,}[A-Za-z][A-Za-z .]*\s+[A-Z]{2,3}\s*$/, ''));

/**
 * Installment rows ("網路家庭分期０１－１０" = 1st of 10, "…分期全退０１期" = cancelled).
 * The purchase itself is spending (its e-invoice carries the full price); installments are
 * repayments, so they count toward the card bill but not as spending.
 */
export function installmentOf(desc) {
  const t = toHalf(String(desc || '').replace(/[－—–]/g, '-'));
  if (!/分期/.test(t)) return null;
  const m = t.match(/分期\s*(\d{1,2})\s*-\s*(\d{1,2})/);
  if (m) return { no: Number(m[1]), of: Number(m[2]) };
  if (/全退|取消|退回/.test(t)) return { cancelled: true };
  const n = t.match(/分期\D*(\d{1,2})\s*期/);
  return n ? { no: Number(n[1]) } : { no: null };
}

/** "[好市多內湖店](https://…)" left behind when a bank page is copied → "好市多內湖店". */
export const cleanCell = (v) => String(v || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

// A line that starts a card's section in a combined statement, e.g. "MASTER商務正卡末４碼9999".
const CARD_SECTION = /^(.*?)\s*(?:卡號)?末\s*[4４四]\s*碼\s*[:：]?\s*([0-9０-９]{4})/;
// Paying the bill is not spending (the spending was recorded when the card was used).
const PAYMENT = /自動扣繳|扣繳|繳款|已繳|轉帳繳|感謝您|payment|thank you/i;

/** Header row of the transaction table (bank exports often start with account/summary blocks). */
export function findHeaderRow(rows) {
  const i = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 3 && r.some((c) => /消費日|交易日|消費日期|交易日期|date/i.test(c)));
  return i >= 0 ? i : Math.max(0, rows.findIndex((r) => r.length >= 3));
}

/** Guess date / description / amount / card-number columns from a header row. */
export function guessCardColumns(head, width = head.length) {
  // patterns in priority order; the first pattern any header matches wins
  const find = (pats, fb) => {
    for (const re of pats) {
      const i = head.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return fb;
  };
  return {
    date: find([/消費日/, /交易日/, /日期/, /date/i], 0),
    desc: find([/消費說明|交易說明/, /說明|摘要/, /商店|特店|名稱/, /description|merchant/i], 1),
    amount: find([/臺幣金額|台幣金額/, /新臺幣|新台幣/, /^(?!.*外幣).*金額/, /amount/i], width - 1),
    card: find([/卡號|末四碼|末4碼/, /卡別/, /card/i], -1),
    post: find([/入帳日/, /請款日/, /post/i], -1),
  };
}

/**
 * Statement facts printed above the table: each label row is followed by a value row in the
 * same columns ("帳單結帳日" → "115/11/14"). Returns what it can find.
 */
export function statementMeta(rows) {
  const meta = {};
  for (let i = 0; i + 1 < rows.length; i++) {
    const head = rows[i];
    const vals = rows[i + 1];
    head.forEach((h, j) => {
      const v = vals[j];
      if (!h || v === undefined || v === '') return;
      if (/帳單年月|帳單月份/.test(h)) {
        const m = toHalf(v).match(/^(\d{2,4})[/-](\d{1,2})$/);
        if (m) meta.period = `${Number(m[1]) < 1000 ? Number(m[1]) + 1911 : m[1]}-${m[2].padStart(2, '0')}`;
      } else if (/^信用額度|^總額度|^循環額度/.test(h) && Number.isFinite(num(v, NaN))) meta.limit = num(v);
      else if (/結帳日/.test(h) && parseDate(v)) meta.closingDate = parseDate(v);
      else if (/繳款截止日|繳款期限|最後繳款日/.test(h) && parseDate(v)) meta.dueDate = parseDate(v);
      else if (/本期應繳總額|本期應繳金額|應繳總金額/.test(h) && Number.isFinite(num(v, NaN))) meta.total = num(v);
      else if (/最低應繳/.test(h) && Number.isFinite(num(v, NaN))) meta.minimum = num(v);
      else if (/前期應繳總額/.test(h) && Number.isFinite(num(v, NaN))) meta.previousTotal = num(v);
    });
  }
  if (!meta.period && meta.closingDate) meta.period = meta.closingDate.slice(0, 7);
  return meta;
}

/**
 * Turn rows of a bank's combined statement into card transactions.
 * mapping: { date, desc, amount, debit?, credit?, card?, skipHeader, yearHint }  (column indexes)
 * target:  { issuerId, cards: [{ id, last4 }], defaultCardId }
 * A row's card comes from its card-number column, else from the card section it sits in
 * ("…末４碼9999" lines); rows for unknown cards keep cardLast4 / cardLabel so the caller can
 * create the card. Payment rows (自動扣繳…) are skipped. (A plain card id string as target is
 * still accepted: everything goes to that card.)
 */
export function cardRowsToTransactions(rows, mapping, target) {
  const t0 = typeof target === 'string' ? { cardId: target } : target || {};
  const byLast4 = new Map((t0.cards || []).filter((c) => c.last4).map((c) => [String(c.last4), c.id]));
  const hasCardCol = mapping.card !== undefined && mapping.card !== null && mapping.card !== '' && mapping.card >= 0;
  const out = [];
  let section = null; // { last4, label } of the card section we are in
  const body = mapping.skipHeader === false ? rows : rows.slice(1);
  for (const r of body) {
    const date = parseDate(toHalf(r[mapping.date]), mapping.yearHint);
    if (!date) {
      const line = cleanCell(r.filter(Boolean).join(' '));
      const m = line.match(CARD_SECTION);
      if (m) section = { last4: toHalf(m[2]), label: cleanCell(m[1]).replace(/[\s:：-]+$/, '') };
      continue;
    }
    let amount;
    if (mapping.amount !== undefined && mapping.amount !== null && mapping.amount !== '') amount = num(r[mapping.amount], NaN);
    else amount = num(r[mapping.debit], 0) - num(r[mapping.credit], 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const merchant = cleanMerchant(r[mapping.desc]);
    if (amount < 0 && PAYMENT.test(merchant)) continue;
    const inst = installmentOf(merchant);
    const refund = amount < 0 || REFUND.test(merchant);
    const last4 = (hasCardCol ? last4Of(r[mapping.card]) : null) || section?.last4 || null;
    const label = hasCardCol && last4Of(r[mapping.card]) ? '' : section?.label || '';
    const matched = last4 ? byLast4.get(last4) : undefined;
    const cardId = t0.cardId || matched || (last4 ? undefined : t0.defaultCardId) || undefined;
    const tx = {
      date, amount: round2(Math.abs(amount)), type: refund ? 'income' : 'expense',
      category: refund ? '退款' : guessCategory(merchant), source: 'card', merchant, paymentMethod: 'card',
    };
    if (cardId) tx.cardId = cardId;
    if (t0.issuerId) tx.issuerId = t0.issuerId;
    if (last4) tx.cardLast4 = last4;
    const post = mapping.post !== undefined && mapping.post >= 0 ? parseDate(toHalf(r[mapping.post]), mapping.yearHint) : null;
    if (post && post !== date) tx.postDate = post;
    if (inst) {
      tx.installment = inst;
      tx.category = '分期';
    }
    if (last4 && !matched && !t0.cardId) {
      tx._unmatchedLast4 = last4;
      if (label) tx._cardLabel = label;
    }
    out.push(tx);
  }
  return out;
}

// ---------- statements printed as aligned text (PDF exports, text copied out of a PDF) ----------

const DATE_TOKEN = /^(\d{4}|\d{2,3})[/.-]\d{1,2}[/.-]\d{1,2}$/;
const TIME_TOKEN = /^\d{1,2}:\d{2}(:\d{2})?$/;
const AMOUNT_TOKEN = /^-?[\d,]+(\.\d+)?$/;
const FLAG_TOKEN = /^(正卡|附卡|是|否|成功|失敗|TW|US|JP|[A-Z]{2}|TWD|USD|JPY)$/;
// "連支＊", "連加＊" (LINE Pay), "街口＊", "A- ", "MA- " prefixes some banks put before the store
const PAY_PREFIX = /^(?:(?:連支|連加|街口|全支付|悠遊付|一卡通)[＊*]\s*|M?A-\s*)/;

/**
 * Parse a statement laid out as aligned text: every line with a date and an amount is one
 * transaction; card = a 4-digit token; store = the words before the amount. Store names that
 * wrap onto the line above / below (a centred cell) are joined back. Lines marked 失敗/拒絕
 * are skipped. Returns { rows: [{ date, last4, desc, amount }], pending }.
 */
export function parseLayoutStatement(text, yearHint) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const pending = /尚未請款|未請款|授權日期|授權金額/.test(text);
  const tx = [];
  const orphans = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\u3000/g, ' ').trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    const dateIdx = tokens.findIndex((t) => DATE_TOKEN.test(t) && parseDate(t, yearHint));
    if (dateIdx < 0) {
      // possible wrapped store name: short, no digits-only tokens, not a page number / heading
      if (!/^\d+\/\d+$/.test(line) && !/消費|明細|交易日期|授權日期|卡友|感謝|幣別|累計|筆數/.test(line) && line.length <= 30) orphans.push({ i, text: line, indent: raw.search(/\S/) });
      return;
    }
    if (/失敗|拒絕|取消授權/.test(line)) return;
    let last4 = null;
    let amountIdx = -1;
    let descStart = dateIdx + 1;
    tokens.forEach((t, j) => {
      if (j === dateIdx) return;
      if (!last4 && /^\d{4}$/.test(t) && j < tokens.length - 1) { last4 = t; descStart = Math.max(descStart, j + 1); return; }
      if (DATE_TOKEN.test(t) || TIME_TOKEN.test(t) || (FLAG_TOKEN.test(t) && j < tokens.length - 1 && j <= dateIdx + 3)) {
        if (j > dateIdx) descStart = Math.max(descStart, j + 1);
        return;
      }
      if (AMOUNT_TOKEN.test(t) && j > dateIdx) amountIdx = j;
    });
    if (amountIdx < 0) return;
    // an amount right after the description is the TWD amount; later numbers belong to other columns
    const firstAmount = tokens.findIndex((t, j) => j >= descStart && AMOUNT_TOKEN.test(t));
    if (firstAmount >= 0) amountIdx = firstAmount;
    const desc = tokens.slice(descStart, amountIdx).join(' ');
    // a second date right after the first is the posting date (入帳日期)
    const postTok = tokens.slice(dateIdx + 1, dateIdx + 3).find((t) => DATE_TOKEN.test(t) && parseDate(t, yearHint));
    tx.push({ i, indent: raw.search(/\S/), date: parseDate(tokens[dateIdx], yearHint), postDate: postTok ? parseDate(postTok, yearHint) : null, last4, desc, amount: num(tokens[amountIdx]) });
  });
  // Re-attach wrapped store names. A wrapped cell is centred on its row, so a transaction with
  // wrapped text on both sides owns both pieces; otherwise the text joins the nearest line.
  const between = (a, b) => orphans.filter((o) => o.i > (a ? a.i : -1) && o.i < (b ? b.i : Infinity));
  tx.forEach((t, k) => {
    t.before = between(tx[k - 1], t).length > 0;
    t.after = between(t, tx[k + 1]).length > 0;
  });
  for (const o of orphans) {
    const k = tx.findIndex((t) => t.i > o.i);
    const next = k >= 0 ? tx[k] : null;
    const prev = k > 0 ? tx[k - 1] : k < 0 ? tx[tx.length - 1] : null;
    let owner;
    if (next && next.after && !(prev && prev.before)) owner = next;
    else if (prev && prev.before && !(next && next.after)) owner = prev;
    else owner = [prev, next].filter((t) => t && Math.abs(t.i - o.i) <= 2).sort((a, b) => Math.abs(a.i - o.i) - Math.abs(b.i - o.i))[0];
    if (!owner) continue;
    if (o.i < owner.i) owner.desc = o.text + owner.desc;
    else owner.desc = `${owner.desc} ${o.text}`;
  }
  return { rows: tx.map(({ date, postDate, last4, desc, amount }) => ({ date, postDate, last4, desc, amount })), pending };
}

/** Same output as cardRowsToTransactions, from parseLayoutStatement rows. */
export function layoutToTransactions(text, target = {}, yearHint) {
  const { rows, pending } = parseLayoutStatement(text, yearHint);
  const byLast4 = new Map((target.cards || []).filter((c) => c.last4).map((c) => [String(c.last4), c.id]));
  const out = [];
  for (const r of rows) {
    if (!r.amount) continue;
    const merchant = cleanMerchant(r.desc).replace(PAY_PREFIX, '');
    const inst = installmentOf(merchant);
    if (r.amount < 0 && PAYMENT.test(merchant)) continue;
    const refund = r.amount < 0 || REFUND.test(merchant);
    const matched = r.last4 ? byLast4.get(r.last4) : undefined;
    const tx = {
      date: r.date, amount: round2(Math.abs(r.amount)), type: refund ? 'income' : 'expense',
      category: refund ? '退款' : guessCategory(merchant), source: 'card', merchant, paymentMethod: 'card',
    };
    if (matched) tx.cardId = matched;
    else if (!r.last4 && target.defaultCardId) tx.cardId = target.defaultCardId;
    if (target.issuerId) tx.issuerId = target.issuerId;
    if (r.last4) tx.cardLast4 = r.last4;
    if (r.postDate && r.postDate !== r.date) tx.postDate = r.postDate;
    if (inst) {
      tx.installment = inst;
      tx.category = '分期';
    }
    if (r.last4 && !matched) tx._unmatchedLast4 = r.last4;
    if (pending) tx.pending = true;
    out.push(tx);
  }
  return { txs: out, pending };
}

/** True when text is not a delimited table (CSV / tab), i.e. needs the aligned-text parser. */
export function looksLikeLayoutText(text) {
  const rows = parseCsv(text);
  const h = findHeaderRow(rows);
  return !(rows[h] && rows[h].filter((c) => c.trim()).length >= 3 && rows[h].some((c) => /消費日|交易日|日期|date/i.test(c)));
}

/**
 * Give every transaction a card: unknown card numbers become new cards of the bank (named
 * after the statement's label, e.g. "MASTER商務正卡", else "末四碼 9999"), or go to
 * defaultCardId / stay on the bank when autoCreate is off. Mutates txs and the ledger.
 * Returns the cards created.
 */
export function assignCards(ledger, issuerId, txs, { autoCreate = true, defaultCardId } = {}) {
  const created = [];
  const cards = () => live(ledger.cards).filter((c) => c.issuerId === issuerId);
  const bank = live(ledger.issuers).find((i) => i.id === issuerId);
  for (const t of txs) {
    if (t.cardId) continue;
    if (t.cardLast4) {
      let card = cards().find((c) => String(c.last4) === String(t.cardLast4));
      if (!card && autoCreate) {
        card = upsert(ledger, 'cards', {
          name: t._cardLabel || `末四碼 ${t.cardLast4}`, statementLabel: t._cardLabel || '', last4: t.cardLast4,
          issuerId, bank: bank?.name || '', autoCreated: true,
        });
        created.push(card);
      }
      if (card) {
        t.cardId = card.id;
        continue;
      }
    }
    if (defaultCardId) t.cardId = defaultCardId;
  }
  return created;
}

/**
 * Create (or update) the bank's combined statement from the statement facts and attach the
 * imported charges to it; also record the bank's limit and closing / due days.
 */
export function applyStatementMeta(ledger, issuerId, meta, txIds = []) {
  if (!meta?.period || !meta.closingDate) return null;
  const existing = live(ledger.statements).find((s) => s.issuerId === issuerId && s.period === meta.period);
  const s = upsert(ledger, 'statements', {
    ...(existing ? { id: existing.id } : { paidAmount: 0 }),
    issuerId, period: meta.period, closingDate: meta.closingDate,
    ...(meta.dueDate ? { dueDate: meta.dueDate } : {}),
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    ...(meta.minimum !== undefined ? { minimum: meta.minimum } : {}),
  });
  for (const id of txIds) upsert(ledger, 'transactions', { id, statementId: s.id });
  const bank = live(ledger.issuers).find((i) => i.id === issuerId);
  if (bank) {
    const patch = {};
    if (meta.limit) patch.limit = meta.limit;
    if (!bank.statementDay) patch.statementDay = Number(meta.closingDate.slice(8));
    if (!bank.dueDay && meta.dueDate) patch.dueDay = Number(meta.dueDate.slice(8));
    if (Object.keys(patch).length) upsert(ledger, 'issuers', { id: issuerId, ...patch });
  }
  return s;
}

/** Shop part of an installment row: "網路家庭分期０１－１０" → "網路家庭". */
export const installmentShop = (merchant) => normalizeName(String(merchant || '').split('分期')[0]);

/**
 * Point installment rows at their plan (a loan of kind "installment"): same bank, same number
 * of installments, same shop, and the plan not complete. Mutates the transactions in place
 * (pass ledger transactions to link already-imported rows). Returns how many were linked.
 */
export function linkInstallments(ledger, txs) {
  const plans = live(ledger.loans).filter((l) => l.kind === 'installment');
  let n = 0;
  for (const t of txs) {
    const inst = t.installment;
    if (!inst || inst.cancelled || inst.loanId || t.type === 'income') continue;
    const bank = txBank(ledger, t);
    const shop = installmentShop(t.merchant);
    const plan = plans.find((l) => (!l.issuerId || l.issuerId === bank) && (!inst.of || !l.periods || Number(l.periods) === inst.of)
      && shop && (installmentShop(l.shop || l.name).includes(shop) || shop.includes(installmentShop(l.shop || l.name))));
    if (!plan) continue;
    t.installment = { ...inst, loanId: plan.id };
    if (t.id && ledger.transactions.some((x) => x.id === t.id)) upsert(ledger, 'transactions', { id: t.id, installment: t.installment });
    n++;
  }
  return n;
}

/**
 * Create a credit-card installment plan and link the installment rows already imported.
 * principal = full price (e.g. the e-invoice total), periods = number of installments.
 */
export function addInstallmentPlan(ledger, { name, shop, issuerId, cardId, principal, periods, purchaseDate, invoiceTxId }) {
  const per = Math.floor((Number(principal) || 0) / periods);
  const end = purchaseDate ? (() => {
    const [y, m] = purchaseDate.split('-').map(Number);
    const t = y * 12 + (m - 1) + Number(periods) - 1;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  })() : undefined;
  const bank = live(ledger.issuers).find((i) => i.id === issuerId);
  const loan = upsert(ledger, 'loans', {
    name: name || `${shop}分期`, kind: 'installment', shop, lender: bank ? `${bank.name}（信用卡分期）` : '信用卡分期',
    issuerId, cardId, principal: Number(principal), periods: Number(periods), monthlyPayment: per, rate: 0,
    startDate: purchaseDate, endDate: end, invoiceTxId, payments: [],
  });
  const linked = linkInstallments(ledger, live(ledger.transactions));
  return { loan, linked };
}

/**
 * Best guess for a plan behind an installment row: the e-invoice from the same shop around the
 * purchase date whose total is about installments × amount (within 2 %), else that product.
 */
export function suggestInstallmentPlan(ledger, t) {
  const of = t.installment?.of || 1;
  const shop = installmentShop(t.merchant);
  const estimate = round2(t.amount * of);
  const inv = live(ledger.transactions).filter((x) => x.source === 'invoice' && x.type !== 'income'
    && Math.abs(Date.parse(x.date) - Date.parse(t.date)) <= 5 * 86400000
    && Math.abs(x.amount - estimate) <= estimate * 0.02)
    .sort((a, b) => Math.abs(a.amount - estimate) - Math.abs(b.amount - estimate))[0];
  const item = inv?.items?.find((i) => i.amount > 0)?.name;
  return {
    shop: String(t.merchant || '').split('分期')[0].trim() || shop,
    name: `${String(t.merchant || '').split('分期')[0].trim()}分期${item ? `（${item.slice(0, 16)}）` : ''}`,
    issuerId: txBank(ledger, t), cardId: t.cardId, periods: of,
    principal: inv ? inv.amount : estimate, fromInvoice: !!inv, invoiceTxId: inv?.id,
    purchaseDate: inv?.date || t.date,
  };
}

/**
 * One call for a whole statement import: find or create the bank, create unknown cards,
 * add the charges (skipping duplicates), and optionally file them under the statement.
 */
export function importBankStatement(ledger, { bankId, bankName, txs, meta, autoCreate = true, defaultCardId, statementId, useMeta = true }) {
  const issuerId = bankId || ensureIssuer(ledger, bankName).id;
  const own = txs.map((t) => ({ ...t, issuerId }));
  const created = assignCards(ledger, issuerId, own, { autoCreate, defaultCardId });
  linkInstallments(ledger, own);
  const r = importCardTransactions(ledger, own, statementId);
  r.splitsAbsorbed = absorbSplitPlaceholders(ledger, r.ids);
  let statement = null;
  if (useMeta && meta?.closingDate && !statementId) statement = applyStatementMeta(ledger, issuerId, meta, r.ids);
  return { ...r, issuerId, created, statement };
}

export function importCardTransactions(ledger, txs, statementId) {
  // Multiset comparison: two identical coffees on the same day are both kept, but re-importing
  // the same file adds nothing.
  const existing = new Map(); // fingerprint -> records still available to match
  for (const t of live(ledger.transactions).filter((x) => x.source === 'card')) {
    const fp = fingerprint(t, ledger);
    if (!existing.has(fp)) existing.set(fp, []);
    existing.get(fp).push(t);
  }
  let added = 0;
  let skipped = 0;
  const ids = [];
  let confirmed = 0;
  let filled = 0;
  const pendingPool = live(ledger.transactions).filter((x) => x.source === 'card' && x.pending);
  const confirmedPool = live(ledger.transactions).filter((x) => x.source === 'card' && !x.pending && x.authorizedMerchant);
  for (const raw of txs) {
    const { _unmatchedLast4, _cardLabel, ...t } = raw;
    // A posted charge confirms an earlier authorisation (尚未請款) of the same card and amount
    // within a few days: update that record instead of adding the purchase twice.
    if (!t.pending) {
      const bank = txBank(ledger, t);
      const i = pendingPool.findIndex((p) => p.amount === t.amount && p.type === t.type
        && (p.cardId && t.cardId ? p.cardId === t.cardId : txBank(ledger, p) === bank)
        && Math.abs(Date.parse(p.date) - Date.parse(t.date)) <= 5 * 86400000);
      if (i >= 0) {
        const p = pendingPool.splice(i, 1)[0];
        const confirmedTx = upsert(ledger, 'transactions', { id: p.id, ...t, pending: false, authorizedMerchant: p.merchant, ...(statementId ? { statementId } : {}) });
        ids.push(confirmedTx.id);
        confirmed++;
        continue;
      }
    }
    // An authorisation that was already confirmed by its posted charge is not new either.
    if (t.pending) {
      const bank = txBank(ledger, t);
      const i = confirmedPool.findIndex((p) => p.authorizedMerchant === t.merchant && p.amount === t.amount
        && (p.cardId && t.cardId ? p.cardId === t.cardId : txBank(ledger, p) === bank)
        && Math.abs(Date.parse(p.date) - Date.parse(t.date)) <= 5 * 86400000);
      if (i >= 0) {
        confirmedPool.splice(i, 1);
        skipped++;
        continue;
      }
    }
    const fp = fingerprint(t, ledger);
    if (existing.get(fp)?.length) {
      const old = existing.get(fp).shift();
      // re-importing fills in what older imports did not record
      if (t.postDate && !old.postDate) {
        upsert(ledger, 'transactions', { id: old.id, postDate: t.postDate });
        filled++;
      }
      skipped++;
      continue;
    }
    ids.push(upsert(ledger, 'transactions', statementId ? { ...t, statementId } : t).id);
    added++;
  }
  return { added, skipped, confirmed, filled, ids };
}
