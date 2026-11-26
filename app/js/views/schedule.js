// 備款時程：by which date does how much money have to be ready, and for which payments.
// Day by day from the cash in bank accounts: known payments out, fixed income in (core/schedule.js).
import { store } from '../store.js';
import { paymentSchedule, yearEnd } from '../core/schedule.js';
import { formatMoney, ymd, daysBetween } from '../core/util.js';
import { esc, money, emptyState } from '../ui.js';

const RANGES = [['30', '30 天'], ['60', '60 天'], ['90', '90 天'], ['year', '到年底']];
const state = { range: '60' };
const KIND = { card: '卡費', installment: '分期', bill: '待繳', income: '入帳', loan: '貸款', iou: '還款' };
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const wd = (d) => `週${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}`;

function headline(s, days) {
  const first = s.first;
  if (!first) {
    return ['ok', `未來 ${days} 天不需要補錢`, `已知的繳款都付得出來，最低餘額 ${formatMoney(s.low.balance)}（${md(s.low.date)}）。`];
  }
  const atStart = s.rows.find((r) => r.date === first.start).shortfall;
  const parts = [`${md(first.start)}（${wd(first.start)}）付完款後存款會剩 ${formatMoney(-atStart)}。`];
  const more = first.amount > atStart ? `${first.end ? `${md(first.end)} 入帳前` : '期間內'}累計最多缺 ${formatMoney(first.amount)}（${md(first.lowDate)}），` : '';
  parts.push(first.end ? `${more}${more ? '' : `${md(first.end)} `}入帳後補回。` : `${more}期間內沒有補回。`);
  if (s.episodes.length > 1) parts.push(`期間內共有 ${s.episodes.length} 段缺口，累計要再備 ${formatMoney(s.totalNeed)}。`);
  return ['crit', `${md(first.start)} 前要再備 ${formatMoney(atStart)} 元`, parts.join('')];
}

const tags = (i) => [
  i.estimated ? '<span class="tag">估計</span>' : '',
  i.dateGuess ? '<span class="tag warn">日期是估的</span>' : '',
  i.shifted ? `<span class="tag">原 ${md(i.dueDate)}</span>` : '',
  i.overdue ? `<span class="tag crit">已逾期（${md(i.overdue)}）</span>` : '',
].filter(Boolean).join(' ');

const itemHtml = (i) => `<div class="sched-item"><span>${esc(i.label)} <span class="muted small sched-kind">${KIND[i.kind] || ''}</span> ${tags(i)}</span>
  <span class="num ${i.amount > 0 ? 'inc' : ''}">${i.amount > 0 ? '+' : ''}${esc(formatMoney(i.amount))}</span></div>`;

function rowHtml(r, today) {
  return `<tr class="sched-row${r.outflow > 0 && r.low < 0 ? ' short' : ''}">
    <td class="num"><strong>${md(r.date)}</strong><br><small class="muted">${wd(r.date)}${r.date === today ? '・今天' : ''}</small></td>
    <td>${r.items.map(itemHtml).join('')}</td>
    <td class="r ${r.balance < 0 ? 'neg-strong' : ''}">${money(r.balance)}${r.raise ? `<br><span class="tag crit">要再備 ${esc(formatMoney(r.raise))}</span>` : ''}</td>
  </tr>`;
}

export function renderSchedule(root) {
  const today = ymd();
  const s = paymentSchedule(store.ledger, store.prices, today, state.range === 'year' ? { until: yearEnd(today) } : { horizonDays: Number(state.range) });
  const days = daysBetween(today, s.until);
  const [level, title, text] = headline(s, days);

  const range = `<div class="seg" role="group" aria-label="範圍">${RANGES.map(([k, label]) =>
    `<button class="btn sm ${state.range === k ? 'primary' : 'ghost'}" data-range="${k}" aria-pressed="${state.range === k}">${label}</button>`).join('')}</div>`;

  if (!s.rows.length && !s.cash.total) {
    root.innerHTML = emptyState('還沒有可動用的存款，也沒有待繳款項。先到「帳戶與資產」新增帳戶、「待繳」新增房租等項目，這裡就會列出各個繳款日要備多少錢。');
    return;
  }

  root.innerHTML = `
  <section class="block plan-verdict lv-${level}">
    <div class="block-head"><h2>${esc(title)}</h2>${range}</div>
    <p>${esc(text)}</p>
    <div class="kv">
      <div><span>可動用存款</span>${money(s.cash.total)}</div>
      <div><span>${md(today)}～${md(s.until)} 要繳</span>${money(s.outflowTotal)}</div>
      <div><span>期間入帳</span>${money(s.inflowTotal)}</div>
      ${s.estimatedTotal ? `<div><span>其中估計的卡費</span>${money(s.estimatedTotal)}</div>` : ''}
    </div>
    ${s.warnings.guessed.length ? `<p class="notice small">${s.warnings.guessed.map(esc).join('、')} 沒設結帳日或繳款日，日期是估的。到<a href="#/cards">信用卡</a>頁設定後會更準。</p>` : ''}
    ${s.warnings.staleAccounts.length ? `<p class="notice small">這些帳戶餘額超過兩週沒更新，結果可能不準：${s.warnings.staleAccounts.map((a) => esc(a.name)).join('、')}</p>` : ''}
  </section>

  <section class="block">
    <h2>繳款時程</h2>
    ${s.rows.length ? `<div class="tbl-wrap"><table class="tbl sched"><thead><tr><th>備款日</th><th>項目</th><th class="r">繳完後餘額</th></tr></thead>
      <tbody>${s.rows.map((r) => rowHtml(r, today)).join('')}</tbody></table></div>` : '<p class="muted">這段期間沒有已知的繳款或入帳。</p>'}
    <p class="muted small">從目前可動用存款（銀行、現金、電子錢包）起算，依日期逐筆扣除已知的繳款、加上每月固定收入。「要再備」是到這天為止，為了讓餘額不低於 0 還需要再補的錢；先前補的錢會留在帳戶裡，所以後面的缺口只算差額。</p>
    <p class="muted small">不含日常生活費與預估獎金。繳款截止日落在週六、週日的，提前到前一個週五；國定假日不會自動判斷。「估計」是還沒出帳的卡費，帳單出來後金額會變。同一天先扣款再計入帳，結果偏保守。</p>
  </section>`;

  root.querySelectorAll('[data-range]').forEach((b) => (b.onclick = () => { state.range = b.dataset.range; renderSchedule(root); }));
}
