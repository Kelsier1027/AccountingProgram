// Hand-rolled SVG charts following the dataviz skill: one axis, thin marks, recessive grid,
// hover tooltips, colours from CSS custom properties so light/dark are both selected.
import { esc } from './ui.js';
import { formatMoney } from './core/util.js';

const NS = 'http://www.w3.org/2000/svg';

export function shortMoney(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1)}億`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}萬`;
  return `${sign}${Math.round(a).toLocaleString('zh-TW')}`;
}

function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function tooltip(container) {
  let tip = container.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'status');
    container.appendChild(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.style.opacity = '1';
      const w = container.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(w - tw, x - tw / 2))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 12)}px`;
    },
    hide() {
      tip.style.opacity = '0';
    },
  };
}

/** Line chart for a single series over dates. points: [{ x: 'YYYY-MM-DD', y }] */
export function lineChart(container, points, { label = '淨值', height = 200 } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  if (points.length < 2) {
    container.innerHTML = '<p class="muted small">累積兩天以上的同步紀錄後，這裡會顯示趨勢。</p>';
    return;
  }
  const W = Math.max(280, container.clientWidth || 600);
  const H = height;
  const pad = { l: 52, r: 12, t: 12, b: 26 };
  const xs = points.map((p) => Date.parse(p.x));
  const ys = points.map((p) => p.y);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const X = (t) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const fmtDate = (s) => s.slice(0, 7).replace('-', '/');
  const xLabels = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const svg = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(label)}趨勢">
    ${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/>
      <text class="axis" x="${pad.l - 8}" y="${Y(t) + 4}" text-anchor="end">${shortMoney(t)}</text>`).join('')}
    ${xLabels.map((i, k) => `<text class="axis" x="${X(xs[i])}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${fmtDate(points[i].x)}</text>`).join('')}
    <path class="series-line" d="${path}"/>
    <line class="crosshair" y1="${pad.t}" y2="${H - pad.b}" x1="-10" x2="-10"/>
    <circle class="marker" r="4.5" cx="-10" cy="-10"/>
    <rect class="hit" x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent"/>
  </svg>`;
  container.insertAdjacentHTML('afterbegin', svg);
  const el = container.querySelector('svg');
  const tip = tooltip(container);
  const cross = el.querySelector('.crosshair');
  const dot = el.querySelector('.marker');
  const move = (clientX) => {
    const r = el.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    let best = 0;
    xs.forEach((t, i) => {
      if (Math.abs(X(t) - sx) < Math.abs(X(xs[best]) - sx)) best = i;
    });
    container.classList.add('hovering');
    const cx = X(xs[best]);
    const cy = Y(points[best].y);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    tip.show(`<b>${esc(points[best].x)}</b><br>${esc(label)} <span class="num">${formatMoney(points[best].y)}</span>`, (cx / W) * r.width, (cy / H) * r.height);
  };
  const leave = () => {
    container.classList.remove('hovering');
    cross.setAttribute('x1', -10);
    cross.setAttribute('x2', -10);
    dot.setAttribute('cx', -10);
    tip.hide();
  };
  el.addEventListener('pointermove', (e) => move(e.clientX));
  el.addEventListener('pointerdown', (e) => move(e.clientX));
  el.addEventListener('pointerleave', leave);
}

/** 100% stacked horizontal bar with a legend that carries names, values and shares. */
export function stackBar(container, segments) {
  container.classList.add('chart');
  const segs = segments.filter((s) => s.value > 0);
  const total = segs.reduce((t, s) => t + s.value, 0);
  if (!total) {
    container.innerHTML = '<p class="muted small">還沒有資產。</p>';
    return;
  }
  const W = 1000;
  const H = 28;
  const gap = 4;
  let x = 0;
  const avail = W - gap * (segs.length - 1);
  const rects = segs.map((s, i) => {
    const w = Math.max(2, (s.value / total) * avail);
    const r = `<rect class="seg" data-i="${i}" x="${x}" y="0" width="${w}" height="${H}" rx="4" style="fill:var(${s.color})"/>`;
    x += w + gap;
    return r;
  });
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="資產組成">${rects.join('')}</svg>
    <ul class="legend">${segs.map((s) => `<li><i style="background:var(${s.color})"></i><span>${esc(s.label)}</span>
      <span class="num">${formatMoney(s.value)}</span><span class="muted num">${((s.value / total) * 100).toFixed(1)}%</span></li>`).join('')}</ul>`;
  const tip = tooltip(container);
  const svg = container.querySelector('svg');
  container.querySelectorAll('.seg').forEach((el) => {
    const s = segs[el.dataset.i];
    const show = (e) => {
      const r = container.getBoundingClientRect();
      tip.show(`<b>${esc(s.label)}</b><br><span class="num">${formatMoney(s.value)}</span>（${((s.value / total) * 100).toFixed(1)}%）`, e.clientX - r.left, svg.getBoundingClientRect().top - r.top);
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerleave', () => tip.hide());
  });
}

/** Horizontal bars, one series, label on the left and value on the right. */
export function barList(container, rows, { color = '--series-1' } = {}) {
  container.classList.add('chart');
  if (!rows.length) {
    container.innerHTML = '<p class="muted small">這個月還沒有支出。</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.value));
  container.innerHTML = `<div class="bars" role="list">${rows
    .map((r, i) => `<div class="bar-row" role="listitem" data-i="${i}">
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar" style="width:${Math.max(1, (r.value / max) * 100)}%;background:var(${color})"></span></span>
        <span class="num bar-val">${formatMoney(r.value)}</span></div>`)
    .join('')}</div>`;
  const tip = tooltip(container);
  container.querySelectorAll('.bar-row').forEach((el) => {
    const r = rows[el.dataset.i];
    const show = () => {
      const c = container.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      tip.show(`<b>${esc(r.label)}</b><br><span class="num">${formatMoney(r.value)}</span>${r.note ? `<br>${esc(r.note)}` : ''}`, b.left - c.left + b.width / 2, b.top - c.top);
    };
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerleave', () => tip.hide());
  });
}
