// Moneybook import dialog: pick the exported CSVs, import, then decide the bank rows the rules
// could not classify (salary, rent, transfers to people…), optionally remembering the choice.
import { store } from '../store.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../core/model.js';
import { moneybookKind, moneybookRows, importMoneybook, addBankTransaction, addBankRule, bankMerchant } from '../core/moneybook.js';
import { esc, money, customDialog, toast, readFileText, $, $$ } from '../ui.js';

const KIND_LABEL = { accounts: '帳戶', transactions: '交易明細', bills: '信用卡帳單', invoices: '發票', items: '發票明細' };

export function importMoneybookDialog() {
  let files = {};
  return customDialog(`<div class="form"><h2>匯入 Moneybook</h2>
    <p class="intro">在 Moneybook 匯出帳戶、交易明細、帳單、發票與發票明細的 CSV，一次全部選進來（也可以只選其中幾個）。
    已匯入過的資料會略過；刷卡明細會和既有的銀行帳單去重，自己帳戶之間的轉帳、繳卡費、電子支付儲值不計收支。</p>
    <input type="file" accept=".csv,text/csv" id="mb-files" multiple>
    <div id="mb-prev" class="preview"></div>
    <label class="check"><input type="checkbox" id="mb-bal" checked> 用 Moneybook 的餘額更新存款帳戶（你在匯出日之後手動改過的餘額會保留）</label>
    <p class="form-error" role="alert"></p>
    <div class="actions"><span class="spacer"></span><button class="btn ghost" data-cancel>取消</button>
    <button class="btn primary" data-ok disabled>匯入</button></div></div>`, (dlg, close) => {
    $('#mb-files', dlg).onchange = async (e) => {
      files = {};
      const unknown = [];
      for (const f of e.target.files) {
        const text = await readFileText(f);
        const kind = moneybookKind(text);
        if (kind) files[kind] = text;
        else unknown.push(f.name);
      }
      const kinds = Object.keys(files);
      $('#mb-prev', dlg).innerHTML = (kinds.length
        ? `<ul class="mini">${kinds.map((k) => `<li>${KIND_LABEL[k]}：${moneybookRows(files[k]).length} 列</li>`).join('')}</ul>` : '')
        + (unknown.length ? `<p class="form-error">看不出是哪一種 Moneybook 匯出檔：${unknown.map(esc).join('、')}</p>` : '');
      $('[data-ok]', dlg).disabled = !kinds.length;
    };
    $('[data-ok]', dlg).onclick = () => {
      const balances = $('#mb-bal', dlg).checked;
      const r = store.commit((l) => importMoneybook(l, files, { balances }));
      close(true);
      resultDialog(r);
    };
  });
}

function categorySelect(i) {
  const o = (type, cats) => cats.map((c) => `<option value="${type}:${esc(c)}">${type === 'income' ? '收入' : '支出'}：${esc(c)}</option>`).join('');
  return `<select data-row="${i}" aria-label="怎麼記"><option value="skip">不計收支（轉帳）</option>
    <optgroup label="收入">${o('income', INCOME_CATEGORIES)}</optgroup><optgroup label="支出">${o('expense', EXPENSE_CATEGORIES)}</optgroup></select>`;
}

function summaryHtml(r) {
  const li = [];
  const accs = r.accounts.length;
  if (accs) li.push(`存款帳戶：${r.accounts.map((a) => `${esc(a.name)} ${a.from === null ? '新增' : `${money(a.from)} →`} ${money(a.to)}`).join('；')}`);
  for (const b of r.banks) li.push(`${esc(b.name)}：${b.limit ? `額度 ${money(b.limit)}` : ''}${b.overpaid !== undefined ? ` 溢繳 ${money(b.overpaid)}` : ''}`);
  const inv = r.invoices;
  if (inv.added.length || inv.fixed.length) li.push(`發票：新增 ${inv.added.length} 張，依發票總額修正 ${inv.fixed.length} 張`);
  if (inv.voided.length) li.push(`未匯入（財政部資料裡沒有，應已作廢）：${inv.voided.map((i) => `${esc(i.date)} ${esc(i.merchant)} ${money(i.amount)}`).join('；')}`);
  for (const c of r.cards) li.push(`刷卡 ${esc(c.name)}：新增 ${c.added}${c.pending ? `（未請款 ${c.pending}）` : ''}，已有 ${c.skipped}${c.newCards.length ? `，新卡 ${c.newCards.join('、')}（到「信用卡」取名字）` : ''}`);
  if (r.statements.added) li.push(`信用卡帳單：新增 ${r.statements.added} 期`);
  li.push(`銀行帳戶：新增 ${r.bank.added.length} 筆收支，自己帳戶間轉帳 ${r.bank.transfers} 筆、不計收支 ${r.bank.skipped} 筆略過`);
  for (const u of r.usageDiff) li.push(`注意：${esc(u.name)} 已用額度 Moneybook ${money(u.moneybook)}，帳本 ${money(u.ledger)}`);
  return `<ul class="mini">${li.map((x) => `<li>${x}</li>`).join('')}</ul>`;
}

function resultDialog(r) {
  const rows = r.bank.unknown;
  return customDialog(`<div class="form"><h2>Moneybook 匯入完成</h2>
    ${summaryHtml(r)}
    ${rows.length ? `<h3>有 ${rows.length} 筆銀行明細需要你決定</h3>
    <p class="intro">勾選「記住」，之後匯入同一個對象就會自動照這樣記。</p>
    <ul class="mb-rows">${rows.map((x, i) => `<li>
      <div class="mb-head"><span class="num">${esc(x['消費日'])}</span><span>${esc(x['機構名稱'])}</span><span class="num mb-amt">${money(Number(x['金額']))}</span></div>
      <div class="muted small">${esc(x['明細描述'])}</div>
      <div class="mb-ctl">${categorySelect(i)}<input type="text" data-name="${i}" value="${esc(bankMerchant(x['明細描述']))}" aria-label="名稱">
      <label class="check"><input type="checkbox" data-remember="${i}"> 記住</label></div></li>`).join('')}</ul>` : ''}
    <div class="actions"><span class="spacer"></span>${rows.length ? '<button class="btn ghost" data-cancel>稍後再說</button>' : ''}
    <button class="btn primary" data-ok>${rows.length ? '儲存' : '完成'}</button></div></div>`, (dlg, close) => {
    $('[data-ok]', dlg).onclick = () => {
      if (!rows.length) return close(true);
      let n = 0;
      store.commit((l) => {
        for (const sel of $$('[data-row]', dlg)) {
          const i = Number(sel.dataset.row);
          const row = rows[i];
          const [type, category] = sel.value.split(':');
          const merchant = $(`[data-name="${i}"]`, dlg).value.trim();
          if ($(`[data-remember="${i}"]`, dlg).checked) {
            addBankRule(l, { match: bankMerchant(row['明細描述']), type, ...(category ? { category } : {}), ...(merchant ? { merchant } : {}), direction: Number(row['金額']) > 0 ? 'in' : 'out' });
          }
          if (type !== 'skip') {
            addBankTransaction(l, row, { type, category, merchant });
            n++;
          }
        }
      });
      toast(`已記錄 ${n} 筆`);
      close(true);
    };
  });
}
