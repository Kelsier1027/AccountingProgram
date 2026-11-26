import { store } from '../store.js';
import { cashForecast } from '../core/forecast.js';
import { paymentAlert } from '../core/schedule.js';
import { totals, monthSummary, billStatus, snapshotOf, issuerUsage, statementIssuerId, isIncomeItem, isPayable, incomeStatus } from '../core/calc.js';
import { live } from '../core/model.js';
import { findMatches } from '../core/match.js';
import { ymd, ym, daysBetween, formatMoney } from '../core/util.js';
import { esc, money } from '../ui.js';
import { lineChart, stackBar, barList } from '../charts.js';
import { stampHtml } from './common.js';

export function renderOverview(root) {
  const L = store.ledger;
  const P = store.prices;
  const t = totals(L, P);
  const today = ymd();
  const month = ym(today);
  const ms = monthSummary(L, month);
  const mergedCount = live(L.links).length;

  // reminders
  const todo = [];
  for (const b of live(L.bills).filter(isIncomeItem)) {
    const s = incomeStatus(L, b, today);
    if (s.state === 'late') todo.push({ level: 'info', text: `${b.name}（${Number(s.period.slice(5))} 月）還沒入帳，預計 ${s.dueDate}`, href: '#/bills' });
  }
  // cash running short in the coming months (conservative: salary and certain items only)
  const fc = cashForecast(L, P, today, { scenario: 'conservative' });
  if (fc.need) {
    const soon = daysBetween(today, fc.need.start) <= 45;
    todo.push({ level: soon ? 'critical' : 'warning', text: `預計 ${fc.need.start} 起存款不足，未來一年最多缺約 ${formatMoney(Math.ceil(fc.need.amount / 1000) * 1000)}`, href: '#/plan' });
  }
  // known payments that the cash in the bank cannot cover soon (備款時程)
  const pay = paymentAlert(L, P, today, 30);
  if (pay) {
    const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
    todo.push({ level: pay.days <= 7 ? 'critical' : 'warning', text: `${md(pay.start)} 前需備款約 ${formatMoney(Math.ceil(pay.amount / 100) * 100)} 元（${pay.days <= 0 ? '今天' : `${pay.days} 天後`}）`, href: '#/schedule' });
  }
  for (const b of live(L.bills).filter(isPayable)) {
    const s = billStatus(b, today);
    const what = `${b.name}（${Number(s.period.slice(5))} 月）${formatMoney(b.amount)}`;
    if (s.state === 'overdue') todo.push({ level: 'critical', text: `${what} 已逾期（${s.dueDate}）`, href: '#/bills' });
    else if (s.state === 'due') todo.push({ level: 'warning', text: `${what} 請在 ${s.dueDate} 前繳`, href: '#/bills' });
  }
  for (const s of live(L.statements)) {
    const unpaid = (Number(s.total) || 0) - (Number(s.paidAmount) || 0);
    if (unpaid <= 0 || !s.dueDate) continue;
    const bank = L.issuers.find((i) => i.id === statementIssuerId(L, s))?.name || L.cards.find((c) => c.id === s.cardId)?.name || '信用卡';
    const d = daysBetween(today, s.dueDate);
    if (d < 0) todo.push({ level: 'critical', text: `${bank} 卡費 ${formatMoney(unpaid)} 已逾期`, href: '#/cards' });
    else if (d <= 10) todo.push({ level: 'warning', text: `${bank} 卡費 ${formatMoney(unpaid)}，${d} 天後到期`, href: '#/cards' });
  }
  for (const iss of live(L.issuers)) {
    const u = issuerUsage(L, iss.id);
    if (u.ratio === null || !u.cards.length) continue;
    if (u.ratio >= 1) todo.push({ level: 'critical', text: `${iss.name} 信用卡已超過共用額度（已用 ${formatMoney(u.used)}／${formatMoney(u.limit)}）`, href: '#/cards' });
    else if (u.ratio >= 0.8) todo.push({ level: 'warning', text: `${iss.name} 共用額度已用 ${Math.round(u.ratio * 100)}%，剩 ${formatMoney(u.available)}`, href: '#/cards' });
  }
  const m = findMatches(L);
  if (m.auto.length + m.suggested.length) todo.push({ level: 'info', text: `${m.auto.length + m.suggested.length} 筆刷卡與載具可以合併`, href: '#/match' });
  for (const i of live(L.ious)) {
    if (!i.settled && i.dueDate && i.dueDate < today) todo.push({ level: 'warning', text: `${i.person}：${i.direction === 'owedToMe' ? '應收' : '應還'}款項已過約定日`, href: '#/ious' });
  }

  const snaps = live(L.snapshots).filter((s) => s.date !== today).sort((a, b) => a.date.localeCompare(b.date));
  const trend = [...snaps, snapshotOf(L, P, today)].map((s) => ({ x: s.date, y: s.netWorth }));

  const quoteNote = P.updatedAt ? `股價更新於 ${new Date(P.updatedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })}` : '尚無股價，股票以成本計算';

  root.innerHTML = `
  <section class="passbook" aria-label="淨值">
    <div class="pb-row pb-head"><span>日期</span><span>摘要</span><span class="r">金額</span></div>
    <div class="pb-row pb-main">
      <span class="num">${today.replaceAll('-', '/')}</span>
      <span>淨值</span>
      <span class="r hero num">${esc(formatMoney(t.netWorth))}</span>
    </div>
    <div class="pb-row"><span></span><span>資產合計</span><span class="r">${money(t.assets)}</span></div>
    <div class="pb-row"><span></span><span>短期負債</span><span class="r">${money(-t.shortTerm)}</span></div>
    ${t.longTerm ? `<div class="pb-row"><span></span><span>長期負債<span class="muted small">（學貸等，不計入淨值）</span></span><span class="r">${money(-t.longTerm)}</span></div>
    <div class="pb-row"><span></span><span>含長期負債淨值</span><span class="r">${money(t.netWorthAll)}</span></div>` : ''}
    ${stampHtml()}
  </section>

  ${todo.length ? `<section class="block"><h2>待辦</h2><ul class="todo">${todo
    .map((x) => `<li class="lv-${x.level}"><a href="${x.href}"><span class="dot" aria-hidden="true"></span>${esc(x.text)}</a></li>`)
    .join('')}</ul></section>` : ''}

  <section class="block">
    <h2>資產組成</h2>
    <div id="c-comp"></div>
    <div class="kv">
      <div><span>股票未實現損益</span>${money(t.stockPnl, { signed: true })}</div>
      <div><span>短期貸款（分期等）</span>${money(t.loansShort)}</div>
      <div><span>長期貸款</span>${money(t.loansLong)}</div>
      <div><span>未繳卡費</span>${money(t.cards)}</div>
      <div><span>我欠別人</span>${money(t.payables)}</div>
    </div>
    <p class="muted small">${esc(quoteNote)}</p>
  </section>

  <section class="block">
    <div class="block-head"><h2>${month.replace('-', ' 年 ')} 月支出</h2><a class="btn ghost sm" href="#/tx">看明細</a></div>
    <div class="kv">
      <div><span>支出</span>${money(ms.expense)}</div>
      <div><span>收入</span>${money(ms.income)}</div>
      <div><span>結餘</span>${money(ms.income - ms.expense, { signed: true })}</div>
    </div>
    <div id="c-cat"></div>
    <p class="muted small">已合併 ${mergedCount} 組刷卡與載具重複記錄，只算一次。</p>
    <details class="table-view"><summary>以表格檢視</summary>
      <table><thead><tr><th>類別</th><th class="r">金額</th></tr></thead><tbody>
      ${ms.byCategory.map((c) => `<tr><td>${esc(c.category)}</td><td class="r">${money(c.amount)}</td></tr>`).join('')}
      </tbody></table></details>
  </section>

  <section class="block">
    <h2>淨值趨勢</h2>
    <div id="c-trend"></div>
    <details class="table-view"><summary>以表格檢視</summary>
      <table><thead><tr><th>日期</th><th class="r">資產</th><th class="r">負債</th><th class="r">淨值</th></tr></thead><tbody>
      ${[...snaps].reverse().slice(0, 24).map((s) => `<tr><td>${esc(s.date)}</td><td class="r">${money(s.assets)}</td><td class="r">${money(s.liabilities)}</td><td class="r">${money(s.netWorth)}</td></tr>`).join('')}
      </tbody></table></details>
  </section>`;

  stackBar(root.querySelector('#c-comp'), [
    { label: '存款與現金', value: t.accounts, color: '--series-1' },
    { label: '股票', value: t.stocks, color: '--series-2' },
    { label: '其他資產', value: t.otherAssets, color: '--series-3' },
    { label: '應收借款', value: t.receivables, color: '--series-4' },
  ]);
  barList(root.querySelector('#c-cat'), ms.byCategory.map((c) => ({ label: c.category, value: c.amount })), { color: '--brand' });
  lineChart(root.querySelector('#c-trend'), trend);
}
