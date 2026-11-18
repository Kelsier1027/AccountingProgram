import { store } from '../store.js';
import { live, upsert, remove, LABELS, issuerKey } from '../core/model.js';
import { unlink, deleteInvoicesInRange } from '../core/match.js';
import { parseEInvoice, importInvoices, parseCsv, cardRowsToTransactions, findHeaderRow, guessCardColumns, statementMeta, importBankStatement, looksLikeLayoutText, layoutToTransactions } from '../core/importers.js';
import { ymd, ym, addMonths, sum, round2, formatMoney } from '../core/util.js';
import { statementsOfIssuer, notSpending, cardLabel, countedAmount } from '../core/calc.js';
import { esc, money, formDialog, customDialog, confirmDialog, toast, readFileText, emptyState, $ } from '../ui.js';
import { txFields, cardOptions } from './common.js';
import { importMoneybookDialog } from './moneybook.js';

const state = { month: ym(ymd()), source: 'all', q: '' };

export function renderTransactions(root) {
  const L = store.ledger;
  const links = new Map(live(L.links).map((l) => [l.id, l]));
  let txs = live(L.transactions).filter((t) => ym(t.date) === state.month);
  if (state.source !== 'all') txs = txs.filter((t) => t.source === state.source);
  if (state.q) {
    const q = state.q.toLowerCase();
    txs = txs.filter((t) => [t.merchant, t.category, t.note, t.invoiceNo, ...(t.items || []).map((i) => i.name)].join(' ').toLowerCase().includes(q));
  }
  txs.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  // same rule as the overview: merged invoices and installment repayments are not spending
  const counted = txs.filter((t) => !(t.linkId && t.source !== 'card') && !notSpending(t));
  // a shared expense counts only my share (the card charge it sits on, or a merged invoice)
  const splitOf = (t) => t.split || (t.linkId && links.get(t.linkId)?.cardTxId === t.id ? (links.get(t.linkId).otherTxIds || []).map((id) => L.transactions.find((x) => x.id === id)?.split).find(Boolean) : null);
  const exp = sum(counted.filter((t) => t.type !== 'income'), (t) => countedAmount(t, splitOf(t)));
  const inc = sum(counted.filter((t) => t.type === 'income'), (t) => t.amount);
  const bankName = (id) => L.issuers.find((i) => i.id === id)?.name || '';

  const groups = new Map();
  for (const t of txs) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }

  root.innerHTML = `
  <div class="toolbar">
    <div class="month-nav">
      <button class="btn ghost sm" data-m="-1" aria-label="上個月">‹</button>
      <input type="month" id="tx-month" value="${state.month}" aria-label="月份">
      <button class="btn ghost sm" data-m="1" aria-label="下個月">›</button>
    </div>
    <input type="search" id="tx-q" placeholder="搜尋商家、品項、備註" value="${esc(state.q)}">
    <select id="tx-src" aria-label="來源">
      <option value="all">全部來源</option>
      ${Object.entries(LABELS.source).map(([k, v]) => `<option value="${k}" ${state.source === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select>
  </div>
  <div class="toolbar">
    <button class="btn primary" id="tx-add">新增一筆</button>
    <button class="btn ghost" id="tx-imp-inv">匯入載具 CSV</button>
    <button class="btn ghost" id="tx-imp-card">匯入信用卡帳單</button>
    <button class="btn ghost" id="tx-imp-mb">匯入 Moneybook</button>
    <button class="btn danger" id="tx-del-inv">刪除載具資料</button>
  </div>
  <div class="kv">
    <div><span>本頁支出</span>${money(exp)}</div>
    <div><span>本頁收入</span>${money(inc)}</div>
    <div><span>筆數</span><span class="num">${txs.length}</span></div>
  </div>
  ${txs.length ? [...groups.entries()].map(([date, list]) => `
    <h3 class="date-head num">${esc(date.replaceAll('-', '/'))}</h3>
    <ul class="rows">${list.map((t) => {
      const merged = t.linkId && t.source !== 'card';
      const link = t.linkId ? links.get(t.linkId) : null;
      return `<li class="row ${merged ? 'merged' : ''}" data-id="${t.id}" tabindex="0">
        <div class="row-main">
          <span class="row-title">${esc(t.merchant || t.category || '（未命名）')}</span>
          <span class="row-sub">
            <span class="tag src-${t.source}">${esc(LABELS.source[t.source] || t.source)}</span>
            ${esc(t.category || '')}${t.source === 'card' ? ` · <span class="card-ref">${esc(cardLabel(L, t))}</span>` : ''}
            ${(() => {
              const s = splitOf(t);
              if (!s) return '';
              if (s.settle) return `<span class="tag" title="分帳還款：沖銷欠款，不算收入或支出">分帳還款</span>`;
              const owe = round2((Number(s.paid) || 0) - (Number(s.mine) || 0));
              return `<span class="tag split" title="和 ${esc(s.with)} 分帳${s.label ? `（${esc(s.label)}）` : ''}：你付 ${formatMoney(s.paid)}，你的份 ${formatMoney(s.mine)}${owe ? `，${owe > 0 ? `${esc(s.with)} 欠你 ${formatMoney(owe)}` : `你欠 ${esc(s.with)} ${formatMoney(-owe)}`}` : ''}">分帳 · 你的份 ${money(s.mine)}</span>${t.splitPlaceholder ? '<span class="tag warn" title="帳本找不到這筆付款，之後匯入的刷卡或發票會自動接手">分帳暫記</span>' : ''}${s.paidBy === 'other' ? `<span class="tag">${esc(s.with)} 代付</span>` : ''}`;
            })()}
            ${t.oneOff ? '<span class="tag" title="非日常支出：仍算支出，但不列入投資規劃的日常支出估計">非日常</span>' : ''}
            ${t.excluded ? '<span class="tag" title="不計入收支：例如家人付款">不計收支</span>' : ''}
            ${t.topUp ? '<span class="tag" title="儲值：計入卡費，但不算消費（實際消費以發票計）">儲值</span>' : ''}
            ${t.installment ? `<span class="tag" title="分期付款：計入卡費，但不算消費（消費以購買當天的發票全額計）">${t.installment.cancelled ? '分期取消' : `分期 ${t.installment.no ?? ''}${t.installment.of ? `/${t.installment.of}` : ''}`}</span>` : ''}
            ${t.pending ? '<span class="tag warn" title="刷卡授權，銀行還沒正式請款">未請款</span>' : ''}
            ${link ? `<span class="tag linked" title="${merged ? '已併入刷卡那筆，不重複計算' : '已合併載具明細'}">${merged ? '已併入刷卡' : `已合併 ${link.otherTxIds.length} 張發票`}</span>` : ''}
          </span>
        </div>
        <span class="row-amt ${t.type === 'income' ? 'inc' : ''}">${t.type === 'income' ? '+' : ''}${money(t.amount)}</span>
      </li>`;
    }).join('')}</ul>`).join('') : emptyState('這個月還沒有記錄。可以手動新增，或匯入載具與刷卡明細。')}`;

  root.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { state.month = addMonths(state.month, Number(b.dataset.m)); renderTransactions(root); }));
  $('#tx-month', root).onchange = (e) => { if (e.target.value) { state.month = e.target.value; renderTransactions(root); } };
  $('#tx-src', root).onchange = (e) => { state.source = e.target.value; renderTransactions(root); };
  $('#tx-q', root).oninput = (e) => {
    state.q = e.target.value;
    clearTimeout(state.qt);
    state.qt = setTimeout(() => { renderTransactions(root); const q = $('#tx-q', root); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 250);
  };
  $('#tx-add', root).onclick = () => editTx();
  $('#tx-imp-inv', root).onclick = importInvoiceDialog;
  $('#tx-imp-card', root).onclick = () => importCardDialog();
  $('#tx-imp-mb', root).onclick = () => importMoneybookDialog();
  $('#tx-del-inv', root).onclick = () => deleteInvoicesDialog();
  root.querySelectorAll('.row').forEach((el) => {
    const open = () => editTx(L.transactions.find((t) => t.id === el.dataset.id));
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
}

export async function editTx(tx) {
  const isNew = !tx;
  const values = tx ? { ...tx, splitWith: tx.split && !tx.split.settle ? tx.split.with : '', splitMine: tx.split && !tx.split.settle ? tx.split.mine : null } : { type: 'expense', date: ymd(), source: 'manual', category: '餐飲' };
  const items = tx?.items?.length ? `<br>品項：${tx.items.map((i) => `${esc(i.name)}${i.qty && i.qty !== 1 ? ` ×${i.qty}` : ''} ${i.amount}`).join('、')}` : '';
  const extra = isNew ? [] : [{ label: '刪除', value: 'delete', danger: true }, ...(tx.linkId ? [{ label: '解除合併', value: 'unlink' }] : [])];
  const v = await formDialog({
    title: isNew ? '新增收支' : '編輯收支', fields: txFields(values.type, { bankOnly: !!(tx && tx.source === 'card' && !tx.cardId && tx.issuerId) }), values, extraButtons: extra,
    intro: tx?.carrier || items ? `${esc(tx.carrier || '')}${items}` : '',
  });
  if (!v) return;
  if (v.__action === 'delete') {
    if (!(await confirmDialog('確定刪除這筆記錄？', '刪除', true))) return;
    store.commit((l) => { if (tx.linkId) unlink(l, tx.linkId); remove(l, 'transactions', tx.id); });
    toast('已刪除');
    return;
  }
  if (v.__action === 'unlink') {
    store.commit((l) => unlink(l, tx.linkId));
    toast('已解除合併');
    return;
  }
  // 分帳: who it was shared with and my share (empty = not shared)
  const { splitWith, splitMine, ...rest } = v;
  Object.keys(v).forEach((k) => delete v[k]);
  Object.assign(v, rest);
  if (!tx?.split?.settle) {
    if (splitWith && splitMine !== null && splitMine !== undefined) {
      const paidByOther = tx?.split?.paidBy === 'other';
      v.split = { ...(tx?.split || {}), with: splitWith.trim(), mine: Number(splitMine), paid: paidByOther ? 0 : Number(v.amount), ref: tx?.split?.ref || `manual|${Date.now().toString(36)}` };
    } else if (tx?.split) v.split = undefined;
  }
  if (v.source !== 'card') v.cardId = v.cardId || '';
  if (v.source === 'card') {
    v.paymentMethod = 'card';
    // keep the bank in step with the card (bank-only rows get a card assigned here)
    const bank = store.ledger.cards.find((c) => c.id === v.cardId)?.issuerId;
    if (bank) v.issuerId = bank;
  }
  store.commit((l) => upsert(l, 'transactions', tx ? { ...v, id: tx.id } : v));
  toast(isNew ? '已新增' : '已儲存');
}

function fileDialogHtml(title, body) {
  return `<div class="form"><h2>${esc(title)}</h2>${body}<p class="form-error" role="alert"></p>
    <div class="actions"><span class="spacer"></span><button class="btn ghost" data-cancel>取消</button>
    <button class="btn primary" data-ok disabled>匯入</button></div></div>`;
}

function deleteInvoicesDialog() {
  const [y, m] = state.month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return customDialog(`<div class="form"><h2>刪除載具資料</h2>
    <p class="intro">刪除指定期間內所有從載具匯入的發票記錄，例如要重新匯入時使用。刷卡、手動與繳費記錄不受影響；和刷卡合併過的發票會先解除合併，刷卡那筆保留。刪除後無法復原，但可以再匯入同一份 CSV。</p>
    <div class="fields">
      <div class="field"><label for="di-from">開始日期</label><input type="date" id="di-from" value="${state.month}-01"></div>
      <div class="field"><label for="di-to">結束日期</label><input type="date" id="di-to" value="${state.month}-${String(last).padStart(2, '0')}"></div>
    </div>
    <p id="di-prev" class="preview"></p>
    <div class="actions"><span class="spacer"></span><button class="btn ghost" data-cancel>取消</button>
      <button class="btn danger" data-ok disabled>刪除</button></div></div>`, (dlg, close) => {
    const range = () => [$('#di-from', dlg).value, $('#di-to', dlg).value];
    const preview = () => {
      const [from, to] = range();
      const ok = from && to && from <= to;
      const r = ok ? deleteInvoicesInRange(store.ledger, from, to, { dryRun: true }) : { count: 0 };
      $('#di-prev', dlg).innerHTML = !ok ? '<span class="form-error">請選擇正確的日期區間</span>'
        : r.count ? `會刪除 <b>${r.count}</b> 張發票，合計 ${money(r.total)}${r.linked ? `；其中 ${r.linked} 張已和刷卡合併，會先解除合併` : ''}。`
          : '這段期間沒有載具資料。';
      const btn = $('[data-ok]', dlg);
      btn.disabled = !r.count;
      btn.textContent = r.count ? `刪除 ${r.count} 張發票` : '刪除';
      return r;
    };
    $('#di-from', dlg).oninput = preview;
    $('#di-to', dlg).oninput = preview;
    preview();
    $('[data-ok]', dlg).onclick = () => {
      const [from, to] = range();
      const r = store.commit((l) => deleteInvoicesInRange(l, from, to));
      toast(`已刪除 ${r.count} 張發票`);
      close(true);
    };
  });
}

function importInvoiceDialog() {
  let parsed = [];
  return customDialog(fileDialogHtml('匯入載具消費', `
    <p class="intro">到財政部電子發票整合服務平台 → 載具消費明細，選擇期間後匯出 CSV，再把檔案選進來。每張發票記成一筆，金額為所有品項加總（已扣除折扣、回饋）。已匯入過的發票會略過；內容不同時會更新金額與品項，你改過的類別和備註會保留。</p>
    <input type="file" accept=".csv,.txt,text/csv" id="inv-file">
    <div id="inv-prev" class="preview"></div>`), (dlg, close) => {
    $('#inv-file', dlg).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      parsed = parseEInvoice(await readFileText(f));
      const total = sum(parsed, (i) => i.amount);
      $('#inv-prev', dlg).innerHTML = parsed.length
        ? `<p>讀到 <b>${parsed.length}</b> 張發票、${parsed.reduce((n, i) => n + i.items.length, 0)} 個品項，共 ${money(total)}。</p><ul class="mini">${parsed.slice(0, 6).map((i) => `<li>${esc(i.date)} ${esc(i.merchant)} ${money(i.amount)}（${i.items.length} 項）</li>`).join('')}${parsed.length > 6 ? '<li>…</li>' : ''}</ul>`
        : '<p class="form-error">看不懂這個檔案的格式。請確認是電子發票平台匯出的 CSV。</p>';
      $('[data-ok]', dlg).disabled = !parsed.length;
    };
    $('[data-ok]', dlg).onclick = () => {
      const r = store.commit((l) => importInvoices(l, parsed));
      toast(`新增 ${r.added} 筆${r.updated ? `，更新 ${r.updated} 筆` : ''}${r.skipped ? `，略過 ${r.skipped} 筆` : ''}。到「對帳」合併重複的刷卡記錄。`);
      close(true);
    };
  });
}

export function importCardDialog(presetIssuerId) {
  const banks = live(store.ledger.issuers).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  let all = []; // every parsed row (summary blocks + table)
  let head = 0; // index of the table's header row
  let meta = {};
  let rawText = '';
  let layout = false; // aligned text (copied out of a PDF) instead of a table
  const maps = JSON.parse(localStorage.getItem('acct.cardMaps') || '{}');
  return customDialog(fileDialogHtml('匯入信用卡帳單', `
    <p class="intro">台灣的信用卡帳單以銀行合併計算，所以明細是匯入到「銀行」。不用先建立信用卡：帳單上的卡號（例如「…末４碼9999」或卡號欄）會自動對應或建立卡片，之後可以替卡片取名字。可以選 CSV 檔，或直接把網銀的帳單頁面複製貼上。</p>
    <div class="fields">
      <div class="field"><label for="ci-bank">發卡銀行</label><select id="ci-bank">
        ${banks.map((b) => `<option value="${b.id}" ${b.id === presetIssuerId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        <option value="__new" ${banks.length ? '' : 'selected'}>＋ 新增銀行…</option></select></div>
      <div class="field" id="ci-newbank-f"><label for="ci-newbank">銀行名稱</label><input id="ci-newbank" placeholder="例如 台北富邦銀行" autocomplete="off"></div>
      <div class="field wide"><label for="ci-file">帳單檔案（CSV）</label><input type="file" accept=".csv,.txt,text/csv,text/plain" id="ci-file"></div>
      <div class="field wide"><label for="ci-paste">或貼上帳單內容</label><textarea id="ci-paste" rows="4" placeholder="在網銀的帳單頁面，或 PDF 帳單／消費明細中全選、複製，貼在這裡"></textarea></div>
    </div>
    <div id="ci-meta" class="preview"></div>
    <div id="ci-map" class="fields"></div>
    <div id="ci-prev" class="preview"></div>`), (dlg, close) => {
    const bankSel = $('#ci-bank', dlg);
    const isNew = () => bankSel.value === '__new';
    // a typed "new" bank that is really an existing one (台北富邦 = 富邦銀行) is treated as that bank
    const typedBank = () => {
      const typed = $('#ci-newbank', dlg).value.trim();
      return isNew() && typed ? live(store.ledger.issuers).find((i) => issuerKey(i.name) === issuerKey(typed)) : undefined;
    };
    const bankId = () => (isNew() ? typedBank()?.id : bankSel.value);
    const bankKey = () => bankId() || 'new';
    const bankCards = () => (bankId() ? live(store.ledger.cards).filter((c) => c.issuerId === bankId()) : []);
    const intOrUndef = (el) => (el && el.value !== '' && Number(el.value) >= 0 ? Number(el.value) : undefined);
    const mapping = () => ({
      date: Number($('#ci-date', dlg)?.value), desc: Number($('#ci-desc', dlg)?.value), amount: Number($('#ci-amt', dlg)?.value),
      card: intOrUndef($('#ci-cardcol', dlg)), post: guessCardColumns(all[head] || []).post, skipHeader: true, yearHint: new Date().getFullYear(),
    });
    const target = () => ({ issuerId: bankId(), cards: bankCards().map((c) => ({ id: c.id, last4: c.last4 })) });
    const options = () => ({
      autoCreate: $('#ci-auto', dlg)?.checked ?? true,
      defaultCardId: $('#ci-default', dlg)?.value || undefined,
      useMeta: $('#ci-usemeta', dlg)?.checked ?? false,
      statementId: $('#ci-usemeta', dlg)?.checked ? undefined : $('#ci-stm', dlg)?.value || undefined,
    });
    const drawMeta = () => {
      const has = meta.closingDate && meta.period;
      const stmts = bankId() ? statementsOfIssuer(store.ledger, bankId()) : [];
      $('#ci-meta', dlg).innerHTML = (has ? `<label class="check"><input type="checkbox" id="ci-usemeta" checked><span>
          依帳單資訊建立 ${esc(meta.period)} 合併帳單：結帳 ${esc(meta.closingDate)}${meta.dueDate ? `、繳款截止 ${esc(meta.dueDate)}` : ''}${meta.total !== undefined ? `、應繳 ${money(meta.total)}` : ''}${meta.limit ? `；銀行額度更新為 ${money(meta.limit)}` : ''}</span></label>` : '')
        + `<div class="field" id="ci-stm-f" ${has ? 'hidden' : ''}><label for="ci-stm">歸入合併帳單</label><select id="ci-stm"><option value="">（未出帳／不指定）</option>${stmts.map((x) => `<option value="${x.id}">${esc(x.period)} 合併帳單</option>`).join('')}</select></div>`;
      const um = $('#ci-usemeta', dlg);
      if (um) um.onchange = () => { $('#ci-stm-f', dlg).hidden = um.checked; };
    };
    const preview = () => {
      if (!all.length && !layout) return [];
      const txs = layout ? layoutToTransactions(rawText, target()).txs : cardRowsToTransactions(all.slice(head), mapping(), target());
      const names = new Map(bankCards().map((c) => [c.id, c.name]));
      const newCards = new Map();
      const per = new Map();
      const o = options();
      for (const t of txs) {
        let key;
        if (t.cardId) key = names.get(t.cardId);
        else if (t._unmatchedLast4 && o.autoCreate) {
          key = `新卡：${t._cardLabel ? `${t._cardLabel} *${t._unmatchedLast4}` : `末四碼 ${t._unmatchedLast4}`}`;
          newCards.set(t._unmatchedLast4, t._cardLabel || '');
        } else key = o.defaultCardId ? names.get(o.defaultCardId) : '只記在銀行';
        per.set(key, (per.get(key) || 0) + 1);
      }
      const pendingNote = txs.some((t) => t.pending) ? '<p class="notice small">這份是「尚未請款」的授權紀錄，會標記為未請款；之後匯入正式的請款明細時，同卡、同金額、日期相近的那筆會改為已請款，不會重複。</p>' : '';
      $('#ci-prev', dlg).innerHTML = txs.length
        ? `${pendingNote}<p>可匯入 <b>${txs.length}</b> 筆，共 ${money(sum(txs, (t) => (t.type === 'income' ? -1 : 1) * t.amount))}（繳卡費的列不算消費，不會匯入）。</p>
           <p class="small">分配：${[...per].map(([k, n]) => `${esc(k)} ${n} 筆`).join('、')}</p>
           ${newCards.size ? `<p class="notice small">會自動建立 ${newCards.size} 張卡：${[...newCards].map(([l4, label]) => (label ? `${esc(label)} *${esc(l4)}` : `末四碼 ${esc(l4)}`)).join('、')}。匯入後可在「信用卡」替它們取名字。</p>` : ''}
           <ul class="mini">${txs.slice(0, 5).map((t) => `<li>${esc(t.date)} ${esc(t.merchant)} ${t.type === 'income' ? '退款 ' : ''}${money(t.amount)}${t.cardLast4 ? ` <span class="muted">*${esc(t.cardLast4)}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="form-error">依目前的欄位設定讀不到任何明細，請調整欄位。</p>';
      const typed = $('#ci-newbank', dlg).value.trim();
      const same = typedBank();
      if (same) $('#ci-prev', dlg).insertAdjacentHTML('afterbegin', `<p class="notice small">「${esc(typed)}」就是現有的「${esc(same.name)}」，明細會匯入到這家銀行。</p>`);
      $('[data-ok]', dlg).disabled = !txs.length || (isNew() && !typed);
      return txs;
    };
    const drawMap = () => {
      if (layout) {
        const cards = bankCards();
        const saved = maps[bankKey()] || {};
        $('#ci-map', dlg).innerHTML = `<p class="muted small wide">偵測到文字排版的明細（例如從 PDF 複製），會自動找出日期、卡號末四碼、商店與金額。</p>
          <div class="field"><label class="check"><input type="checkbox" id="ci-auto" ${saved.autoCreate === false ? '' : 'checked'}> 對不到的卡號自動建立卡片</label></div>
          <div class="field"><label for="ci-default">沒有卡號的明細</label><select id="ci-default"><option value="">只記在銀行（不指定卡片）</option>
          ${cards.map((c) => `<option value="${c.id}">${esc(c.name)}${c.last4 ? ` ****${esc(c.last4)}` : ''}</option>`).join('')}</select></div>`;
        $('#ci-map', dlg).querySelectorAll('select,input').forEach((el) => (el.onchange = preview));
        preview();
        return;
      }
      if (!all.length) return;
      const hdr = all[head] || [];
      const width = Math.max(...all.slice(head, head + 10).map((r) => r.length));
      const saved = maps[bankKey()] || {};
      const g = guessCardColumns(hdr, width);
      const m = { date: saved.date ?? g.date, desc: saved.desc ?? g.desc, amount: saved.amount ?? g.amount, card: saved.card ?? g.card };
      const colOpts = (val, none) => (none ? `<option value="-1" ${val < 0 ? 'selected' : ''}>${none}</option>` : '')
        + Array.from({ length: width }, (_, i) => `<option value="${i}" ${i === val ? 'selected' : ''}>第 ${i + 1} 欄：${esc((hdr[i] || '').slice(0, 14))}</option>`).join('');
      const sel = (id, label, val, none) => `<div class="field"><label for="${id}">${label}</label><select id="${id}">${colOpts(val, none)}</select></div>`;
      const cards = bankCards();
      const def = saved.defaultCardId && cards.some((c) => c.id === saved.defaultCardId) ? saved.defaultCardId : '';
      $('#ci-map', dlg).innerHTML = sel('ci-date', '日期欄', m.date) + sel('ci-desc', '說明欄', m.desc) + sel('ci-amt', '金額欄（新臺幣）', m.amount)
        + sel('ci-cardcol', '卡號欄', m.card, '（沒有卡號欄，依帳單上的卡別段落）')
        + `<div class="field"><label class="check"><input type="checkbox" id="ci-auto" ${saved.autoCreate === false ? '' : 'checked'}> 對不到的卡號自動建立卡片</label></div>`
        + `<div class="field"><label for="ci-default">沒有卡號的明細</label><select id="ci-default">
             <option value="" ${def ? '' : 'selected'}>只記在銀行（不指定卡片）</option>
             ${cards.map((c) => `<option value="${c.id}" ${c.id === def ? 'selected' : ''}>${esc(c.name)}${c.last4 ? ` ****${esc(c.last4)}` : ''}</option>`).join('')}</select></div>`;
      $('#ci-map', dlg).querySelectorAll('select,input').forEach((el) => (el.onchange = preview));
      preview();
    };
    const load = (text) => {
      rawText = text;
      layout = looksLikeLayoutText(text);
      all = parseCsv(text);
      head = findHeaderRow(all);
      meta = statementMeta(all);
      drawMeta();
      drawMap();
    };
    const syncBank = () => {
      $('#ci-newbank-f', dlg).hidden = !isNew();
      drawMeta();
      drawMap();
    };
    bankSel.onchange = syncBank;
    $('#ci-newbank', dlg).oninput = () => { drawMeta(); drawMap(); preview(); };
    syncBank();
    $('#ci-file', dlg).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        toast('網頁版無法直接讀 PDF：請打開 PDF 全選、複製，貼到下方「貼上帳單內容」；或請 Claude Code 用 CLI 匯入 PDF。', 'error');
        e.target.value = '';
        return;
      }
      load(await readFileText(f));
    };
    $('#ci-paste', dlg).oninput = (e) => {
      clearTimeout(e.target._t);
      e.target._t = setTimeout(() => e.target.value.trim() && load(e.target.value), 300);
    };
    $('[data-ok]', dlg).onclick = () => {
      const txs = preview();
      const m = mapping();
      const o = options();
      const r = store.commit((l) => importBankStatement(l, {
        bankId: bankId(), bankName: $('#ci-newbank', dlg).value.trim(),
        txs, meta, autoCreate: o.autoCreate, defaultCardId: o.defaultCardId, statementId: o.statementId, useMeta: o.useMeta,
      }));
      maps[r.issuerId] = { date: m.date, desc: m.desc, amount: m.amount, card: m.card ?? -1, autoCreate: o.autoCreate, defaultCardId: o.defaultCardId || '' };
      localStorage.setItem('acct.cardMaps', JSON.stringify(maps));
      toast(`新增 ${r.added} 筆${r.confirmed ? `，${r.confirmed} 筆未請款改為已請款` : ''}${r.skipped ? `，略過重複 ${r.skipped} 筆` : ''}${r.filled ? `（${r.filled} 筆補上入帳日）` : ''}${r.created.length ? `，建立 ${r.created.length} 張卡` : ''}${r.statement ? `，已套用 ${r.statement.period} 合併帳單` : ''}。到「對帳」與載具發票合併。`);
      close(true);
    };
  });
}
