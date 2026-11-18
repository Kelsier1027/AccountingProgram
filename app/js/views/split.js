// Import dialog for the shared-expense app's 帳期 CSVs (分帳).
import { store } from '../store.js';
import { parseSplitCsv, importSplits, looksLikeSplitCsv } from '../core/split.js';
import { esc, money, customDialog, toast, readFileText, $ } from '../ui.js';

export function importSplitDialog() {
  let files = [];
  return customDialog(`<div class="form"><h2>匯入分帳 CSV</h2>
    <p class="intro">從分帳 App 匯出每個帳期的明細 CSV，可以一次選多個。你付的消費會對到帳本裡的刷卡或發票，收支只算你的份；
    對方代付的記成你的份；帳本找不到的先「分帳暫記」，之後匯入刷卡或發票時自動接手；還款只沖銷餘額。重複匯入不會重複記錄。</p>
    <input type="file" accept=".csv,text/csv" id="sp-files" multiple>
    <div class="fields"><div class="field"><label for="sp-from">從哪天開始逐筆匯入</label><input type="date" id="sp-from" value="2026-03-01">
      <small class="hint">之前的明細只計入往來餘額，不逐筆記錄。</small></div></div>
    <div id="sp-prev" class="preview"></div>
    <p class="form-error" role="alert"></p>
    <div class="actions"><span class="spacer"></span><button class="btn ghost" data-cancel>取消</button>
    <button class="btn primary" data-ok disabled>匯入</button></div></div>`, (dlg, close) => {
    $('#sp-files', dlg).onchange = async (e) => {
      files = [];
      const bad = [];
      for (const f of e.target.files) {
        const text = await readFileText(f);
        if (looksLikeSplitCsv(text)) files.push(parseSplitCsv(text));
        else bad.push(f.name);
      }
      files.sort((a, b) => (a.entries[a.entries.length - 1]?.date || '').localeCompare(b.entries[b.entries.length - 1]?.date || ''));
      $('#sp-prev', dlg).innerHTML = (files.length ? `<ul class="mini">${files.map((f) => `<li>${esc(f.group)}：${f.entries.filter((x) => x.kind === 'expense').length} 筆支出、${f.entries.filter((x) => x.kind === 'settle').length} 筆還款（${esc(f.me)} ／ ${esc(f.other)}）</li>`).join('')}</ul>` : '')
        + (bad.length ? `<p class="form-error">看不出是分帳 App 的匯出檔：${bad.map(esc).join('、')}</p>` : '');
      $('[data-ok]', dlg).disabled = !files.length;
    };
    $('[data-ok]', dlg).onclick = () => {
      const from = $('#sp-from', dlg).value;
      const r = store.commit((l) => importSplits(l, files, { from }));
      close(true);
      resultDialog(r);
    };
  });
}

function resultDialog(r) {
  const li = [
    `對到帳本的付款 ${r.matched.length} 筆`,
    r.placeholders.length ? `帳本找不到、先分帳暫記 ${r.placeholders.length} 筆` : '',
    r.theyPaid.length ? `對方代付 ${r.theyPaid.length} 筆` : '',
    r.settlements.length ? `還款 ${r.settlements.length} 筆` : '',
    r.updated ? `已匯入過、更新 ${r.updated} 筆` : '',
  ].filter(Boolean);
  return customDialog(`<div class="form"><h2>分帳匯入完成</h2>
    <ul class="mini">${li.map((x) => `<li>${x}</li>`).join('')}</ul>
    ${r.guessed.length ? `<h3>請確認這 ${r.guessed.length} 筆的對應</h3><p class="intro">有多個候選或金額略有不同，已對到最接近的一筆；不對的話，到收支頁把那筆的「分帳對象」清空即可。</p>
      <ul class="mini">${r.guessed.map((g) => `<li>${esc(g.date)} ${esc(g.name)} ${money(g.amount)} → ${esc(g.to)}</li>`).join('')}</ul>` : ''}
    ${r.missing.length ? `<h3>App 裡已刪除？</h3><ul class="mini">${r.missing.map((m) => `<li>${esc(m.date)} ${esc(m.name)}</li>`).join('')}</ul>` : ''}
    <div class="actions"><span class="spacer"></span><button class="btn primary" data-ok>完成</button></div></div>`, (dlg, close) => {
    $('[data-ok]', dlg).onclick = () => { toast('已匯入分帳'); close(true); };
  });
}
