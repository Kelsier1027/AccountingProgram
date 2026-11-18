import { store } from '../store.js';
import { live, upsert, remove } from '../core/model.js';
import { valueHolding, hasRate } from '../core/calc.js';
import { sum } from '../core/util.js';
import { esc, money, formDialog, confirmDialog, toast, emptyState } from '../ui.js';

const fields = [
  { key: 'symbol', label: '代號', required: true, placeholder: '2330.TW、6488.TWO、AAPL',
    hint: '上市加 .TW、上櫃加 .TWO，美股直接輸入代號。' },
  { key: 'name', label: '名稱' },
  { key: 'shares', label: '股數', type: 'number', required: true, hint: '一張 = 1000 股' },
  { key: 'avgCost', label: '平均成本（每股）', type: 'number', required: true },
  { key: 'currency', label: '幣別', type: 'select', options: [['TWD', '新台幣'], ['USD', '美元'], ['JPY', '日圓'], ['HKD', '港幣'], ['EUR', '歐元']] },
  { key: 'manualPrice', label: '手動股價（留空則用自動報價）', type: 'number' },
];

let busy = false;

export function renderStocks(root) {
  const P = store.prices;
  const rows = live(store.ledger.holdings).map((h) => ({ h, v: valueHolding(h, P) })).sort((a, b) => b.v.valueBase - a.v.valueBase);
  const total = sum(rows, (r) => r.v.valueBase);
  const cost = sum(rows, (r) => r.v.costBase);
  const pnl = total - cost;
  const missingFx = [...new Set(rows.filter((r) => !hasRate(r.v.currency, P)).map((r) => r.v.currency))];
  const src = { manual: '手動', quote: '報價', cost: '無報價' };
  const when = P.updatedAt ? new Date(P.updatedAt).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }) : null;

  root.innerHTML = `
  <div class="kv">
    <div><span>市值</span>${money(total)}</div>
    <div><span>成本</span>${money(cost)}</div>
    <div><span>未實現損益</span>${money(pnl, { signed: true })}</div>
    <div><span>報酬率</span><span class="num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}">${cost ? ((pnl / cost) * 100).toFixed(2) : '0.00'}%</span></div>
  </div>
  <div class="toolbar">
    <button class="btn primary" id="s-add">新增持股</button>
    <button class="btn ghost" id="s-refresh" ${busy ? 'disabled' : ''}>${busy ? '更新中…' : '更新股價'}</button>
    <span class="muted small" id="s-note">${when ? `報價時間：${esc(when)}` : '還沒有自動報價'}${P.fx && Object.keys(P.fx).length ? `｜匯率 ${Object.entries(P.fx).map(([k, v]) => `${k} ${v}`).join('、')}` : ''}</span>
  </div>
  ${missingFx.length ? `<p class="notice">缺少 ${esc(missingFx.join('、'))} 匯率，這些持股暫時以原幣金額計入。按「更新股價」會一併抓匯率。</p>` : ''}
  ${rows.length ? `<div class="tbl-wrap"><table class="tbl stocks">
    <thead><tr><th>代號</th><th class="r">股數</th><th class="r">成本</th><th class="r">現價</th><th class="r">市值（台幣）</th><th class="r">損益</th></tr></thead>
    <tbody>${rows.map(({ h, v }) => `<tr data-id="${h.id}" tabindex="0">
      <td><b>${esc(h.symbol)}</b><br><span class="muted small">${esc(h.name || '')}</span></td>
      <td class="r num">${Number(h.shares).toLocaleString('zh-TW')}</td>
      <td class="r">${money(h.avgCost, { currency: v.currency, digits: 2 })}</td>
      <td class="r">${money(v.price, { currency: v.currency, digits: 2 })}<br><span class="tag ${v.priceSource === 'cost' ? 'warn' : ''}">${src[v.priceSource]}</span></td>
      <td class="r">${money(v.valueBase)}</td>
      <td class="r">${money(v.pnlBase, { signed: true })}<br><span class="small num ${v.pnl > 0 ? 'up' : v.pnl < 0 ? 'down' : ''}">${(v.pnlPct * 100).toFixed(2)}%</span></td>
    </tr>`).join('')}</tbody></table></div>
    <p class="muted small">損益顏色依台股慣例：紅色為獲利、綠色為虧損（可在設定中切換）。</p>` : emptyState('還沒有持股。新增後，GitHub Actions 每個交易日收盤後會自動更新股價。')}`;

  root.querySelector('#s-add').onclick = () => edit();
  root.querySelectorAll('tr[data-id]').forEach((tr) => {
    const open = () => edit(store.ledger.holdings.find((h) => h.id === tr.dataset.id));
    tr.onclick = open;
    tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  root.querySelector('#s-refresh').onclick = async () => {
    if (!store.remoteEnabled) {
      toast('自動報價需要先在「設定」連接 GitHub。也可以在持股裡輸入手動股價。', 'error');
      return;
    }
    busy = true;
    renderStocks(root);
    try {
      if (store.dirty) await store.sync(); // make sure symbols.json is current
      const ok = await store.refreshPrices((msg) => { const n = root.querySelector('#s-note'); if (n) n.textContent = msg; });
      toast(ok ? '股價已更新' : '還沒拿到新報價，Actions 可能還在排隊，稍後重新整理即可', ok ? 'info' : 'error');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy = false;
      if (root.isConnected) renderStocks(root);
    }
  };
}

async function edit(h) {
  const v = await formDialog({ title: h ? '編輯持股' : '新增持股', fields, values: h || { currency: 'TWD' }, extraButtons: h ? [{ label: '刪除', value: 'delete', danger: true }] : [] });
  if (!v) return;
  if (v.__action === 'delete') {
    if (await confirmDialog(`刪除 ${h.symbol}？`, '刪除', true)) store.commit((l) => remove(l, 'holdings', h.id));
    return;
  }
  v.symbol = v.symbol.toUpperCase().replace(/\s/g, '');
  if (/^\d{4,6}[A-Z]?$/.test(v.symbol)) v.symbol += '.TW'; // bare Taiwan code
  if (v.manualPrice === null) v.manualPrice = '';
  store.commit((l) => upsert(l, 'holdings', h ? { ...v, id: h.id } : v));
  toast('已儲存');
}
