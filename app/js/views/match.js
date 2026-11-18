import { store } from '../store.js';
import { live } from '../core/model.js';
import { findMatches, applyLink, unlink } from '../core/match.js';
import { daysBetween } from '../core/util.js';
import { cardLabel } from '../core/calc.js';
import { esc, money, toast, customDialog, emptyState, $ } from '../ui.js';

const txLine = (t) => t ? `<span class="num">${esc(t.date)}</span> ${esc(t.merchant || '（無說明）')} ${money(t.amount)}${t.source === 'card' ? ` <span class="card-ref">${esc(cardLabel(store.ledger, t))}</span>` : ''}` : '（已刪除）';

export function renderMatch(root) {
  const L = store.ledger;
  const r = findMatches(L);
  const get = (id) => L.transactions.find((t) => t.id === id);
  const links = live(L.links).sort((a, b) => (get(b.cardTxId)?.date || '').localeCompare(get(a.cardTxId)?.date || ''));
  const ageTag = (d) => (d > 60 ? `<span class="tag warn">${d} 天</span>` : `<span class="muted num">${d} 天</span>`);

  const proposal = (p, i, kind) => `
    <li class="pair">
      <div class="pair-side"><span class="tag src-card">刷卡</span>${txLine(get(p.cardTxId))}</div>
      ${p.otherTxIds.map((id) => `<div class="pair-side"><span class="tag src-${get(id)?.source}">${get(id)?.source === 'invoice' ? '載具' : get(id)?.source === 'bill' ? '繳費' : '手動'}</span>${txLine(get(id))}</div>`).join('')}
      <div class="pair-meta">
        <span class="muted small">相符度 ${Math.round(p.score * 100)}%｜日期差 ${p.days} 天｜名稱相似 ${Math.round(p.nameSim * 100)}%${p.kind === 'split' ? '｜一次刷卡、多張發票' : p.kind === 'fee' ? '｜外送平台費發票（刷卡金額含餐點）' : ''}</span>
        <button class="btn primary sm" data-accept="${kind}:${i}">合併</button>
      </div>
    </li>`;

  root.innerHTML = `
  <p class="intro">同一筆消費可能同時出現在信用卡明細與載具發票裡。合併後，支出只以刷卡那筆計算，類別與品項則沿用發票。</p>
  <div class="kv">
    <div><span>可自動合併</span><span class="num">${r.auto.length}</span></div>
    <div><span>待確認</span><span class="num">${r.suggested.length}</span></div>
    <div><span>只有刷卡</span><span class="num">${r.cardOnly.length}</span></div>
    <div><span>只有發票／手記</span><span class="num">${r.otherOnly.length}</span></div>
  </div>
  <div class="toolbar">
    <button class="btn primary" id="m-auto" ${r.auto.length ? '' : 'disabled'}>合併 ${r.auto.length} 筆高信心配對</button>
  </div>

  ${r.auto.length ? `<section class="block"><h2>高信心配對</h2><p class="muted small">金額相同、日期接近，而且只有這一個候選。</p><ul class="pairs">${r.auto.map((p, i) => proposal(p, i, 'auto')).join('')}</ul></section>` : ''}
  ${r.suggested.length ? `<section class="block"><h2>請確認</h2><p class="muted small">金額相符，但有多個候選、名稱差異大，或是由多張發票組成。</p><ul class="pairs">${r.suggested.map((p, i) => proposal(p, i, 'sug')).join('')}</ul></section>` : ''}

  <section class="block">
    <h2>只有刷卡</h2>
    <p class="muted small">可能是沒有索取發票、國外消費或訂閱服務。屬於正常差異的不需要處理；若找得到對應的發票或手記，可以手動合併。</p>
    ${r.cardOnly.length ? `<ul class="rows">${r.cardOnly.map(({ tx, age }) => `<li class="row"><div class="row-main"><span class="row-title">${esc(tx.merchant)}</span><span class="row-sub num">${esc(tx.date)} · <span class="card-ref">${esc(cardLabel(L, tx))}</span> · ${ageTag(age)}</span></div>
      <span class="row-amt">${money(tx.amount)}</span><button class="btn ghost sm" data-manual="${tx.id}">手動合併</button></li>`).join('')}</ul>` : emptyState('沒有未配對的刷卡交易。')}
  </section>

  <section class="block">
    <h2>只有發票／手記</h2>
    <p class="muted small">通常是現金或行動支付付款，或刷卡還沒入帳（1–3 天內屬正常的時間差）。用現金付的，可以把付款方式改成「現金」，之後就不會出現在這裡。</p>
    ${r.otherOnly.length ? `<ul class="rows">${r.otherOnly.slice(0, 80).map(({ tx, age }) => `<li class="row"><div class="row-main"><span class="row-title">${esc(tx.merchant)}</span><span class="row-sub num">${esc(tx.date)} · ${ageTag(age)}</span></div>
      <span class="row-amt">${money(tx.amount)}</span><button class="btn ghost sm" data-cash="${tx.id}">標為現金</button></li>`).join('')}</ul>` : emptyState('沒有未配對的發票。')}
  </section>

  <section class="block">
    <h2>已合併（${links.length}）</h2>
    ${links.length ? `<ul class="pairs">${links.slice(0, 100).map((l) => `<li class="pair done">
      <div class="pair-side"><span class="tag src-card">刷卡</span>${txLine(get(l.cardTxId))}</div>
      ${(l.otherTxIds || []).map((id) => `<div class="pair-side"><span class="tag">併入</span>${txLine(get(id))}</div>`).join('')}
      <div class="pair-meta"><span class="muted small">${l.method === 'auto' ? '自動' : '手動'}</span><button class="btn ghost sm" data-unlink="${l.id}">解除</button></div></li>`).join('')}</ul>` : emptyState('還沒有合併任何記錄。')}
  </section>`;

  $('#m-auto', root).onclick = () => {
    const n = store.commit((l) => { r.auto.forEach((p) => applyLink(l, { ...p, method: 'auto' })); return r.auto.length; });
    toast(`已合併 ${n} 筆`);
  };
  root.querySelectorAll('[data-accept]').forEach((b) => (b.onclick = () => {
    const [kind, i] = b.dataset.accept.split(':');
    const p = (kind === 'auto' ? r.auto : r.suggested)[Number(i)];
    try {
      store.commit((l) => applyLink(l, { ...p, method: kind === 'auto' ? 'auto' : 'manual' }));
      toast('已合併');
    } catch (e) { toast(e.message, 'error'); }
  }));
  root.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = () => { store.commit((l) => unlink(l, b.dataset.unlink)); toast('已解除合併'); }));
  root.querySelectorAll('[data-cash]').forEach((b) => (b.onclick = () => {
    store.commit((l) => { const t = l.transactions.find((x) => x.id === b.dataset.cash); t.paymentMethod = 'cash'; t.updatedAt = new Date().toISOString(); });
    toast('已標為現金付款');
  }));
  root.querySelectorAll('[data-manual]').forEach((b) => (b.onclick = () => manualMatch(get(b.dataset.manual))));
}

function manualMatch(card) {
  const cands = live(store.ledger.transactions)
    .filter((t) => t.source !== 'card' && t.type !== 'income' && !t.linkId && Math.abs(daysBetween(card.date, t.date)) <= 10)
    .sort((a, b) => Math.abs(a.amount - card.amount) - Math.abs(b.amount - card.amount) || Math.abs(daysBetween(card.date, a.date)) - Math.abs(daysBetween(card.date, b.date)))
    .slice(0, 40);
  return customDialog(`<div class="form"><h2>手動合併</h2>
    <p class="intro">刷卡：${txLine(card)}<br>勾選要併入這筆刷卡的發票或手記（前後 10 天內）。</p>
    ${cands.length ? `<ul class="checklist">${cands.map((t) => `<li><label class="check"><input type="checkbox" value="${t.id}" data-amt="${t.amount}"> ${txLine(t)}</label></li>`).join('')}</ul>` : '<p class="muted">前後 10 天內沒有可配對的記錄。</p>'}
    <p class="muted small" id="mm-sum"></p>
    <div class="actions"><span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-ok disabled>合併</button></div></div>`,
  (dlg, close) => {
    const boxes = [...dlg.querySelectorAll('input[type=checkbox]')];
    const upd = () => {
      const chosen = boxes.filter((b) => b.checked);
      const total = chosen.reduce((s, b) => s + Number(b.dataset.amt), 0);
      $('#mm-sum', dlg).innerHTML = chosen.length ? `已選 ${chosen.length} 筆，合計 ${money(total)}（刷卡 ${money(card.amount)}${total !== card.amount ? '，金額不同，將以刷卡金額為準' : ''}）` : '';
      $('[data-ok]', dlg).disabled = !chosen.length;
    };
    boxes.forEach((b) => (b.onchange = upd));
    $('[data-ok]', dlg).onclick = () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      try {
        store.commit((l) => applyLink(l, { cardTxId: card.id, otherTxIds: ids, method: 'manual' }));
        toast('已合併');
        close(true);
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}
