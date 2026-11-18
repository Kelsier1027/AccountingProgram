// 現金流規劃：資金缺口預警 (views/forecast.js) and 可投入金額 — can some of the cash in bank accounts go into the portfolio, and how much.
import { store } from '../store.js';
import { investmentPlan, PLAN_DEFAULTS } from '../core/plan.js';
import { formatMoney } from '../core/util.js';
import { esc, money, formDialog, toast } from '../ui.js';
import { lineChart } from '../charts.js';
import { forecastSection, wireForecast } from './forecast.js';

const KIND = { card: '卡費', installment: '分期', bill: '待繳', income: '收入', loan: '貸款', iou: '還款' };
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export function renderPlan(root) {
  const L = store.ledger;
  const r = investmentPlan(L, store.prices);
  const o = r.options;
  const lowText = `${md(r.low.date)} 預估剩 ${formatMoney(r.low.balance)}`;
  const verdict = {
    invest: ['ok', `現在可以投入 ${formatMoney(r.investNow)} 元`, `未來 ${o.horizonDays} 天的款項都付得出來：最低點在 ${lowText}，扣掉安全存量 ${formatMoney(r.reserve)} 後還有餘裕。`],
    hold: ['warn', '目前不建議動用存款投資', `未來 ${o.horizonDays} 天的款項付得出來，但最低點（${lowText}）低於安全存量 ${formatMoney(r.reserve)}，還差 ${formatMoney(r.shortfall)}。`],
    short: ['crit', `未來 ${o.horizonDays} 天有資金缺口`, `照目前的收支，${lowText}，會不夠付款項。先不要投入，並留意這段期間的支出或先把錢轉進常用帳戶。`],
  }[r.verdict];

  let running = r.cash.total;
  const flowRows = r.flows.map((f) => {
    running += f.amount;
    return `<tr><td class="num">${md(f.date)}</td><td>${esc(f.label)} <span class="muted small">${KIND[f.kind] || ''}</span></td>
      <td class="r num ${f.amount > 0 ? 'inc' : ''}">${f.amount > 0 ? '+' : ''}${money(f.amount)}</td></tr>`;
  }).join('');

  root.innerHTML = `${forecastSection()}
  <h2 class="page-section">可投入金額</h2>
  <section class="block plan-verdict lv-${verdict[0]}">
    <h2>${esc(verdict[1])}</h2>
    <p>${esc(verdict[2])}</p>
    <div class="kv">
      <div><span>可動用存款</span>${money(r.cash.total)}</div>
      <div><span>預估最低餘額</span>${money(r.low.balance)}<small class="muted"> ${md(r.low.date)}</small></div>
      <div><span>安全存量（${o.reserveMonths} 個月支出）</span>${money(r.reserve)}</div>
      <div><span>現在可投入</span>${money(r.investNow)}</div>
      <div><span>每月可定期投入</span>${money(r.investMonthly)}</div>
    </div>
    ${r.staleAccounts.length ? `<p class="notice small">這些帳戶餘額超過兩週沒更新，結果可能不準：${r.staleAccounts.map((a) => esc(a.name)).join('、')}</p>` : ''}
  </section>

  <section class="block">
    <h2>未來 ${o.horizonDays} 天預估餘額</h2>
    <div id="c-plan"></div>
    <p class="muted small">從目前存款開始，依下列已知收付款與每日生活支出逐日推算。刷卡的生活支出約在 35 天後繳卡費時才扣款。</p>
  </section>

  <section class="block">
    <h2>每月收支</h2>
    <div class="kv">
      <div><span>固定收入</span>${money(r.monthlyIncome)}</div>
      <div><span>固定支出（房租、水電、利息、分期）</span>${money(r.monthlyFixed)}</div>
      <div><span>日常生活支出${r.living.overridden ? '（手動設定）' : `（近 ${r.living.days} 天平均）`}</span>${money(r.living.used)}</div>
      <div><span>每月結餘</span>${money(r.monthlySurplus, { signed: true })}</div>
    </div>
    ${r.living.byCategory.length ? `<details class="table-view"><summary>日常支出組成（每月）</summary><table><tbody>
      ${r.living.byCategory.map((c) => `<tr><td>${esc(c.category)}</td><td class="r">${money(c.monthly)}</td></tr>`).join('')}</tbody></table>
      ${r.living.marked.length ? `<p class="muted small">標為「非日常支出」的 ${r.living.marked.length} 筆（${formatMoney(r.living.markedTotal)}）不列入平均：${r.living.marked.map((t) => `${md(t.date)} ${esc(t.merchant)} ${formatMoney(t.amount)}`).join('、')}</p>` : ''}
      ${r.living.oneOffs.length ? `<p class="muted small">超過 ${formatMoney(o.oneOffThreshold)} 元的一次性支出不列入平均：${r.living.oneOffs.map((t) => `${esc(t.merchant)} ${formatMoney(t.amount)}`).join('、')}</p>` : ''}</details>` : ''}
    ${r.monthlySurplus < 0 ? '<p class="muted small">每月支出高於固定收入。補助、回饋等不固定的收入沒有算進來，可以在「待繳」頁新增固定收入；或調整下方的日常支出估計。</p>' : ''}
  </section>

  ${r.allocation.length ? `<section class="block"><h2>依目前持股比例分配</h2>
    <p class="muted small">只是把可投入金額照現有持股市值比例分配的參考，不是買賣建議。</p>
    <table><thead><tr><th>標的</th><th class="r">比例</th><th class="r">金額</th></tr></thead><tbody>
    ${r.allocation.map((a) => `<tr><td>${esc(a.name)} <span class="muted small">${esc(a.symbol)}</span></td><td class="r num">${(a.weight * 100).toFixed(1)}%</td><td class="r">${money(a.amount)}</td></tr>`).join('')}
    </tbody></table></section>` : ''}

  <section class="block">
    <h2>已知的收付款</h2>
    ${r.flows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>日期</th><th>項目</th><th class="r">金額</th></tr></thead><tbody>${flowRows}</tbody></table></div>` : '<p class="muted small">沒有已知的收付款。</p>'}
  </section>

  <section class="block">
    <div class="block-head"><h2>計算方式</h2><button class="btn ghost sm" id="p-set">調整</button></div>
    <p class="muted small">推算 ${o.horizonDays} 天；安全存量為 ${o.reserveMonths} 個月的固定支出加日常支出；日常支出${r.living.overridden ? `手動設定為每月 ${formatMoney(o.livingMonthly)}` : '取近期實際平均'}；${o.includeIncome ? '計入' : '不計入'}預期的固定收入。
    結果是依帳本資料估算的現金流，不是投資建議。</p>
  </section>`;

  lineChart(root.querySelector('#c-plan'), r.timeline.map((t) => ({ x: t.date, y: t.balance })), { label: '預估餘額' });
  root.querySelector('#p-set').onclick = () => editPlanSettings(r);
  wireForecast(root, () => renderPlan(root));
}

async function editPlanSettings(r) {
  const cur = { ...PLAN_DEFAULTS, ...(store.ledger.settings.plan || {}) };
  const v = await formDialog({
    title: '投資規劃的計算方式',
    fields: [
      { key: 'horizonDays', label: '推算天數', type: 'number', step: 1, hint: '至少涵蓋下一次薪資與各卡繳款日，建議 60～90 天。' },
      { key: 'reserveMonths', label: '安全存量（幾個月的支出）', type: 'number', step: 0.5, hint: '最低點之外一定要留的錢；一般建議 3～6 個月，資金較緊時可先設 1。' },
      { key: 'livingMonthly', label: '每月日常支出（留空＝自動）', type: 'number', hint: `目前自動估計為每月 ${formatMoney(r.living.monthly)}。` },
      { key: 'oneOffThreshold', label: '一次性大額支出門檻', type: 'number', hint: '單筆超過這個金額的消費不列入日常支出平均。' },
      { key: 'includeIncome', label: '計入預期的固定收入（薪資）', type: 'checkbox' },
    ],
    values: cur,
  });
  if (!v) return;
  store.commit((l) => {
    l.settings = { ...l.settings, plan: {
      horizonDays: Math.max(14, Math.min(365, Number(v.horizonDays) || PLAN_DEFAULTS.horizonDays)),
      reserveMonths: Math.max(0, Number(v.reserveMonths) || 0),
      livingMonthly: v.livingMonthly === null || v.livingMonthly === '' ? null : Number(v.livingMonthly),
      oneOffThreshold: Number(v.oneOffThreshold) || PLAN_DEFAULTS.oneOffThreshold,
      includeIncome: !!v.includeIncome,
    } };
  });
  toast('已更新計算方式');
}
