#!/usr/bin/env node
// Command-line access to the ledger for Claude Code or a terminal. Shares logic with the web app.
//
//   node tools/ledger.mjs summary [--month 2026-11]
//   node tools/ledger.mjs validate
//   node tools/ledger.mjs import-invoices <file.csv>
//   node tools/ledger.mjs import-card <檔案> --bank <銀行名稱|id> [--date N --desc N --amount N --cardcol N] [--default-card <卡>] [--statement id] [--no-auto-cards] [--no-meta]
//       檔案可以是 CSV、從網銀複製的帳單頁面（tab 分隔）、PDF 帳單／消費明細（需要 pdftotext），或從 PDF 複製的文字；
//       欄位、卡別段落、帳單資訊、尚未請款的授權都會自動判斷
//   node tools/ledger.mjs match [--apply] [--all] [--min 0.6] [--days 3]   (--min：只套用相符度不低於此值的配對)
//   node tools/ledger.mjs bank --bank <銀行> [--limit N] [--statement-day N] [--due-day N] [--note 文字]
//   node tools/ledger.mjs add-statement --bank <銀行> --period YYYY-MM --closing YYYY-MM-DD [--due YYYY-MM-DD] [--total N] [--minimum N] [--paid N --paid-date YYYY-MM-DD]
//   node tools/ledger.mjs add-installment [--shop 網路家庭] [--principal N] [--periods N] [--date YYYY-MM-DD] [--name 名稱]
//   node tools/ledger.mjs delete-invoices --from YYYY-MM-DD --to YYYY-MM-DD [--apply]   (預設只預覽)
//   node tools/ledger.mjs import-moneybook <資料夾或 CSV…> [--no-balances]
//       Moneybook 匯出的帳戶／交易明細／帳單／發票／發票明細 CSV（自動判斷種類，可只給其中幾個）
//   node tools/ledger.mjs bank-rule --match <明細文字> --type income|expense|skip [--category 類別] [--merchant 名稱] [--amount N] [--direction in|out] [--note 文字]
//       記住銀行帳戶明細要怎麼記（例：--match 合作金庫 --type income --category 薪資）；不加參數列出規則
//   node tools/ledger.mjs plan [--days 60] [--reserve-months 1] [--living N]
//       投資規劃：推算未來的收付款與餘額，算出現在與每月可投入的金額
//   node tools/ledger.mjs import-payslips [data/payslips/payslips.json]
//       依轉錄好的薪資明細表新增（或補上明細到既有的）薪資收入
//   node tools/ledger.mjs import-splits <CSV…> [--from YYYY-MM-DD] [--days 2]
//       匯入分帳 App 的帳期 CSV：對到帳本的付款就掛上分帳（只算自己的份），對方代付與找不到的另外記錄，還款沖銷欠款
//   node tools/ledger.mjs forecast [--months 12] [--scenario conservative|expected]
//       資金缺口預警：逐月現金流、何時開始不夠、最多缺多少，以及賣股票／借貸／其他方式的試算
//   node tools/ledger.mjs schedule [--days N | --year]   備款時程：哪天前要備多少錢、繳哪些款項（預設 60 天）
//   node tools/ledger.mjs list <collection>
//   node tools/ledger.mjs encrypt | decrypt        (passphrase from LEDGER_PASSPHRASE)
//
// Options: --file data/ledger.json  --prices data/prices.json
// 資料與程式分屬不同 repo 時，用環境變數 LEDGER_DIR 指向資料資料夾（預設 data；--file 優先）
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { emptyLedger, normalizeLedger, live, COLLECTIONS, symbolsOf, issuerKey, ensureIssuer, upsert } from '../app/js/core/model.js';
import { totals, monthSummary, issuerUsage, billStatus, statementIssuerId, loanBalance, isIncomeItem, isPayable, incomeStatus } from '../app/js/core/calc.js';
import { findMatches, applyLink, deleteInvoicesInRange } from '../app/js/core/match.js';
import { parseEInvoice, importInvoices, parseCsv, cardRowsToTransactions, findHeaderRow, guessCardColumns, statementMeta, importBankStatement, looksLikeLayoutText, layoutToTransactions, applyStatementMeta, suggestInstallmentPlan, addInstallmentPlan } from '../app/js/core/importers.js';
import { investmentPlan } from '../app/js/core/plan.js';
import { cashForecast } from '../app/js/core/forecast.js';
import { paymentSchedule, yearEnd } from '../app/js/core/schedule.js';
import { importPayslips } from '../app/js/core/payslip.js';
import { parseSplitCsv, importSplits } from '../app/js/core/split.js';
import { splitBalances } from '../app/js/core/calc.js';
import { moneybookKind, importMoneybook, addBankRule } from '../app/js/core/moneybook.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptJson, decryptJson, isEncrypted } from '../app/js/core/crypto.js';
import { ymd, ym, formatMoney } from '../app/js/core/util.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = [];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true;
    else flags[k] = argv[++i];
  } else positional.push(argv[i]);
}
const FILE = flags.file || `${(process.env.LEDGER_DIR || 'data').replace(/\/+$/, '')}/ledger.json`;
const PRICES = flags.prices || FILE.replace(/[^/]+$/, 'prices.json');
const pass = process.env.LEDGER_PASSPHRASE;

async function load() {
  if (!existsSync(FILE)) return { ledger: emptyLedger(), wasEncrypted: false };
  const raw = JSON.parse(await readFile(FILE, 'utf8'));
  if (isEncrypted(raw)) {
    if (!pass) throw new Error('帳本已加密：請設定環境變數 LEDGER_PASSPHRASE');
    return { ledger: normalizeLedger(await decryptJson(raw, pass)), wasEncrypted: true };
  }
  return { ledger: normalizeLedger(raw), wasEncrypted: false };
}

async function save(ledger, encrypt) {
  ledger.updatedAt = new Date().toISOString();
  const out = encrypt ? await encryptJson(ledger, pass) : ledger;
  await writeFile(FILE, JSON.stringify(out, null, 1) + '\n');
  const symPath = FILE.replace(/[^/]+$/, 'symbols.json');
  await writeFile(symPath, JSON.stringify({ symbols: symbolsOf(ledger) }, null, 1) + '\n');
  console.log(`已寫入 ${FILE}${encrypt ? '（加密）' : ''}`);
}

/** Read a text file that may be UTF-8 or Big5 (older Taiwanese bank exports). */
async function readText(path) {
  const buf = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('big5').decode(buf);
  }
}

const findBank = (ledger, k) => live(ledger.issuers).find((i) => i.id === k || i.name === k || issuerKey(i.name) === issuerKey(String(k)));

function printMoneybookReport(r) {
  const out = [];
  for (const a of r.accounts) out.push(a.from === null ? `新增帳戶 ${a.name}：${formatMoney(a.to)}` : `帳戶 ${a.name}：${formatMoney(a.from)} → ${formatMoney(a.to)}`);
  for (const b of r.banks) out.push(`銀行 ${b.name}：${b.limit ? `額度 ${formatMoney(b.limit)} ` : ''}${b.overpaid !== undefined ? `溢繳 ${formatMoney(b.overpaid)}` : ''}`);
  for (const i of r.invoices.added) out.push(`新增發票 ${i.date} ${i.merchant} ${formatMoney(i.amount)}`);
  for (const i of r.invoices.fixed) out.push(`修正發票 ${i.date} ${i.merchant}：${formatMoney(i.from)} → ${formatMoney(i.to)}`);
  for (const i of r.invoices.voided) out.push(`未匯入（財政部資料中沒有，應已作廢）${i.date} ${i.merchant} ${formatMoney(i.amount)}`);
  for (const c of r.cards) out.push(`刷卡 ${c.name}：${c.rows} 筆，新增 ${c.added}${c.pending ? `（未請款 ${c.pending}）` : ''}，確認請款 ${c.confirmed}，已有 ${c.skipped}${c.newCards.length ? `，新卡 ${c.newCards.join('、')}` : ''}`);
  out.push(`信用卡帳單：新增 ${r.statements.added} 期，已有 ${r.statements.skipped} 期`);
  out.push(`銀行帳戶：新增 ${r.bank.added.length} 筆收支，自己帳戶間轉帳 ${r.bank.transfers}，不計收支 ${r.bank.skipped}，已匯入過 ${r.bank.existing}`);
  for (const t of r.bank.added) out.push(`  ${t.date} ${t.category.padEnd(4, '　')} ${t.merchant} ${formatMoney(t.amount)}`);
  if (r.bank.unknown.length) {
    out.push(`無法判斷的銀行明細 ${r.bank.unknown.length} 筆（用 bank-rule 設定規則後重新匯入）：`);
    for (const x of r.bank.unknown) out.push(`  ${x['消費日']} ${x['機構名稱']} ${x['明細描述']} ${formatMoney(Number(x['金額']))}`);
  }
  for (const u of r.usageDiff) out.push(`注意：${u.name} 已用額度 Moneybook ${formatMoney(u.moneybook)}，帳本 ${formatMoney(u.ledger)}`);
  console.log(out.join('\n'));
  console.log('接著可執行 match 合併刷卡與載具');
}

const prices = existsSync(PRICES) ? JSON.parse(await readFile(PRICES, 'utf8')) : { quotes: {}, fx: {} };
const fm = (n) => formatMoney(n).padStart(12);

try {
  const { ledger, wasEncrypted } = await load();
  switch (cmd) {
    case 'summary': {
      const t = totals(ledger, prices);
      const month = flags.month || ym(ymd());
      const ms = monthSummary(ledger, month);
      console.log(`淨值        ${fm(t.netWorth)}（扣除短期負債）\n含長期淨值  ${fm(t.netWorthAll)}\n資產        ${fm(t.assets)}\n  存款現金  ${fm(t.accounts)}\n  股票      ${fm(t.stocks)}（未實現 ${formatMoney(t.stockPnl)}）\n  其他資產  ${fm(t.otherAssets)}\n  應收      ${fm(t.receivables)}`);
      console.log(`短期負債    ${fm(t.shortTerm)}\n  卡費      ${fm(t.cards)}\n  短期貸款  ${fm(t.loansShort)}\n  應付      ${fm(t.payables)}\n長期負債    ${fm(t.longTerm)}\n  長期貸款  ${fm(t.loansLong)}`);
      console.log(`\n${month} 支出 ${formatMoney(ms.expense)}，收入 ${formatMoney(ms.income)}（已去除重複）`);
      for (const c of ms.byCategory) console.log(`  ${c.category.padEnd(6, '　')}${fm(c.amount)}`);
      for (const i of live(ledger.issuers)) {
        const u = issuerUsage(ledger, i.id);
        if (!u.cards.length) continue;
        const line = (u.limit ? `額度 ${formatMoney(u.limit)}，已用 ${formatMoney(u.used)}，可用 ${formatMoney(u.available)}（${Math.round(u.ratio * 100)}%）` : `已用 ${formatMoney(u.used)}（未設定額度）`)
          + `；合併帳單未繳 ${formatMoney(u.unpaidStatements)}，未出帳 ${formatMoney(u.unbilled)}${u.installmentHeld ? `，分期占用 ${formatMoney(u.installmentHeld)}` : ''}`;
        console.log(`銀行 ${i.name}：${line}`);
        for (const p of u.cards) console.log(`  卡 ${p.card.name}：在未繳帳單中 ${formatMoney(p.billed)}，未出帳 ${formatMoney(p.unbilled)}`);
      }
      for (const b of live(ledger.bills).filter(isIncomeItem)) {
        const s = incomeStatus(ledger, b);
        console.log(`收入 ${b.name}：${s.period} ${s.state === 'received' ? `已入帳 ${formatMoney(s.amount)}${s.change ? `（比上月 ${s.change > 0 ? '+' : ''}${formatMoney(s.change)}）` : ''}` : `尚未入帳，預計 ${s.dueDate} 約 ${formatMoney(b.amount)}`}`);
      }
      for (const b of live(ledger.bills).filter(isPayable)) {
        const s = billStatus(b);
        if (!s.paid) console.log(`待繳 ${b.name}：${s.period} 期 ${s.state === 'overdue' ? '已逾期' : s.state === 'due' ? '本期未繳' : '尚未到期'}，${s.dueDate} 前繳 ${formatMoney(b.amount)}`);
      }
      break;
    }
    case 'validate': {
      const problems = [];
      const ids = new Set();
      for (const c of COLLECTIONS) for (const r of ledger[c]) {
        if (!r.id) problems.push(`${c}: 有記錄缺少 id`);
        else if (ids.has(r.id)) problems.push(`${c}: 重複 id ${r.id}`);
        ids.add(r.id);
        if (!r.updatedAt) problems.push(`${c}/${r.id}: 缺少 updatedAt`);
      }
      for (const t of live(ledger.transactions)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) problems.push(`transactions/${t.id}: 日期格式錯誤 ${t.date}`);
        if (!(Number(t.amount) > 0)) problems.push(`transactions/${t.id}: 金額必須 > 0`);
        if (t.source === 'card' && !t.cardId && !t.issuerId) problems.push(`transactions/${t.id}: 刷卡交易缺少 cardId 或 issuerId`);
      }
      for (const c of live(ledger.cards)) {
        if (!c.issuerId) problems.push(`cards/${c.id}: 缺少發卡銀行（issuerId）`);
        else if (!live(ledger.issuers).some((i) => i.id === c.issuerId)) problems.push(`cards/${c.id}: issuerId 指向不存在的銀行`);
      }
      for (const st of live(ledger.statements)) {
        if (!statementIssuerId(ledger, st)) problems.push(`statements/${st.id}: 找不到所屬銀行（缺少 issuerId，或對應的卡沒有銀行）`);
      }
      for (const t of live(ledger.transactions)) {
        if (t.linkId && !live(ledger.links).some((l) => l.id === t.linkId)) problems.push(`transactions/${t.id}: linkId 指向不存在的配對`);
      }
      for (const l of live(ledger.links)) for (const id of [l.cardTxId, ...(l.otherTxIds || [])]) {
        const t = ledger.transactions.find((x) => x.id === id);
        if (!t || t.deleted) problems.push(`links/${l.id}: 交易 ${id} 不存在`);
        else if (t.linkId !== l.id) problems.push(`links/${l.id}: 交易 ${id} 的 linkId 不一致`);
      }
      console.log(problems.length ? problems.join('\n') : '帳本格式正確');
      if (problems.length) process.exitCode = 1;
      break;
    }
    case 'import-invoices': {
      const inv = parseEInvoice(await readText(positional[0]));
      const r = importInvoices(ledger, inv);
      console.log(`讀到 ${inv.length} 張發票：新增 ${r.added}，更新 ${r.updated}，略過 ${r.skipped}`);
      if (r.added || r.updated) await save(ledger, wasEncrypted);
      break;
    }
    case 'import-card': {
      // Taiwanese statements are per bank: rows go to the bank and to cards by last four digits
      // (card-number column or "…末４碼9999" section lines). Unknown cards are created.
      const cardKey = (c, k) => c.id === k || c.name === k || c.last4 === k;
      let bank;
      let bankName;
      if (flags.bank) {
        const k = String(flags.bank);
        bank = live(ledger.issuers).find((i) => i.id === k || i.name === k || issuerKey(i.name) === issuerKey(k));
        if (!bank) bankName = k; // created on import
      } else if (flags.card) { // older usage: --card picks the card's bank and is the default card
        const c = live(ledger.cards).find((x) => cardKey(x, String(flags.card)));
        if (!c) throw new Error(`找不到信用卡 ${flags.card}`);
        bank = live(ledger.issuers).find((i) => i.id === c.issuerId);
        if (!bank) throw new Error(`信用卡 ${c.name} 沒有發卡銀行，請先補上`);
        flags['default-card'] ??= c.id;
      } else throw new Error('請用 --bank 指定發卡銀行（不存在會自動建立）');
      const cards = bank ? live(ledger.cards).filter((c) => c.issuerId === bank.id) : [];
      const def = flags['default-card'] ? cards.find((c) => cardKey(c, String(flags['default-card']))) : undefined;
      if (flags['default-card'] && !def) throw new Error(`${bank?.name || bankName} 沒有卡片 ${flags['default-card']}`);
      // PDF statements: extract the text layout with pdftotext (poppler-utils)
      let text;
      if (/\.pdf$/i.test(positional[0])) {
        const { execFileSync } = await import('node:child_process');
        try {
          text = execFileSync('pdftotext', ['-layout', positional[0], '-'], { encoding: 'utf8' });
        } catch {
          throw new Error('讀取 PDF 需要 pdftotext（poppler-utils），請先安裝，或把 PDF 內容複製成文字檔');
        }
      } else text = await readText(positional[0]);
      const all = parseCsv(text);
      const h = flags['no-header'] ? 0 : findHeaderRow(all);
      const guess = guessCardColumns(all[h] || []);
      const col = (k, g) => (flags[k] !== undefined ? Number(flags[k]) : g);
      const mapping = {
        date: col('date', guess.date), desc: col('desc', guess.desc), amount: col('amount', guess.amount),
        card: col('cardcol', guess.card), post: col('postcol', guess.post), skipHeader: !flags['no-header'], yearHint: new Date().getFullYear(),
      };
      const meta = statementMeta(all);
      const target = { issuerId: bank?.id, cards: cards.map((c) => ({ id: c.id, last4: c.last4 })), defaultCardId: def?.id };
      const layout = flags.date === undefined && looksLikeLayoutText(text);
      const txs = layout ? layoutToTransactions(text, target).txs : cardRowsToTransactions(all.slice(h), mapping, target);
      if (layout) console.log(`文字排版明細${txs.some((t) => t.pending) ? '（尚未請款的授權，標記為未請款）' : ''}`);
      else console.log(`欄位：日期=${mapping.date} 說明=${mapping.desc} 金額=${mapping.amount} 卡號=${mapping.card}${Object.keys(meta).length ? `；帳單資訊：${JSON.stringify(meta)}` : ''}`);
      const r = importBankStatement(ledger, {
        bankId: bank?.id, bankName, txs, meta, autoCreate: !flags['no-auto-cards'], defaultCardId: def?.id,
        statementId: flags.statement, useMeta: !flags['no-meta'],
      });
      const bankNow = live(ledger.issuers).find((i) => i.id === r.issuerId);
      if (!bank) console.log(`已建立銀行：${bankNow.name}`);
      for (const c of r.created) console.log(`已建立卡片：${c.name}（末四碼 ${c.last4}）`);
      if (r.statement) console.log(`合併帳單：${r.statement.period}，應繳 ${formatMoney(r.statement.total)}，截止 ${r.statement.dueDate || '—'}`);
      console.log(`${bankNow.name}：解析 ${txs.length} 筆，新增 ${r.added}${r.confirmed ? `，未請款→已請款 ${r.confirmed}` : ''}，略過重複 ${r.skipped}${r.filled ? `（其中 ${r.filled} 筆補上入帳日）` : ''}`);
      if (r.added || r.confirmed || r.filled || r.created.length || r.statement || !bank) await save(ledger, wasEncrypted);
      break;
    }
    case 'match': {
      const r = findMatches(ledger, flags.days ? { dayWindow: Number(flags.days) } : {});
      const get = (id) => ledger.transactions.find((t) => t.id === id);
      const line = (t) => `${t.date} ${t.merchant} ${formatMoney(t.amount)}`;
      for (const [label, list] of [['自動', r.auto], ['建議', r.suggested]]) for (const p of list) {
        console.log(`[${label} ${Math.round(p.score * 100)}%] 刷卡 ${line(get(p.cardTxId))}  ⇔  ${p.otherTxIds.map((id) => line(get(id))).join(' + ')}`);
      }
      console.log(`只有刷卡 ${r.cardOnly.length} 筆，只有發票／手記 ${r.otherOnly.length} 筆`);
      if (flags.apply) {
        const min = flags.min !== undefined ? Number(flags.min) : 0;
        const list = (flags.all ? [...r.auto, ...r.suggested] : r.auto).filter((p) => p.score >= min);
        for (const p of list) applyLink(ledger, { ...p, method: flags.all ? 'manual' : 'auto' });
        console.log(`已合併 ${list.length} 組${flags.all ? '' : '（只套用高信心配對；加上 --all 一併套用建議）'}`);
        if (list.length) await save(ledger, wasEncrypted);
      }
      break;
    }
    case 'bank': {
      // create or update a bank: limit and closing / due days; without any setting it only shows the bank
      if (!flags.bank) throw new Error('請用 --bank 指定銀行');
      const patch = {};
      if (flags.limit !== undefined) patch.limit = Number(flags.limit);
      if (flags['statement-day'] !== undefined) patch.statementDay = Number(flags['statement-day']);
      if (flags['due-day'] !== undefined) patch.dueDay = Number(flags['due-day']);
      if (flags.note !== undefined) patch.note = String(flags.note);
      let b = findBank(ledger, flags.bank);
      let changed = false;
      if (!b) {
        if (!Object.keys(patch).length) throw new Error(`找不到銀行 ${flags.bank}（要新增請一併指定 --limit、--statement-day、--due-day 或 --note）`);
        b = ensureIssuer(ledger, String(flags.bank));
        changed = true;
      }
      if (Object.entries(patch).some(([k, v]) => b[k] !== v)) {
        upsert(ledger, 'issuers', { id: b.id, ...patch });
        changed = true;
      }
      const now = live(ledger.issuers).find((i) => i.id === b.id);
      console.log(`${now.name}：額度 ${now.limit ? formatMoney(now.limit) : '未設定'}，結帳日 ${now.statementDay ?? '—'}，繳款日 ${now.dueDay ?? '—'}`);
      // saving stamps the whole ledger as just edited, which matters when devices merge: only write on a real change
      if (changed) await save(ledger, wasEncrypted);
      break;
    }
    case 'add-statement': {
      // a bank's combined statement from figures shown on the bank's site
      const b = findBank(ledger, flags.bank || '');
      if (!b) throw new Error(`找不到銀行 ${flags.bank}`);
      if (!/^\d{4}-\d{2}$/.test(flags.period || '') || !/^\d{4}-\d{2}-\d{2}$/.test(flags.closing || '')) throw new Error('請指定 --period YYYY-MM 與 --closing YYYY-MM-DD');
      const st = applyStatementMeta(ledger, b.id, {
        period: flags.period, closingDate: flags.closing, dueDate: flags.due, total: flags.total !== undefined ? Number(flags.total) : undefined,
        minimum: flags.minimum !== undefined ? Number(flags.minimum) : undefined,
      });
      if (flags.paid !== undefined) upsert(ledger, 'statements', { id: st.id, paidAmount: Number(flags.paid), paidDate: flags['paid-date'] || flags.due || st.dueDate });
      const now = live(ledger.statements).find((x) => x.id === st.id);
      console.log(`${b.name} ${now.period} 合併帳單：應繳 ${formatMoney(now.total)}，截止 ${now.dueDate || '—'}，已繳 ${formatMoney(now.paidAmount || 0)}`);
      await save(ledger, wasEncrypted);
      break;
    }
    case 'add-installment': {
      // a credit-card installment plan; with no --principal it is guessed from the e-invoice
      const rows = live(ledger.transactions).filter((t) => t.source === 'card' && t.installment && !t.installment.cancelled && !t.installment.loanId && t.type !== 'income'
        && (!flags.shop || String(t.merchant).includes(String(flags.shop))));
      if (!rows.length) throw new Error('找不到還沒有分期帳務的分期款（可用 --shop 指定商店）');
      const g = suggestInstallmentPlan(ledger, rows[0]);
      const plan = {
        ...g, ...(flags.name ? { name: String(flags.name) } : {}),
        ...(flags.principal !== undefined ? { principal: Number(flags.principal) } : {}),
        ...(flags.periods !== undefined ? { periods: Number(flags.periods) } : {}),
        ...(flags.date ? { purchaseDate: String(flags.date) } : {}),
      };
      const r = addInstallmentPlan(ledger, plan);
      const L = live(ledger.loans).find((x) => x.id === r.loan.id);
      console.log(`已建立分期帳務「${L.name}」：總額 ${formatMoney(L.principal)}（${g.fromInvoice && flags.principal === undefined ? '取自發票' : '指定或估算'}），${L.periods} 期，已對應 ${r.linked} 期，尚未出帳 ${formatMoney(loanBalance(ledger, L))}`);
      await save(ledger, wasEncrypted);
      break;
    }
    case 'delete-invoices': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(flags.to || '')) throw new Error('請用 --from 與 --to 指定日期（YYYY-MM-DD）');
      const r = deleteInvoicesInRange(ledger, flags.from, flags.to, { dryRun: !flags.apply });
      console.log(`${flags.from} ~ ${flags.to}：${r.count} 張發票，合計 ${formatMoney(r.total)}，其中 ${r.linked} 張已和刷卡合併`);
      if (!flags.apply) console.log('（只是預覽；加上 --apply 才會刪除）');
      else if (r.count) await save(ledger, wasEncrypted);
      break;
    }
    case 'import-moneybook': {
      const paths = [];
      for (const p of positional) {
        if ((await stat(p)).isDirectory()) for (const f of (await readdir(p)).sort()) { if (/\.csv$/i.test(f)) paths.push(join(p, f)); }
        else paths.push(p);
      }
      const files = {};
      for (const p of paths) {
        const text = await readText(p);
        const kind = moneybookKind(text);
        if (!kind) console.log(`略過 ${p}：看不出是哪一種 Moneybook 匯出檔`);
        else files[kind] = text;
      }
      if (!Object.keys(files).length) throw new Error('沒有可匯入的 Moneybook 檔案');
      console.log(`讀到：${Object.keys(files).join('、')}`);
      const r = importMoneybook(ledger, files, { balances: !flags['no-balances'] });
      printMoneybookReport(r);
      await save(ledger, wasEncrypted);
      break;
    }
    case 'bank-rule': {
      if (!flags.match) {
        for (const x of ledger.settings.bankRules || []) console.log(JSON.stringify(x));
        break;
      }
      if (!['income', 'expense', 'skip'].includes(flags.type)) throw new Error('--type 必須是 income、expense 或 skip');
      const rule = { match: String(flags.match), type: flags.type };
      for (const k of ['category', 'merchant', 'note', 'direction']) if (flags[k]) rule[k] = String(flags[k]);
      if (flags.amount) rule.amount = Number(flags.amount);
      addBankRule(ledger, rule);
      console.log('已加入規則：', JSON.stringify(rule));
      await save(ledger, wasEncrypted);
      break;
    }
    case 'plan': {
      const opt = {};
      if (flags.days) opt.horizonDays = Number(flags.days);
      if (flags['reserve-months'] !== undefined) opt.reserveMonths = Number(flags['reserve-months']);
      if (flags.living) opt.livingMonthly = Number(flags.living);
      const r = investmentPlan(ledger, prices, ymd(), opt);
      const word = { invest: `現在可以投入 ${formatMoney(r.investNow)}`, hold: `目前不建議投入（距安全存量還差 ${formatMoney(r.shortfall)}）`, short: '未來有資金缺口，先不要投入' }[r.verdict];
      console.log(`${word}\n可動用存款 ${fm(r.cash.total)}\n預估最低餘額 ${fm(r.low.balance)}（${r.low.date}）\n安全存量 ${fm(r.reserve)}（${r.options.reserveMonths} 個月支出）\n每月：固定收入 ${formatMoney(r.monthlyIncome)}，固定支出 ${formatMoney(r.monthlyFixed)}，日常支出 ${formatMoney(r.living.used)}，結餘 ${formatMoney(r.monthlySurplus)}`);
      console.log(`\n未來 ${r.options.horizonDays} 天已知收付款：`);
      let bal = r.cash.total;
      for (const f of r.flows) { bal += f.amount; console.log(`  ${f.date} ${formatMoney(f.amount).padStart(9)}  ${f.label}`); }
      for (const a of r.allocation) console.log(`  依持股比例：${a.name} ${(a.weight * 100).toFixed(1)}% ${formatMoney(a.amount)}`);
      break;
    }
    case 'import-payslips': {
      const doc = JSON.parse(await readFile(positional[0] || FILE.replace(/[^/]+$/, 'payslips/payslips.json'), 'utf8'));
      const r = importPayslips(ledger, doc);
      console.log(`薪資單 ${doc.slips.length} 份：新增 ${r.added}，補上明細到銀行入帳 ${r.attached}，更新 ${r.updated}；獎金新增 ${r.bonuses}`);
      for (const d of r.differences) console.log(`  差異 ${d}`);
      for (const e of r.errors) console.log(`  ⚠ ${e}`);
      if (r.added || r.attached || r.updated || r.bonuses) await save(ledger, wasEncrypted);
      break;
    }
    case 'import-splits': {
      const files = [];
      for (const p of positional) files.push(parseSplitCsv(await readText(p)));
      files.sort((a, b) => (a.entries[a.entries.length - 1]?.date || '').localeCompare(b.entries[b.entries.length - 1]?.date || ''));
      const r = importSplits(ledger, files, { from: flags.from || '', days: flags.days ? Number(flags.days) : 2 });
      console.log(`帳期：${files.map((f) => f.group).join('、')}`);
      console.log(`對到帳本 ${r.matched.length}，有多個候選（已挑最接近的，請確認）${r.guessed.length}，暫記 ${r.placeholders.length}，對方代付 ${r.theyPaid.length}，還款 ${r.settlements.length}，更新 ${r.updated}${r.skippedBefore ? `，${flags.from} 之前略過 ${r.skippedBefore}` : ''}`);
      for (const g of r.guessed) console.log(`  確認：${g.date} ${g.name} ${formatMoney(g.amount)} → ${g.to}（另有 ${g.others} 個候選）`);
      for (const m of r.missing) console.log(`  App 已刪除？${m.date} ${m.name}`);
      for (const b of splitBalances(ledger)) console.log(`${b.with}：${b.balance > 0 ? `欠你 ${formatMoney(b.balance)}` : b.balance < 0 ? `你欠 ${formatMoney(-b.balance)}` : '已結清'}`);
      if (!flags['dry-run']) await save(ledger, wasEncrypted);
      break;
    }
    case 'forecast': {
      const f = cashForecast(ledger, prices, ymd(), { scenario: flags.scenario || 'conservative', ...(flags.months ? { months: Number(flags.months) } : {}) });
      console.log(`情境：${f.scenario === 'expected' ? '預期（含預估獎金與預計收支）' : '保守（只算薪資與確定的收支）'}，推算到 ${f.until}`);
      if (f.need) {
        const n = f.need;
        console.log(`${n.start} 起存款不足，最多缺 ${formatMoney(n.amount)}（${n.lowDate}），${n.end ? `${n.end} 補回` : '期末仍未補回'}；每月平均 ${formatMoney(f.trend)}`);
        for (const c of n.causes) console.log(`  大筆付款 ${c.date} ${c.label} ${formatMoney(c.amount)}`);
        for (const s of f.remedies.sell) console.log(`  賣 ${s.name} ${s.shares} 股，約得 ${formatMoney(s.proceeds)}，成本 ${formatMoney(s.cost)}，最晚 ${s.sellBy}`);
        for (const b of f.remedies.borrow) console.log(`  ${b.name}（${b.rate}%）利息約 ${formatMoney(b.cost)}`);
        if (f.remedies.owed) console.log(`  可收回別人欠的 ${formatMoney(f.remedies.owed)}`);
      } else console.log(`不會出現資金缺口；最低點 ${f.low.date} ${formatMoney(f.low.balance)}`);
      console.log('\n月份      月初      收入   固定與卡費   日常支出      月底    當月最低');
      for (const m of f.months) console.log(`${m.month} ${fm(m.opening)} ${fm(m.income)} ${fm(-m.out)} ${fm(-m.living)} ${fm(m.closing)} ${fm(m.low)}`);
      break;
    }
    case 'schedule': {
      const today = ymd();
      const s = paymentSchedule(ledger, prices, today, flags.year ? { until: yearEnd(today) } : { horizonDays: Number(flags.days) || 60 });
      console.log(`備款時程 ${s.today} ～ ${s.until}｜可動用存款 ${formatMoney(s.cash.total)}｜期間繳款 ${formatMoney(s.outflowTotal)}、入帳 ${formatMoney(s.inflowTotal)}`);
      if (s.first) {
        const e = s.first;
        console.log(`⚠ ${e.start} 前要備齊：缺口最多 ${formatMoney(e.amount)}（${e.lowDate}），${e.end ? `${e.end} 入帳後補回` : '期間內未補回'}`);
        if (s.episodes.length > 1) console.log(`  期間內共 ${s.episodes.length} 段缺口，累計要再備 ${formatMoney(s.totalNeed)}`);
      } else console.log(`✓ 期間內不需要補錢；最低餘額 ${formatMoney(s.low.balance)}（${s.low.date}）`);
      console.log('\n日期     項目                                      金額      繳完餘額    要再備');
      for (const r of s.rows) {
        r.items.forEach((i, k) => {
          const tag = [i.estimated ? '估計' : '', i.dateGuess ? '日期估' : '', i.shifted ? `原 ${i.dueDate.slice(5)}` : '', i.overdue ? `已逾期 ${i.overdue.slice(5)}` : ''].filter(Boolean).join('、');
          const last = k === r.items.length - 1;
          console.log(`${k ? '        ' : r.date.slice(5).padEnd(8)}${(i.label.slice(0, 26) + (tag ? `（${tag}）` : '')).padEnd(40)}${fm(i.amount)}${last ? fm(r.balance) : ''.padStart(12)}${last && r.raise ? fm(r.raise) : ''}`);
        });
      }
      if (s.warnings.guessed.length) console.log(`\n注意：${s.warnings.guessed.join('、')} 沒設結帳日或繳款日，日期是估的（用 bank --bank <銀行> --statement-day N --due-day N 設定）`);
      for (const a of s.warnings.staleAccounts) console.log(`注意：${a.name} 的餘額是 ${a.balanceDate} 的，可能已過期`);
      break;
    }
    case 'list': {
      const c = positional[0];
      if (!COLLECTIONS.includes(c)) throw new Error(`collection 必須是：${COLLECTIONS.join(', ')}`);
      console.log(JSON.stringify(live(ledger[c]), null, 1));
      break;
    }
    case 'encrypt':
    case 'decrypt': {
      if (cmd === 'encrypt' && !pass) throw new Error('請設定 LEDGER_PASSPHRASE');
      await save(ledger, cmd === 'encrypt');
      break;
    }
    default:
      console.log(await readFile(new URL(import.meta.url), 'utf8').then((s) => s.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')));
  }
} catch (e) {
  console.error(`錯誤：${e.message}`);
  process.exitCode = 1;
}
