// 資金缺口預警 (top of the 現金流規劃 page): will cash run short, when, by how much, and the options.
import { store } from '../store.js';
import { live, upsert, remove } from '../core/model.js';
import { cashForecast, FORECAST_DEFAULTS } from '../core/forecast.js';
import { isPlannedItem } from '../core/calc.js';
import { formatMoney, ymd } from '../core/util.js';
import { esc, money, formDialog, confirmDialog, toast } from '../ui.js';
import { lineChart } from '../charts.js';

const state = { scenario: 'conservative' };
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const ymLabel = (m) => `${m.slice(0, 4)}/${Number(m.slice(5))}`;
const SCEN = { conservative: '保守（只算薪資與確定的收支）', expected: '預期（加上預估獎金與預計收支）' };

export function forecastSection() {
  const L = store.ledger;
  const f = cashForecast(L, store.prices, ymd(), { scenario: state.scenario });
  const n = f.need;
  const months = f.months.length;
  const head = n
    ? ['crit', `預計 ${md(n.start)} 起存款不足，最多缺約 ${formatMoney(Math.ceil(n.amount / 1000) * 1000)}`,
      `最低點在 ${md(n.lowDate)}（${formatMoney(-n.amount)}）。${n.end ? `${md(n.end)} 才補回來。` : `到 ${ymLabel(f.months[months - 1].month)} 都還沒補回來。`}${n.structural ? ` 每月平均少 ${formatMoney(-f.trend)}，缺口會越來越大，不是一時的週轉問題。` : ''}`]
    : f.belowReserve.length
      ? ['warn', `未來 ${months} 個月不會不夠付，但 ${md(f.belowReserve[0].start)} 起低於安全存量`, `安全存量 ${formatMoney(f.reserve)}，最低點 ${md(f.low.date)} 剩 ${formatMoney(f.low.balance)}。`]
      : ['ok', `未來 ${months} 個月不會出現資金缺口`, `最低點 ${md(f.low.date)} 仍有 ${formatMoney(f.low.balance)}。`];
  const r = f.remedies;
  const planned = live(L.bills).filter(isPlannedItem).sort((a, b) => a.date.localeCompare(b.date));

  return `
  <section class="block plan-verdict lv-${head[0]}">
    <div class="block-head"><h2>資金缺口預警</h2>
      <div class="seg" role="group" aria-label="情境">${Object.keys(SCEN).map((k) => `<button class="btn sm ${state.scenario === k ? 'primary' : 'ghost'}" data-scen="${k}" aria-pressed="${state.scenario === k}">${k === 'conservative' ? '保守' : '預期'}</button>`).join('')}</div></div>
    <p class="muted small">情境：${SCEN[state.scenario]}</p>
    <h3>${esc(head[1])}</h3>
    <p>${esc(head[2])}</p>
    <div id="c-fc"></div>
  </section>

  ${n ? `<section class="block">
    <h2>因應方案（試算，不是投資建議）</h2>
    <p class="muted small">需要在 ${md(n.start)} 前準備約 ${money(n.amount)}，缺口持續約 ${n.days} 天。${n.causes.length ? `那段時間的大筆付款：${n.causes.map((c) => `${md(c.date)} ${esc(c.label)} ${formatMoney(-c.amount)}`).join('、')}。` : ''}</p>
    <h3>賣股票</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>標的</th><th class="r">賣出股數</th><th class="r">約可得</th><th class="r">手續費＋稅</th><th class="r hide-sm">已實現損益</th><th>最晚賣出</th></tr></thead><tbody>
      ${r.sell.map((s) => `<tr><td>${esc(s.name)}</td><td class="r num">${s.shares.toLocaleString()}${s.enough ? '' : '（全部也不夠）'}</td><td class="r">${money(s.proceeds)}</td><td class="r">${money(s.cost)}</td><td class="r hide-sm">${money(s.realized, { signed: true })}</td><td class="num">${md(s.sellBy)}<span class="muted small">（T+${s.settleDays}）</span></td></tr>`).join('')}
    </tbody></table></div>
    <h3>借貸（借到 ${n.end ? md(n.end) : '期末'}，約 ${n.days} 天）</h3>
    <ul class="rows">${r.borrow.map((b) => `<li class="row"><div class="row-main"><span class="row-title">${esc(b.name)} <span class="muted small">年利率 ${b.rate}%</span></span><span class="row-sub">${esc(b.note)}</span></div><span class="row-amt">利息約 ${money(b.cost)}</span></li>`).join('')}</ul>
    <h3>其他</h3>
    <ul class="mini">
      ${r.owed ? `<li>先收回別人欠你的 ${money(r.owed)}（分帳與借貸），可補上 ${money(r.collect)}</li>` : ''}
      ${f.trend < 0 ? `<li>每月少花約 ${money(-f.trend)} 可止住下滑${r.spendLess > -f.trend ? `；要完全不出現缺口，近期每月需少花約 ${money(r.spendLess)}（缺口來得早，只靠省錢來不及，需搭配上面的方式）` : ''}</li>` : r.spendLess ? `<li>近期每月少花約 ${money(r.spendLess)} 即可避開缺口</li>` : ''}
      <li>${state.scenario === 'conservative' ? '切換到「預期」看把預估獎金算進去的情形' : '預估獎金沒發或少發時，以「保守」為準'}</li>
    </ul>
  </section>` : ''}

  <section class="block">
    <h2>逐月現金流</h2>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>月份</th><th class="r">月初</th><th class="r">收入</th><th class="r">固定與卡費</th><th class="r hide-sm">日常支出</th><th class="r">月底</th><th class="r">當月最低</th></tr></thead><tbody>
      ${f.months.map((m) => `<tr><td class="num">${ymLabel(m.month)}</td><td class="r">${money(m.opening)}</td><td class="r inc">${money(m.income)}</td><td class="r">${money(-m.out)}</td><td class="r hide-sm">${money(-m.living)}</td><td class="r">${money(m.closing)}</td><td class="r ${m.low < 0 ? 'neg-strong' : ''}">${money(m.low)}</td></tr>`).join('')}
    </tbody></table></div>
  </section>

  <section class="block">
    <div class="block-head"><h2>預計收支</h2><button class="btn ghost sm" id="fc-add">新增</button></div>
    <p class="muted small">未來一次性的收入或支出（獎金、旅行、換手機、年費…）。標為「確定」的兩種情境都算，其餘只算在「預期」。</p>
    ${planned.length ? `<ul class="rows">${planned.map((b) => `<li class="row"><div class="row-main" data-fc="${b.id}" tabindex="0"><span class="row-title">${esc(b.name)}</span>
      <span class="row-sub"><span class="num">${esc(b.date)}</span>${b.certain ? '<span class="tag">確定</span>' : '<span class="tag">預估</span>'}${b.note ? ` · ${esc(b.note)}` : ''}</span></div>
      <span class="row-amt ${b.direction === 'in' ? 'inc' : ''}">${b.direction === 'in' ? '+' : '−'}${money(b.amount)}</span></li>`).join('')}</ul>` : '<p class="muted small">還沒有預計收支。</p>'}
  </section>`;
}

const fields = [
  { key: 'name', label: '名稱', required: true, placeholder: '年終獎金、旅行尾款…' },
  { key: 'direction', label: '收或支', type: 'select', options: [['in', '收入'], ['out', '支出']] },
  { key: 'amount', label: '金額', type: 'number', required: true },
  { key: 'date', label: '預計日期', type: 'date', required: true },
  { key: 'certain', label: '確定會發生（保守情境也算）', type: 'checkbox' },
  { key: 'note', label: '備註', type: 'textarea', wide: true },
];

async function editPlanned(rec) {
  const v = await formDialog({ title: rec ? '編輯預計收支' : '新增預計收支', fields, values: rec || { direction: 'out', date: ymd(), certain: true },
    extraButtons: rec ? [{ label: '刪除', value: 'delete', danger: true }] : [] });
  if (!v) return;
  if (v.__action === 'delete') {
    if (await confirmDialog(`刪除「${rec.name}」？`, '刪除', true)) store.commit((l) => remove(l, 'bills', rec.id));
    return;
  }
  store.commit((l) => upsert(l, 'bills', { ...(rec ? { id: rec.id } : { kind: 'forecast', payments: [] }), ...v }));
  toast('已儲存');
}

export function wireForecast(root, rerender) {
  const f = cashForecast(store.ledger, store.prices, ymd(), { scenario: state.scenario });
  lineChart(root.querySelector('#c-fc'), f.timeline.map((t) => ({ x: t.date, y: t.balance })), { label: '預估餘額' });
  root.querySelectorAll('[data-scen]').forEach((b) => (b.onclick = () => { state.scenario = b.dataset.scen; rerender(); }));
  root.querySelector('#fc-add').onclick = () => editPlanned();
  root.querySelectorAll('[data-fc]').forEach((el) => {
    const open = () => editPlanned(store.ledger.bills.find((b) => b.id === el.dataset.fc));
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
}

export { FORECAST_DEFAULTS };
