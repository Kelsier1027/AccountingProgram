// Small DOM helpers: escaping, money formatting, toast, form dialogs.
import { formatMoney } from './core/util.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Money as HTML with tabular figures; `signed` adds a sign class for P/L. */
export function money(n, opts = {}) {
  const cls = ['num'];
  if (opts.signed) cls.push(n > 0 ? 'up' : n < 0 ? 'down' : '');
  const txt = (opts.signed && n > 0 ? '+' : '') + formatMoney(n, opts);
  return `<span class="${cls.join(' ')}">${esc(txt)}</span>`;
}

export function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3000);
}

function fieldHtml(f, value) {
  const id = `f_${f.key}`;
  const v = value ?? f.default ?? '';
  const req = f.required ? 'required' : '';
  const hint = f.hint ? `<small class="hint">${esc(f.hint)}</small>` : '';
  let input;
  if (f.type === 'select') {
    const opts = (typeof f.options === 'function' ? f.options() : f.options) || [];
    input = `<select id="${id}" name="${f.key}" ${req}>${opts
      .map(([val, label]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(label)}</option>`)
      .join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.key}" rows="3" ${req}>${esc(v)}</textarea>`;
  } else if (f.type === 'checkbox') {
    return `<label class="check"><input type="checkbox" id="${id}" name="${f.key}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>${hint}`;
  } else {
    const t = f.type || 'text';
    const extra = t === 'number' ? `step="${f.step ?? 'any'}" inputmode="decimal"` : '';
    const list = f.datalist ? `list="${id}_dl"` : '';
    const dl = f.datalist ? `<datalist id="${id}_dl">${f.datalist.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : '';
    input = `<input id="${id}" name="${f.key}" type="${t}" value="${esc(v)}" ${extra} ${list} ${req} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} autocomplete="off">${dl}`;
  }
  return `<label for="${id}">${esc(f.label)}</label>${input}${hint}`;
}

/**
 * Show a form in the shared <dialog>. Resolves with the values (numbers parsed) or null when cancelled.
 * extraButtons: [{ label, value, danger }] — resolves { __action: value } when clicked.
 */
export function formDialog({ title, fields, values = {}, submitLabel = '儲存', extraButtons = [], intro = '' }) {
  const dlg = $('#dlg');
  dlg.innerHTML = `
    <form method="dialog" class="form">
      <h2>${esc(title)}</h2>
      ${intro ? `<p class="intro">${intro}</p>` : ''}
      <div class="fields">${fields.map((f) => `<div class="field ${f.wide ? 'wide' : ''}">${fieldHtml(f, values[f.key])}</div>`).join('')}</div>
      <p class="form-error" role="alert"></p>
      <div class="actions">
        ${extraButtons.map((b, i) => `<button type="button" class="btn ${b.danger ? 'danger' : 'ghost'}" data-extra="${i}">${esc(b.label)}</button>`).join('')}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-cancel>取消</button>
        <button type="submit" class="btn primary">${esc(submitLabel)}</button>
      </div>
    </form>`;
  return new Promise((resolve) => {
    const form = $('form', dlg);
    const done = (v) => {
      dlg.close();
      resolve(v);
    };
    $('[data-cancel]', dlg).onclick = () => done(null);
    $$('[data-extra]', dlg).forEach((b) => (b.onclick = () => done({ __action: extraButtons[b.dataset.extra].value })));
    dlg.oncancel = (e) => {
      e.preventDefault();
      done(null);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const el = form.elements[f.key];
        if (!el) continue;
        if (f.type === 'checkbox') out[f.key] = el.checked;
        else if (f.type === 'number') out[f.key] = el.value === '' ? null : Number(el.value);
        else out[f.key] = el.value.trim();
      }
      if (typeof fields.validate === 'function') {
        const err = fields.validate(out);
        if (err) {
          $('.form-error', dlg).textContent = err;
          return;
        }
      }
      done(out);
    };
    dlg.showModal();
    const first = $('input:not([type=checkbox]),select,textarea', dlg);
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  });
}

/** A dialog with custom body HTML. `setup(dlg, close)` wires events. */
export function customDialog(html, setup) {
  const dlg = $('#dlg');
  dlg.innerHTML = html;
  return new Promise((resolve) => {
    const close = (v) => {
      dlg.close();
      resolve(v);
    };
    dlg.oncancel = (e) => {
      e.preventDefault();
      close(null);
    };
    $$('[data-cancel]', dlg).forEach((b) => (b.onclick = () => close(null)));
    setup?.(dlg, close);
    dlg.showModal();
  });
}

export async function confirmDialog(message, okLabel = '確定', danger = false) {
  return customDialog(
    `<div class="form"><p class="confirm-msg">${esc(message)}</p><div class="actions"><span class="spacer"></span>
     <button class="btn ghost" data-cancel>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div></div>`,
    (dlg, close) => ($('[data-ok]', dlg).onclick = () => close(true)),
  );
}

export const readFileText = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const buf = new Uint8Array(r.result);
      let text = new TextDecoder('utf-8').decode(buf);
      // Taiwanese bank exports are often Big5; fall back when UTF-8 decoding produced replacement chars.
      if (text.includes('�')) {
        try {
          text = new TextDecoder('big5').decode(buf);
        } catch { /* keep utf-8 */ }
      }
      res(text);
    };
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });

export function emptyState(text, actionHtml = '') {
  return `<div class="empty"><p>${esc(text)}</p>${actionHtml}</div>`;
}
