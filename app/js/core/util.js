// Pure helpers shared by the browser app, the CLI and the tests.

export function uid(prefix = '') {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}

export const nowIso = () => new Date().toISOString();

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s$NT元]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/** Local-date string YYYY-MM-DD for a Date. */
export function ymd(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const ym = (dateStr) => String(dateStr || '').slice(0, 7);

/**
 * Parse the date formats seen in Taiwanese bank / e-invoice exports into YYYY-MM-DD.
 * 2026/11/03, 2026-11-3, 20261103, 115/11/03 (ROC year), 1151103 (ROC compact), 11/03 (needs year hint)
 */
export function parseDate(input, yearHint) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[年月.]/g, '/').replace(/日/g, '');
  if (!s) return null;
  s = s.split(/[ T]/)[0];
  let y, m, d;
  let mt;
  if ((mt = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{3})(\d{2})(\d{2})$/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{2,4})[/-](\d{1,2})[/-](\d{1,2})$/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{1,2})[/-](\d{1,2})$/)) && yearHint) {
    [, m, d] = mt;
    y = yearHint;
  } else return null;
  y = Number(y);
  if (y < 1000) y += 1911; // ROC calendar
  m = Number(m);
  d = Number(d);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysBetween(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  return Math.round((tb - ta) / 86400000);
}

export function addMonths(ymStr, n) {
  const [y, m] = ymStr.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

const NOISE = [
  '股份有限公司', '有限公司', '公司', '分公司', '門市', '分店', '店', '台灣', '臺灣',
  'co', 'ltd', 'inc', 'corp', 'taiwan', 'tw',
];

/** Normalise merchant names: full-width → half-width, lower case, drop punctuation and noise words. */
export function normalizeName(s) {
  let t = String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .toLowerCase();
  t = t.replace(/[\s\-_.,*#()（）\[\]【】/\\'"’`:：|＊]+/g, '');
  for (const w of NOISE) t = t.split(w).join('');
  return t;
}

function bigrams(s) {
  const out = new Map();
  if (s.length === 1) out.set(s, 1);
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// The company on an e-invoice is often not the brand on the card statement.
const BRANDS = [
  ['mcdonalds', /和德昌|麥當勞|mcdonald/i], ['mos', /安心食品|摩斯|mos ?burger/i], ['7-eleven', /統一超商|7-?eleven|7-11/i],
  ['familymart', /全家/], ['coupang', /酷澎|coupang/i], ['foodpanda', /富胖達|foodpanda/i], ['ubereats', /優食|uber ?eats/i],
  ['apple', /apple/i], ['google', /google/i], ['pxmart', /全聯/], ['costco', /好市多|costco/i], ['ikea', /宜家|ikea/i],
  ['cpc', /台灣中油|中油/], ['worldgym', /京庚健康世界|world ?gym/i], ['taobao', /淘寶|taobao/i], ['shopee', /蝦皮|shopee/i], ['pchome', /網路家庭|pchome/i],
];
export function brandOf(s) {
  const t = String(s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return BRANDS.find(([, re]) => re.test(t))?.[0] || null;
}

/** Dice coefficient on character bigrams of normalised names, 0..1 (same brand counts as a match). */
export function nameSimilarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ba = brandOf(a);
  if (ba && ba === brandOf(b)) return 0.95;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  let total = 0;
  for (const [, c] of A) total += c;
  for (const [, c] of B) total += c;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) || 0);
  const dice = total ? (2 * inter) / total : 0;
  // Brand names usually lead ("全聯實業" vs "全聯福利中心"): a shared 2+ char prefix is a strong hint.
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  const prefix = p >= 2 ? Math.min(0.8, 0.5 + 0.1 * p) : 0;
  return Math.max(dice, prefix);
}

export function formatMoney(n, { currency = 'TWD', digits } = {}) {
  const v = Number(n) || 0;
  const d = digits ?? (currency === 'TWD' ? 0 : 2);
  const s = Math.abs(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = v < 0 ? '−' : '';
  return currency === 'TWD' ? `${sign}${s}` : `${sign}${currency} ${s}`;
}

export const sum = (arr, f = (x) => x) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
