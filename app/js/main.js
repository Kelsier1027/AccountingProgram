import { store } from './store.js';
import { $, $$, esc, customDialog, toast } from './ui.js';
import { renderOverview } from './views/overview.js';
import { renderTransactions } from './views/transactions.js';
import { renderMatch } from './views/match.js';
import { renderCards } from './views/cards.js';
import { renderStocks } from './views/stocks.js';
import { renderAccounts, renderBills, renderLoans, renderIous } from './views/simple.js';
import { renderSettings } from './views/settings.js';
import { renderPlan } from './views/plan.js';
import { renderSchedule } from './views/schedule.js';
import { stampHtml, syncPillHtml } from './views/common.js';

const ROUTES = {
  overview: ['總覽', renderOverview],
  tx: ['收支', renderTransactions],
  match: ['對帳', renderMatch],
  cards: ['信用卡', renderCards],
  stocks: ['股票', renderStocks],
  plan: ['現金流規劃', renderPlan],
  schedule: ['備款時程', renderSchedule],
  accounts: ['帳戶與資產', renderAccounts],
  bills: ['待繳', renderBills],
  loans: ['債務', renderLoans],
  ious: ['借貸', renderIous],
  settings: ['設定', renderSettings],
};
const TABS = ['overview', 'tx', 'match', 'stocks'];
const GROUPS = [
  ['', ['overview', 'tx', 'match']],
  ['資產', ['accounts', 'stocks', 'plan', 'schedule']],
  ['負債與待繳', ['cards', 'bills', 'loans', 'ious']],
  ['', ['settings']],
];
const navHtml = () =>
  GROUPS.map(([g, rs]) => `${g ? `<p class="nav-group">${g}</p>` : '<hr>'}${rs.map((r) => `<a href="#/${r}" data-route="${r}">${ROUTES[r][0]}</a>`).join('')}`).join('');

const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview');

function render() {
  let r = route();
  if (!ROUTES[r]) r = 'overview';
  const [title, fn] = ROUTES[r];
  document.title = `${title}｜記帳本`;
  $('#page-title').textContent = title;
  $$('[data-route]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.route === r));
  $('#more-tab').toggleAttribute('aria-current', !TABS.includes(r));
  const view = $('#view');
  // keep scroll position when re-rendering the same page after an edit
  const sameRoute = view.dataset.route === r;
  const y = window.scrollY;
  view.dataset.route = r;
  try {
    fn(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<p class="notice crit">這個頁面發生錯誤：${esc(e.message)}</p>`;
  }
  if (sameRoute) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  updateStatus();
}

function updateStatus() {
  $('#sync-slot').innerHTML = syncPillHtml();
  // also refresh the stamp inside the passbook if present
  const inner = $('#view .passbook .stamp');
  if (inner) inner.outerHTML = stampHtml();
}

function applyPrefs() {
  const theme = localStorage.getItem('acct.theme');
  if (theme && theme !== 'auto') document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.up = store.ledger.settings.upColor === 'green' ? 'green' : 'red';
}

store.askPassphrase = (retry) =>
  customDialog(`<form class="form" method="dialog"><h2>輸入帳本密碼</h2>
    <p class="intro">${retry ? '密碼不正確，請再試一次。' : '這份帳本已加密。'}</p>
    <div class="fields"><div class="field wide"><label for="pp">密碼</label><input id="pp" type="password" autocomplete="current-password" required></div>
    <div class="field wide"><label class="check"><input type="checkbox" id="pp-r"> 在這台裝置記住</label></div></div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn ghost" data-cancel>取消</button><button class="btn primary">解鎖</button></div></form>`,
  (dlg, close) => {
    $('form', dlg).onsubmit = (e) => {
      e.preventDefault();
      const p = $('#pp', dlg).value;
      if ($('#pp-r', dlg).checked) localStorage.setItem('acct.pass', JSON.stringify(p));
      close(p);
    };
    setTimeout(() => $('#pp', dlg).focus(), 50);
  });

store.addEventListener('change', () => {
  applyPrefs();
  if (!$('#dlg').open) render();
});
store.addEventListener('status', updateStatus);
window.addEventListener('hashchange', render);
window.addEventListener('online', () => store.remoteEnabled && store.sync().catch(() => {}));
window.addEventListener('offline', () => store.setStatus('offline'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.remoteEnabled && store.status !== 'syncing') store.sync().catch(() => {});
});
// Re-render the open page once a dialog closes (edits are committed while it is open).
$('#dlg').addEventListener('close', () => setTimeout(render, 0));

$('#side-nav').innerHTML = navHtml();
$('#tabbar').innerHTML = `${TABS.map((r) => `<a href="#/${r}" data-route="${r}">${ROUTES[r][0]}</a>`).join('')}<button id="more-tab" type="button">更多</button>`;
$('#more-tab').onclick = () =>
  customDialog(
    `<nav class="form more-nav" aria-label="所有頁面"><h2>所有頁面</h2>${navHtml()}
     <div class="actions"><span class="spacer"></span><button class="btn ghost" data-cancel>關閉</button></div></nav>`,
    (dlg, close) => $$('a', dlg).forEach((a) => (a.onclick = () => close(true))),
  );

applyPrefs();
render();
if (store.remoteEnabled) {
  store.sync().catch((e) => toast(`同步失敗：${e.message}`, 'error'));
} else {
  store.setStatus('local');
  const firstRun = !store.ledger.accounts.length && !store.ledger.transactions.length;
  if (firstRun && route() === 'overview') {
    $('#view').insertAdjacentHTML('afterbegin', `<p class="notice">歡迎！目前資料只存在這台裝置。到 <a href="#/settings">設定</a> 連接私有 GitHub repo，就能在手機和其他電腦上看到同一份帳本；也可以先載入範例資料試用。</p>`);
  }
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
