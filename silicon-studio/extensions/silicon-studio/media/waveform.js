// Silicon Studio waveform viewer webview. Needs vcd.js (window.SiliconVcd) loaded first.
(function init() {
  'use strict';
  if (document.readyState === 'loading') return document.addEventListener('DOMContentLoaded', init);
  const vscode = acquireVsCodeApi();
  const ROW_H = 22, RULER_H = 26, MIN_PX = 2, MIN_BUS_PX = 6, AUTO_SELECT = 16;
  const RADICES = ['hex', 'bin', 'dec', 'signed'];
  const TEXT_KINDS = new Set(['real', 'realtime', 'shortreal', 'string']);

  const saved = vscode.getState() || {};
  let dump = null, title = '', errMsg = '';
  let traces = (Array.isArray(saved.traces) ? saved.traces : []).filter(t => t && typeof t.id === 'string'); // [{ id, radix|null }]
  let radix = RADICES.includes(saved.radix) ? saved.radix : 'hex';
  let view = saved.view && saved.view.t1 > saved.view.t0 ? saved.view : null; // visible time range { t0, t1 }
  let cursor = typeof saved.cursor === 'number' ? saved.cursor : null;
  let marker = typeof saved.marker === 'number' ? saved.marker : null;
  let sel = typeof saved.sel === 'number' ? saved.sel : -1;
  const expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded : []);
  let cssW = 0, cssH = 0, dpr = 1, raf = 0, drag = null;

  // ---------- DOM ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const app = document.getElementById('app') || document.body.appendChild(el('div'));
  const bar = el('div', 'wf-toolbar');
  function button(label, tip, fn) {
    const b = el('button', 'wf-btn', label);
    b.title = tip;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  }
  button('−', 'Zoom out (-)', () => zoomAt(2, cssW / 2));
  button('+', 'Zoom in (+)', () => zoomAt(0.5, cssW / 2));
  button('Fit', 'Zoom to fit (F)', fit);
  const radixSel = el('select', 'wf-select');
  radixSel.title = 'Radix for all buses';
  for (const r of RADICES) radixSel.appendChild(el('option', null, r)).value = r;
  radixSel.value = radix;
  radixSel.addEventListener('change', () => {
    radix = radixSel.value;
    for (const t of traces) t.radix = null;
    renderNames();
    redraw();
  });
  bar.appendChild(radixSel);
  button('Export PNG', 'Save the waveform as a PNG image', exportPng);
  const info = bar.appendChild(el('span', 'wf-info'));

  const main = el('div', 'wf-main');
  const side = main.appendChild(el('div', 'wf-side'));
  const filter = side.appendChild(el('input', 'wf-filter'));
  filter.type = 'search';
  filter.placeholder = 'Filter signals';
  const tree = side.appendChild(el('div', 'wf-tree'));
  const names = main.appendChild(el('div', 'wf-names'));
  const head = names.appendChild(el('div', 'wf-names-head'));
  head.append(el('span', 'wf-tname', 'Signal'), el('span', 'wf-dim', 'Value'));
  const list = names.appendChild(el('div', 'wf-list'));
  const wave = main.appendChild(el('div', 'wf-wave'));
  const canvas = wave.appendChild(el('canvas'));
  canvas.tabIndex = 0;
  const overlay = wave.appendChild(el('div', 'wf-msg'));
  app.append(bar, main);
  const ctx = canvas.getContext('2d');

  // ---------- helpers ----------
  const fullSpan = () => Math.max(dump ? dump.endTime : 0, 1);
  const sigOf = t => dump.signals.get(t.id);
  const effRadix = t => t.radix || radix;
  const isText = s => TEXT_KINDS.has(s.kind);
  const isBus = s => s.width > 1 || isText(s);
  const shortName = s => s.fullName.slice(s.fullName.indexOf('.') + 1); // drop top-level scope

  function upper(a, t) { // first index with a[i] > t
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] <= t) lo = m + 1; else hi = m; }
    return lo;
  }
  function valueAt(ch, t) {
    const i = upper(ch.times, t) - 1;
    return i < 0 ? '' : ch.values[i];
  }
  function hex(v) {
    let out = '';
    for (let e = v.length; e > 0; e -= 4) {
      const nib = v.slice(Math.max(0, e - 4), e);
      out = (/^[01]+$/.test(nib) ? parseInt(nib, 2).toString(16)
        : /^x+$/.test(nib) ? 'x' : /^z+$/.test(nib) ? 'z' : nib.includes('x') ? 'X' : 'Z') + out;
    }
    return out;
  }
  function fmt(s, v, r) {
    if (!v) return '';
    if (s.kind === 'string' || s.width === 1 && !isText(s)) return v;
    if (isText(s)) { const x = +v; return isFinite(x) ? String(+x.toPrecision(6)) : v; }
    if (r === 'bin') return v;
    if (r === 'hex') return hex(v);
    if (/[^01]/.test(v)) return /^z+$/.test(v) ? 'z' : 'x';
    const n = BigInt('0b' + v);
    return (r === 'signed' ? BigInt.asIntN(v.length, n) : n).toString();
  }
  // Shows a time in the largest unit that keeps the value >= 1 (1500000 ps -> 1.5 us).
  function fmtTime(t) {
    const units = ['fs', 'ps', 'ns', 'us', 'ms', 's'];
    let v = t * dump.timescale.magnitude;
    let i = units.indexOf(dump.timescale.unit);
    if (i < 0) { return +v.toPrecision(12) + ' ' + dump.timescale.unit; }
    while (i < units.length - 1 && Math.abs(v) >= 1000) { v /= 1000; i++; }
    return +v.toPrecision(12) + ' ' + units[i];
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p);
  }
  function theme() {
    const cs = getComputedStyle(document.body);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      bg: v('--vscode-editor-background', 'white'),
      fg: v('--vscode-editor-foreground', 'black'),
      wave: v('--vscode-charts-green', 'green'),
      x: v('--vscode-charts-red', 'red'),
      z: v('--vscode-charts-yellow', 'goldenrod'),
      cursor: v('--vscode-editorCursor-foreground', v('--vscode-focusBorder', 'blue')),
      marker: v('--vscode-charts-orange', 'orange'),
      grid: v('--vscode-editorIndentGuide-background1', v('--vscode-editorIndentGuide-background', 'gray')),
      sel: v('--vscode-editor-lineHighlightBackground', v('--vscode-list-inactiveSelectionBackground', 'transparent')),
      mono: v('--vscode-editor-font-family', 'monospace'),
    };
  }

  // ---------- view ----------
  function clampSpan(s) { const f = fullSpan(); return Math.min(Math.max(s, Math.min(f, 2)), f); }
  function setView(t0, span) {
    if (!dump) return;
    span = clampSpan(span);
    t0 = Math.min(Math.max(t0, 0), fullSpan() - span);
    view = { t0, t1: t0 + span };
    redraw();
  }
  function fit() { setView(0, fullSpan()); }
  function pan(dt) { if (view) setView(view.t0 + dt, view.t1 - view.t0); }
  function zoomAt(factor, x) {
    if (!view || !cssW) return;
    const s = view.t1 - view.t0, t = view.t0 + x / cssW * s, ns = clampSpan(s * factor);
    setView(t - x / cssW * ns, ns);
  }
  const timeAtX = x => Math.round(view.t0 + x / cssW * (view.t1 - view.t0));
  // Pointer position relative to the canvas (offsetX is unreliable under pointer capture / synthetic events).
  const localX = e => e.clientX - canvas.getBoundingClientRect().left;
  const localY = e => e.clientY - canvas.getBoundingClientRect().top;

  // ---------- traces ----------
  function addTrace(id) {
    if (!traces.some(t => t.id === id)) traces.push({ id, radix: null });
    sel = traces.findIndex(t => t.id === id);
    renderNames();
    redraw();
  }
  function removeTrace(i) {
    if (i < 0 || i >= traces.length) return;
    traces.splice(i, 1);
    sel = Math.min(sel, traces.length - 1);
    renderNames();
    redraw();
  }
  function setSel(i) {
    sel = i;
    for (const row of list.children) row.classList.toggle('sel', +row.dataset.i === i);
    if (list.children[i]) list.children[i].scrollIntoView({ block: 'nearest' });
    redraw();
  }
  function autoSelect() { // first scope (breadth-first) that declares signals, i.e. the testbench top
    const q = [[dump.scopes, '']];
    while (q.length) {
      const [sc, p] = q.shift();
      if (sc.signals.length) {
        traces = sc.signals.slice(0, AUTO_SELECT).map(id => ({ id, radix: null }));
        let a = '';
        for (const part of p.split('/').slice(1)) expanded.add(a += '/' + part);
        return;
      }
      for (const ch of sc.children) q.push([ch, p + '/' + ch.name]);
    }
  }

  // ---------- left panes ----------
  function renderTree() {
    tree.textContent = '';
    if (!dump) return;
    const on = new Set(traces.map(t => t.id));
    const f = filter.value.trim().toLowerCase();
    if (!f) return addScope(dump.scopes, 0, '', on);
    let n = 0;
    for (const s of dump.signals.values()) {
      if (!s.fullName.toLowerCase().includes(f)) continue;
      tree.appendChild(sigRow(s, 0, s.fullName, on));
      if (++n >= 1000) break; // ponytail: capped flat result list; virtualize if people filter 100k-signal dumps
    }
    if (!n) tree.appendChild(el('div', 'wf-row wf-dim', 'No matching signals'));
  }
  function addScope(sc, depth, path, on) {
    for (const ch of sc.children) {
      const p = path + '/' + ch.name, open = expanded.has(p);
      const row = tree.appendChild(el('div', 'wf-row wf-scope', (open ? '▾ ' : '▸ ') + ch.name));
      row.dataset.path = p;
      row.title = ch.type;
      row.style.paddingLeft = 4 + depth * 12 + 'px';
      if (open) addScope(ch, depth + 1, p, on);
    }
    for (const id of sc.signals) tree.appendChild(sigRow(dump.signals.get(id), depth, null, on));
  }
  function sigRow(s, depth, label, on) {
    const row = el('label', 'wf-row wf-sig');
    row.style.paddingLeft = 4 + depth * 12 + 'px';
    row.title = `${s.fullName} (${s.kind}, ${s.width} bit)`;
    const cb = row.appendChild(el('input'));
    cb.type = 'checkbox';
    cb.dataset.id = s.id;
    cb.checked = on.has(s.id);
    row.appendChild(el('span', null, label || s.name));
    if (s.width > 1 && !isText(s)) row.appendChild(el('span', 'wf-dim', `[${s.width - 1}:0]`));
    return row;
  }
  function syncChecks() {
    const on = new Set(traces.map(t => t.id));
    for (const cb of tree.querySelectorAll('input[data-id]')) cb.checked = on.has(cb.dataset.id);
  }
  function renderNames() {
    const top = list.scrollTop;
    list.textContent = '';
    if (dump) traces.forEach((t, i) => {
      const s = sigOf(t);
      const row = list.appendChild(el('div', 'wf-trace' + (i === sel ? ' sel' : '')));
      row.dataset.i = i;
      row.title = `${s.fullName} (${s.kind}, ${s.width} bit)`;
      row.append(el('span', 'wf-tname', shortName(s)), el('span', 'wf-tval'));
      const rb = row.appendChild(el('button', 'wf-radix', isBus(s) && !isText(s) ? effRadix(t)[0] : ''));
      rb.title = 'Radix of this trace (click to cycle)';
      rb.disabled = !rb.textContent;
      row.appendChild(el('button', 'wf-rm', '×')).title = 'Remove trace (Delete)';
    });
    list.scrollTop = top;
    updateValues();
    syncChecks();
  }
  function updateValues() {
    const rows = list.children;
    for (let i = 0; i < rows.length; i++) {
      const t = traces[i], s = sigOf(t);
      rows[i].children[1].textContent = cursor == null ? '' : fmt(s, valueAt(s.changes, cursor), effRadix(t));
    }
  }

  // ---------- canvas ----------
  function redraw() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(ctx, cssW, cssH, list.scrollTop, true);
    const parts = [title];
    if (dump && cursor != null) parts.push('Cursor ' + fmtTime(cursor));
    if (dump && marker != null) parts.push('Marker ' + fmtTime(marker));
    if (dump && cursor != null && marker != null) parts.push('Δ ' + fmtTime(Math.abs(cursor - marker)));
    info.textContent = parts.filter(Boolean).join('   ');
    overlay.textContent = errMsg || (!dump ? 'Waiting for waveform data…'
      : !dump.signals.size ? 'This dump contains no signals.'
        : !traces.length ? 'Select signals in the tree to display them.' : '');
    overlay.hidden = !overlay.textContent;
    vscode.setState({ traces, radix, view, cursor, marker, sel, expanded: [...expanded] });
  }

  function paint(g, W, H, scrollY, highlight) {
    const c = theme();
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();
    g.fillStyle = c.bg;
    g.fillRect(0, 0, W, H);
    if (dump && view && W > 0) {
      const t0 = view.t0, span = view.t1 - view.t0, k = W / span, xOf = t => (t - t0) * k;
      g.font = '11px ' + c.mono;
      g.textBaseline = 'middle';
      g.lineWidth = 1;

      // ruler + grid
      const step = niceStep(span * Math.max(100, g.measureText(fmtTime(view.t1)).width + 24) / W);
      g.fillStyle = c.fg;
      g.strokeStyle = c.grid;
      g.beginPath();
      for (let i = Math.ceil(t0 / step); i * step <= view.t1; i++) {
        const x = Math.round(xOf(i * step)) + 0.5;
        g.moveTo(x, RULER_H - 8);
        g.lineTo(x, H);
        g.fillText(fmtTime(i * step), x + 3, 8);
      }
      g.moveTo(0, RULER_H - 0.5);
      g.lineTo(W, RULER_H - 0.5);
      g.stroke();

      // rows (vertical culling: only rows inside the scrolled viewport)
      g.save();
      g.beginPath();
      g.rect(0, RULER_H, W, H - RULER_H);
      g.clip();
      const last = Math.min(traces.length, Math.ceil((scrollY + H - RULER_H) / ROW_H));
      for (let i = Math.max(0, Math.floor(scrollY / ROW_H)); i < last; i++) {
        const y = RULER_H + i * ROW_H - scrollY;
        if (highlight && i === sel) { g.fillStyle = c.sel; g.fillRect(0, y, W, ROW_H); }
        drawTrace(g, sigOf(traces[i]), effRadix(traces[i]), y, W, t0, k, c);
      }
      g.restore();

      // marker + cursor with time flags in the ruler
      for (const [t, col] of [[marker, c.marker], [cursor, c.cursor]]) {
        if (t == null) continue;
        const x = Math.round(xOf(t)) + 0.5;
        if (x < 0 || x > W) continue;
        g.strokeStyle = col;
        g.beginPath();
        g.moveTo(x, RULER_H - 13);
        g.lineTo(x, H);
        g.stroke();
        const label = fmtTime(t), tw = g.measureText(label).width + 8, lx = Math.max(0, Math.min(x, W - tw));
        g.fillStyle = col;
        g.fillRect(lx, RULER_H - 13, tw, 13);
        g.fillStyle = c.bg;
        g.fillText(label, lx + 4, RULER_H - 6.5);
      }
    }
    g.restore();
  }

  // Draws one trace; only transitions inside [t0, t0 + W/k] are visited (binary search), and runs of
  // transitions closer than MIN_PX (MIN_BUS_PX for buses) are merged into one filled block, found by jumping pixel-by-pixel.
  function drawTrace(g, s, r, y, W, t0, k, c) {
    const T = s.changes.times, V = s.changes.values, n = T.length;
    if (!n) return;
    const top = y + 4, bot = y + ROW_H - 4, mid = y + ROW_H / 2, bus = isBus(s), minPx = bus ? MIN_BUS_PX : MIN_PX;
    const xOf = t => (t - t0) * k, cw = g.measureText('0').width;
    const xEnd = xOf(Math.max(dump.endTime, T[n - 1]));
    const lineP = new Path2D(), xP = new Path2D(), zP = new Path2D(), blockP = new Path2D(), texts = [];
    let prevY = null;
    for (let j = Math.max(0, upper(T, t0) - 1); j < n;) {
      const xa = xOf(T[j]);
      if (xa > W) break;
      const xb = j + 1 < n ? xOf(T[j + 1]) : xEnd;
      let m = j;
      if (xb - xa < minPx) {
        for (let m2; m < n - 1 && xOf(T[m]) <= W && (m2 = upper(T, t0 + (xOf(T[m]) + minPx) / k) - 1) > m;) m = m2;
      }
      if (m > j) { // dense run j..m
        blockP.rect(xa, top, Math.max(xOf(T[m]) - xa, 1), bot - top);
        prevY = null;
        j = m;
        continue;
      }
      const a = Math.max(xa, -2), b = Math.min(xb, W + 2), v = V[j];
      if (!bus) {
        const yv = v === '1' ? top : v === '0' ? bot : mid;
        if (v === '0' || v === '1' || v === 'z') {
          const P = v === 'z' ? zP : lineP;
          if (prevY !== null && prevY !== yv) { lineP.moveTo(a, prevY); lineP.lineTo(a, yv); }
          P.moveTo(a, yv);
          P.lineTo(b, yv);
        } else {
          xP.rect(a, top, b - a, bot - top);
        }
        prevY = yv;
      } else {
        const d = Math.min(3, (xb - xa) / 2);
        if (!isText(s) && /^z+$/.test(v)) {
          zP.moveTo(a, mid);
          zP.lineTo(b, mid);
        } else {
          const P = !isText(s) && /[^01]/.test(v) ? xP : lineP;
          P.moveTo(a, mid); P.lineTo(a + d, top); P.lineTo(b - d, top); P.lineTo(b, mid);
          P.lineTo(b - d, bot); P.lineTo(a + d, bot); P.closePath();
          const txt = fmt(s, v, r), x0 = Math.max(a + d, 0) + 2, x1 = Math.min(b - d, W) - 2;
          if (txt.length * cw <= x1 - x0) texts.push(txt, (x0 + x1) / 2);
        }
      }
      j++;
    }
    g.strokeStyle = c.wave;
    g.stroke(lineP);
    g.fillStyle = c.x;
    g.globalAlpha = 0.3;
    g.fill(xP);
    g.globalAlpha = 1;
    g.strokeStyle = c.x;
    g.stroke(xP);
    g.strokeStyle = c.z;
    g.stroke(zP);
    g.fillStyle = c.wave;
    g.globalAlpha = 0.5;
    g.fill(blockP);
    g.globalAlpha = 1;
    g.fillStyle = c.fg;
    g.textAlign = 'center';
    for (let i = 0; i < texts.length; i += 2) g.fillText(texts[i], texts[i + 1], mid);
    g.textAlign = 'left';
  }

  function exportPng() {
    if (!dump || !view) return;
    const LW = 260, W = Math.max(cssW, 400), H = RULER_H + Math.max(traces.length, 1) * ROW_H;
    const scale = Math.max(0.25, Math.min(dpr, 16000 / H, 16000 / (LW + W)));
    const out = el('canvas');
    out.width = Math.ceil((LW + W) * scale);
    out.height = Math.ceil(H * scale);
    const g = out.getContext('2d'), c = theme();
    g.scale(scale, scale);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, LW, H);
    g.fillStyle = c.fg;
    g.font = '12px ' + c.mono;
    g.textBaseline = 'middle';
    if (cursor != null) g.fillText('Value @ ' + fmtTime(cursor), 6, RULER_H / 2);
    traces.forEach((t, i) => {
      const s = sigOf(t), y = RULER_H + i * ROW_H + ROW_H / 2;
      g.textAlign = 'left';
      g.fillText(shortName(s), 6, y, LW - 110);
      g.textAlign = 'right';
      if (cursor != null) g.fillText(fmt(s, valueAt(s.changes, cursor), effRadix(t)), LW - 6, y, 96);
    });
    g.textAlign = 'left';
    g.translate(LW, 0);
    paint(g, W, H, 0, false);
    const base = (title || 'waveform').replace(/^.*[\\/]/, '').replace(/\.vcd$/i, '').replace(/[^\w.-]+/g, '_');
    vscode.postMessage({ type: 'savePng', dataUrl: out.toDataURL('image/png'), suggestedName: base + '.png' });
  }

  // ---------- load ----------
  function load(msg) {
    let d;
    title = String(msg.title || '');
    try {
      d = window.SiliconVcd.parseVcd(String(msg.vcd == null ? '' : msg.vcd));
    } catch (err) {
      errMsg = 'Failed to parse VCD: ' + (err && err.message || err);
      vscode.postMessage({ type: 'error', message: errMsg });
      dump = null;
      renderTree();
      renderNames();
      redraw();
      return;
    }
    dump = d;
    errMsg = '';
    traces = traces.filter(t => d.signals.has(t.id));
    if (!traces.length) autoSelect();
    sel = Math.min(sel, traces.length - 1);
    if (view) setView(view.t0, view.t1 - view.t0); else fit();
    renderTree();
    renderNames();
    redraw();
  }

  // ---------- events ----------
  window.addEventListener('message', e => {
    const m = e.data;
    if (m && m.type === 'load') load(m);
  });

  filter.addEventListener('input', renderTree);
  tree.addEventListener('click', e => {
    const row = e.target.closest('.wf-scope');
    if (!row) return;
    const p = row.dataset.path;
    if (!expanded.delete(p)) expanded.add(p);
    renderTree();
    redraw(); // persists expanded state
  });
  tree.addEventListener('change', e => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id) return;
    if (e.target.checked) addTrace(id);
    else removeTrace(traces.findIndex(t => t.id === id));
  });
  list.addEventListener('click', e => {
    const row = e.target.closest('.wf-trace');
    if (!row) return;
    const i = +row.dataset.i, cls = e.target.classList;
    if (cls.contains('wf-rm')) return removeTrace(i);
    if (cls.contains('wf-radix')) {
      const t = traces[i];
      t.radix = RADICES[(RADICES.indexOf(effRadix(t)) + 1) % RADICES.length];
      sel = i;
      renderNames();
      return redraw();
    }
    setSel(i);
  });
  list.addEventListener('scroll', redraw);

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !view) return;
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    drag = { x: localX(e), t0: view.t0, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = localX(e) - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    const span = view.t1 - view.t0;
    setView(drag.t0 - dx / cssW * span, span);
  });
  canvas.addEventListener('pointerup', e => {
    const d = drag;
    drag = null;
    if (!d || d.moved) return;
    const t = Math.min(Math.max(timeAtX(localX(e)), 0), fullSpan());
    if (e.altKey || e.shiftKey) marker = t; else cursor = t;
    const i = Math.floor((localY(e) - RULER_H + list.scrollTop) / ROW_H);
    if (localY(e) >= RULER_H && i < traces.length) setSel(i);
    updateValues();
    redraw();
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', e => {
    if (!view) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cssH : 1;
    if (e.ctrlKey || e.metaKey) return zoomAt(Math.exp(e.deltaY * unit * 0.002), localX(e));
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
    pan(d / cssW * (view.t1 - view.t0));
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || !view) return;
    const span = view.t1 - view.t0;
    switch (e.key) {
      case '+': case '=': zoomAt(0.5, cssW / 2); break;
      case '-': case '_': zoomAt(2, cssW / 2); break;
      case 'f': case 'F': fit(); break;
      case 'ArrowLeft': pan(-0.1 * span); break;
      case 'ArrowRight': pan(0.1 * span); break;
      case 'ArrowUp': case 'ArrowDown': {
        const j = sel + (e.key === 'ArrowUp' ? -1 : 1);
        if (sel < 0 || j < 0 || j >= traces.length) break;
        if (e.altKey) {
          [traces[sel], traces[j]] = [traces[j], traces[sel]];
          sel = j;
          renderNames();
        }
        setSel(j);
        break;
      }
      case 'Delete': case 'Backspace': removeTrace(sel); break;
      case 'Escape': marker = null; redraw(); break;
      default: return;
    }
    e.preventDefault();
  });

  new ResizeObserver(() => {
    cssW = wave.clientWidth;
    cssH = wave.clientHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    frame(); // synchronous so the cleared canvas never flashes
  }).observe(wave);
  // VS Code swaps theme classes on <body> and CSS variables on <html>.
  const themeObserver = new MutationObserver(redraw);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });

  redraw();
  vscode.postMessage({ type: 'ready' });
})();
