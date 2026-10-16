// Silicon Studio - layout viewer webview (the ICC2 layout window) for the JSON written by flow/export_layout.tcl.
// Host -> webview: {type:'load', title, stage, layout}. Webview -> host: {type:'ready'} at startup,
// {type:'savePng', dataUrl, suggestedName} and {type:'reveal', kind:'inst'|'net', name}.
// One canvas; viewport culling and level of detail (sub-pixel shapes skipped, instances as outlines when zoomed out,
// fillers and labels only when they are big enough) keep a few hundred thousand shapes interactive.
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();

	// Fixed colorblind-friendly palette (Okabe-Ito, then Paul Tol muted); every hue reads on light and dark backgrounds.
	const LAYER_COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#882255', '#999933', '#44AA99', '#332288', '#AA4499', '#DDCC77'];
	const KINDS = {
		std: ['Standard cells', ''], macro: ['Macros', '#AA4499'], tap: ['Tap cells', '#44AA99'], fill: ['Fillers', '#999999'],
		endcap: ['Endcaps', '#117733'], buffer: ['Buffers', '#E69F00'], clock: ['Clock tree', '#EE3377'], tie: ['Tie cells', '#0077BB'],
		pad: ['Pads', '#CC6677']
	};
	const MAX_LABELS = 2000;

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) { e.className = cls; }
		if (text) { e.textContent = text; }
		return e;
	}
	function button(text, tip) {
		const b = el('button', 'ly-btn', text);
		b.type = 'button';
		b.title = tip;
		b.setAttribute('aria-label', tip);
		return b;
	}

	// ---- DOM ----
	const toolbar = el('div', 'ly-toolbar');
	const title = el('span', 'ly-title', 'Layout');
	const stageBadge = el('span', 'ly-badge');
	const btn = {
		panel: button('Layers', 'Show or hide the layer and object panel'),
		fit: button('Fit', 'Fit the die in the window (F)'),
		out: button('−', 'Zoom out (-)'),
		in: button('+', 'Zoom in (+)'),
		png: button('Export PNG', 'Save the current view as PNG')
	};
	const search = el('input', 'ly-search');
	search.type = 'search';
	search.placeholder = 'Find instance, net or pin';
	search.setAttribute('aria-label', 'Find an instance, net or pin by name; Enter for the next match');
	toolbar.append(btn.panel, title, stageBadge, search, btn.fit, btn.out, btn.in, btn.png);
	const main = el('div', 'ly-main');
	const side = el('div', 'ly-side');
	const stage = el('div', 'ly-stage');
	stage.tabIndex = 0;
	stage.setAttribute('aria-label', 'Layout canvas: drag to pan, wheel to zoom, click to select');
	const canvas = el('canvas');
	const tip = el('div', 'ly-tip');
	tip.hidden = true;
	stage.append(canvas, tip);
	main.append(side, stage);
	const status = el('div', 'ly-status');
	const coordText = el('span', 'ly-coord');
	const scaleText = el('span', 'ly-scale');
	const msgText = el('span', 'ly-msg', 'Waiting for layout…');
	status.setAttribute('role', 'status');
	status.append(coordText, scaleText, msgText);
	(document.getElementById('app') || document.body).append(toolbar, main, status);
	Object.values(btn).forEach(function (b) { b.disabled = true; });
	const ctx = canvas.getContext('2d');

	// ---- state ----
	let L = null;            // layout JSON
	let meta = null;         // last load message
	let layers = [];         // per exported layer: {name, type, color, on, sig, sigNet, pwr, pwrNet, obs}
	let kindInsts = [];      // per kind: Int32Array of instance indexes
	let kindOn = [];         // per kind visibility
	const vis = { pins: true, power: true, blockages: true, rows: true, labels: true };
	let view = { cx: 0, cy: 0, s: 1 };
	let fitScale = 1, fitted = true, dpr = 1;
	let V = null;            // per-frame viewport, see frame()
	let sel = null;          // {kind:'inst'|'net'|'pin', i, ...}
	let theme = {};
	let nameIndex = null;    // lazily built name -> index maps for search
	let lastQuery = '', matches = [], matchAt = -1;
	let lastClick = null;

	function setMsg(text, isError) {
		msgText.textContent = text;
		msgText.classList.toggle('ly-error', !!isError);
	}
	function um(v) { return (v / L.dbu).toFixed(3); }
	function rectText(a, b, c, d) { return '(' + um(a) + ', ' + um(b) + ') – (' + um(c) + ', ' + um(d) + ') µm'; }

	function readTheme() {
		const cs = getComputedStyle(document.body);
		const v = function (name, dflt) { return cs.getPropertyValue(name).trim() || dflt; };
		theme = {
			bg: v('--vscode-editor-background', '#1e1e1e'),
			fg: v('--vscode-editor-foreground', '#cccccc'),
			muted: v('--vscode-descriptionForeground', '#999999'),
			font: v('--vscode-editor-font-family', 'monospace')
		};
	}

	// ---- load: unpack the flat arrays into per-layer typed arrays for fast drawing and picking ----
	function load(m) {
		const d = m.layout;
		if (!d || !Array.isArray(d.layers) || !d.insts || !Array.isArray(d.die) || d.die.length !== 4) {
			setMsg('Could not display the layout: unexpected data format.', true);
			return;
		}
		meta = m;
		L = d;
		let below = 0;
		layers = d.layers.map(function (l, i) {
			if (l.type === 'routing') { below = i; }
			const level = d.layers[below].level || 1;   // cut layers take the colour of the metal below
			return { name: l.name, type: l.type, color: LAYER_COLORS[(level - 1) % LAYER_COLORS.length], on: true, sig: [], sigNet: [], pwr: [], pwrNet: [], obs: [] };
		});
		function add(group, layer, net, x0, y0, x1, y1) {
			const t = layers[layer];
			if (!t) { return; }
			t[group].push(x0, y0, x1, y1);
			if (group !== 'obs') { t[group + 'Net'].push(net); }
		}
		function addWires(arr, group) {
			for (let k = 0; k < arr.length; k += 6) { add(group, arr[k + 1], arr[k], arr[k + 2], arr[k + 3], arr[k + 4], arr[k + 5]); }
		}
		function addVias(arr, group) {
			for (let k = 0; k < arr.length; k += 4) {
				const def = d.viaDefs[arr[k + 1]], x = arr[k + 2], y = arr[k + 3];
				const r = def ? def.rects : [];
				for (let j = 0; j < r.length; j += 5) { add(group, r[j], arr[k], x + r[j + 1], y + r[j + 2], x + r[j + 3], y + r[j + 4]); }
			}
		}
		addWires(d.wires || [], 'sig');
		addVias(d.vias || [], 'sig');
		addWires(d.swires || [], 'pwr');
		addVias(d.svias || [], 'pwr');
		const obs = d.obstructions || [];
		for (let k = 0; k < obs.length; k += 5) { add('obs', obs[k], -1, obs[k + 1], obs[k + 2], obs[k + 3], obs[k + 4]); }
		layers.forEach(function (t) {
			['sig', 'sigNet', 'pwr', 'pwrNet', 'obs'].forEach(function (g) { t[g] = Int32Array.from(t[g]); });
		});
		L.inst = Int32Array.from(d.insts.data);
		const buckets = d.kinds.map(function () { return []; });
		for (let i = 0, o = 0; o < L.inst.length; i++, o += 7) { buckets[L.inst[o + 1]].push(i); }
		kindInsts = buckets.map(function (b) { return Int32Array.from(b); });
		kindOn = d.kinds.map(function () { return true; });
		L.pin = Int32Array.from(d.pins.data);
		L.rowH = d.rows.length >= 4 ? d.rows[3] - d.rows[1] : 0;
		nameIndex = null;
		lastQuery = '';
		sel = null;

		const st = vscode.getState();
		const key = (m.title || d.design) + '|' + (m.stage || '');
		if (st && st.key === key) {
			(st.hidden || []).forEach(function (n) { const t = layers.find(function (l) { return l.name === n; }); if (t) { t.on = false; } });
			(st.hiddenKinds || []).forEach(function (k) { const i = d.kinds.indexOf(k); if (i >= 0) { kindOn[i] = false; } });
			Object.assign(vis, st.vis || {});
		}
		title.textContent = m.title || d.design;
		stageBadge.textContent = m.stage || '';
		stageBadge.hidden = !m.stage;
		buildPanel();
		Object.values(btn).forEach(function (b) { b.disabled = false; });
		resize();
		fit();
		if (st && st.key === key && st.view) { view = st.view; fitted = false; }
		const unplaced = d.unplaced && d.unplaced.insts ? ' · ' + d.unplaced.insts + ' unplaced instances not shown' : '';
		setMsg(d.design + ': ' + d.insts.names.length + ' instances, ' + d.nets.names.length + ' nets' + unplaced);
		schedule();
	}

	function saveState() {
		if (!L) { return; }
		vscode.setState({
			key: (meta.title || L.design) + '|' + (meta.stage || ''), view: view, vis: vis,
			hidden: layers.filter(function (t) { return !t.on; }).map(function (t) { return t.name; }),
			hiddenKinds: L.kinds.filter(function (k, i) { return !kindOn[i]; })
		});
	}

	// ---- side panel: layer list, object toggles (with swatches, doubling as the legend), selection details ----
	const selBox = el('div', 'ly-sel');
	function checkRow(label, color, count, checked, onChange) {
		const row = el('label', 'ly-row');
		const cb = el('input');
		cb.type = 'checkbox';
		cb.checked = checked;
		cb.addEventListener('change', function () { onChange(cb.checked); saveState(); schedule(); });
		row.append(cb);
		if (color !== null) {
			const sw = el('span', 'ly-swatch');
			if (color) { sw.style.background = color; } else { sw.classList.add('ly-swatch-fg'); }
			row.append(sw);
		}
		row.append(el('span', 'ly-name', label));
		if (count !== undefined) { row.append(el('span', 'ly-count', String(count))); }
		return row;
	}
	function section(name) {
		const s = el('section', 'ly-sec');
		s.append(el('h3', '', name));
		side.append(s);
		return s;
	}
	function buildPanel() {
		side.replaceChildren();
		const ls = section('Layers');
		const all = el('div', 'ly-allnone');
		const showAll = button('All', 'Show all layers'), showNone = button('None', 'Hide all layers');
		all.append(showAll, showNone);
		ls.append(all);
		const boxes = [];
		layers.forEach(function (t) {
			const n = t.sigNet.length + t.pwrNet.length + t.obs.length / 4;
			if (!n && t.type === 'cut') { return; }
			const row = checkRow(t.name, t.color, n, t.on, function (on) { t.on = on; });
			boxes.push([row.firstChild, t]);
			ls.append(row);
		});
		function setAll(on) {
			boxes.forEach(function (b) { b[0].checked = on; b[1].on = on; });
			saveState();
			schedule();
		}
		showAll.addEventListener('click', function () { setAll(true); });
		showNone.addEventListener('click', function () { setAll(false); });

		const os = section('Objects');
		L.kinds.forEach(function (k, i) {
			if (!kindInsts[i].length) { return; }
			const info = KINDS[k] || [k, ''];
			os.append(checkRow(info[0], info[1], kindInsts[i].length, kindOn[i], function (on) { kindOn[i] = on; }));
		});
		[['pins', 'IO pins', L.pins.names.length], ['power', 'Power / ground', (L.swires.length / 6 + L.svias.length / 4) || undefined],
			['blockages', 'Blockages', (L.blockages.length / 4 + L.obstructions.length / 5) || undefined],
			['rows', 'Rows', L.rows.length / 4], ['labels', 'Labels', undefined]].forEach(function (o) {
			os.append(checkRow(o[1], null, o[2], vis[o[0]], function (on) { vis[o[0]] = on; }));
		});
		section('Selection').append(selBox);
		showSelection();
	}

	function showSelection() {
		selBox.replaceChildren();
		if (!sel) {
			selBox.append(el('p', 'ly-hint', 'Click a shape or instance. Click again on the same spot to cycle through overlapping objects.'));
			return;
		}
		const rows = [];
		let reveal = null;
		if (sel.kind === 'inst') {
			const o = sel.i * 7, d = L.inst;
			rows.push(['Instance', L.insts.names[sel.i]], ['Master', L.masters[d[o]]], ['Kind', (KINDS[L.kinds[d[o + 1]]] || [L.kinds[d[o + 1]]])[0]],
				['Status', d[o + 2] ? 'Fixed' : 'Placed'], ['Box', rectText(d[o + 3], d[o + 4], d[o + 5], d[o + 6])],
				['Size', um(d[o + 5] - d[o + 3]) + ' × ' + um(d[o + 6] - d[o + 4]) + ' µm']);
			reveal = { kind: 'inst', name: L.insts.names[sel.i] };
		} else {
			const net = sel.kind === 'net' ? sel.i : L.pins.nets[sel.i];
			if (sel.kind === 'pin') {
				rows.push(['Pin', L.pins.names[sel.i]], ['Direction', L.pins.dirs[sel.i]]);
			}
			if (net >= 0) {
				const sh = netShapes(net);
				rows.push(['Net', L.nets.names[net]], ['Instances', String(L.nets.start[net + 1] - L.nets.start[net])],
					['Shapes', sh.count ? sh.byLayer.map(function (x) { return layers[x[0]].name + ' ' + x[1].length / 4; }).join(', ') : 'not routed']);
				reveal = { kind: 'net', name: L.nets.names[net] };
			}
		}
		const dl = el('dl', 'ly-props');
		rows.forEach(function (r) { dl.append(el('dt', '', r[0]), el('dd', '', r[1])); });
		const acts = el('div', 'ly-actions');
		const zoomBtn = button('Zoom To', 'Zoom to the selection');
		zoomBtn.addEventListener('click', zoomToSelection);
		acts.append(zoomBtn);
		if (reveal) {
			const r = reveal;
			const revealBtn = button('Reveal in Netlist', 'Show this ' + (r.kind === 'inst' ? 'instance' : 'net') + ' in the netlist');
			revealBtn.addEventListener('click', function () { vscode.postMessage({ type: 'reveal', kind: r.kind, name: r.name }); });
			acts.append(revealBtn);
		}
		selBox.append(dl, acts);
	}

	// All shapes of a net, grouped by layer (cached on the selection).
	function netShapes(net) {
		if (sel && sel.shapes && sel.shapesNet === net) { return sel.shapes; }
		const byLayer = [];
		let count = 0, signal = 0;
		let box = null;
		layers.forEach(function (t, li) {
			const out = [];
			[['sig', 'sigNet'], ['pwr', 'pwrNet']].forEach(function (g) {
				const nets = t[g[1]], r = t[g[0]];
				for (let k = 0; k < nets.length; k++) {
					if (nets[k] !== net) { continue; }
					out.push(r[4 * k], r[4 * k + 1], r[4 * k + 2], r[4 * k + 3]);
					if (g[0] === 'sig') { signal++; }
				}
			});
			if (out.length) {
				byLayer.push([li, Int32Array.from(out)]);
				count += out.length / 4;
				for (let k = 0; k < out.length; k += 4) { box = grow(box, out[k], out[k + 1], out[k + 2], out[k + 3]); }
			}
		});
		const res = { byLayer: byLayer, count: count, signal: signal, box: box };
		if (sel) { sel.shapes = res; sel.shapesNet = net; }
		return res;
	}
	function grow(b, x0, y0, x1, y1) {
		return b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
	}
	function netInsts(net) { return L.nets.insts.slice(L.nets.start[net], L.nets.start[net + 1]); }
	function instBox(i) { const o = i * 7; return [L.inst[o + 3], L.inst[o + 4], L.inst[o + 5], L.inst[o + 6]]; }
	function pinBoxes(pred) {
		const out = [];
		for (let o = 0; o < L.pin.length; o += 6) { if (pred(L.pin[o])) { out.push([L.pin[o + 1], L.pin[o + 2], L.pin[o + 3], L.pin[o + 4], L.pin[o + 5]]); } }
		return out;
	}

	function select(s) {
		sel = s;
		showSelection();
		schedule();
	}

	function selectionBox() {
		if (!sel) { return null; }
		if (sel.kind === 'inst') { return instBox(sel.i); }
		let box = null;
		const net = sel.kind === 'net' ? sel.i : L.pins.nets[sel.i];
		if (sel.kind === 'pin') { pinBoxes(function (p) { return p === sel.i; }).forEach(function (b) { box = grow(box, b[1], b[2], b[3], b[4]); }); }
		if (net >= 0) {
			const sh = netShapes(net);
			if (sh.box) { box = grow(box, sh.box[0], sh.box[1], sh.box[2], sh.box[3]); }
			netInsts(net).forEach(function (i) { const b = instBox(i); box = grow(box, b[0], b[1], b[2], b[3]); });
		}
		return box;
	}
	function zoomToSelection() {
		const b = selectionBox();
		if (!b) { return; }
		const W = canvas.clientWidth, H = canvas.clientHeight;
		const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.25 + 2 * L.dbu;   // show some context around tiny objects
		view.s = clampScale(Math.min(W / (b[2] - b[0] + 2 * pad), H / (b[3] - b[1] + 2 * pad)));
		view.cx = (b[0] + b[2]) / 2;
		view.cy = (b[1] + b[3]) / 2;
		fitted = false;
		saveState();
		schedule();
	}

	// ---- view ----
	function clampScale(s) { return Math.min(Math.max(s, fitScale / 8), 4); }
	function resize() {
		dpr = window.devicePixelRatio || 1;
		const W = stage.clientWidth, H = stage.clientHeight;
		canvas.width = Math.max(1, Math.round(W * dpr));
		canvas.height = Math.max(1, Math.round(H * dpr));
		if (L && fitted) { fit(); } else { schedule(); }
	}
	function fit() {
		if (!L) { return; }
		const W = canvas.clientWidth, H = canvas.clientHeight, d = L.die;
		if (!W || !H) { return; }
		fitScale = Math.min(W / (d[2] - d[0]), H / (d[3] - d[1])) * 0.94;
		view = { cx: (d[0] + d[2]) / 2, cy: (d[1] + d[3]) / 2, s: fitScale };
		fitted = true;
		saveState();
		schedule();
	}
	function zoomAt(k, px, py) {
		const W = canvas.clientWidth, H = canvas.clientHeight;
		const wx = view.cx + (px - W / 2) / view.s, wy = view.cy - (py - H / 2) / view.s;
		view.s = clampScale(view.s * k);
		view.cx = wx - (px - W / 2) / view.s;
		view.cy = wy + (py - H / 2) / view.s;
		fitted = false;
		saveState();
		schedule();
	}
	function toWorld(px, py) {
		return [view.cx + (px - canvas.clientWidth / 2) / view.s, view.cy - (py - canvas.clientHeight / 2) / view.s];
	}

	// ---- drawing ----
	let pending = false;
	function schedule() {
		if (!pending) { pending = true; requestAnimationFrame(draw); }
	}
	function frame() {
		const W = canvas.clientWidth, H = canvas.clientHeight, s = view.s;
		V = { s: s, hw: W / 2, hh: H / 2, cx: view.cx, cy: view.cy, x0: view.cx - W / 2 / s, x1: view.cx + W / 2 / s, y0: view.cy - H / 2 / s, y1: view.cy + H / 2 / s };
	}
	// Adds one world rect to the current path unless it is off screen or smaller than minPx in both directions.
	// With a `thin` path set, rects under a pixel across go there instead, so they can be drawn fainter: a 0.2 px
	// rail widened to 1 px would otherwise paint five times its real coverage and wash out everything below.
	let thin = null;
	function addRect(a, b, c, d, minPx) {
		if (c < V.x0 || a > V.x1 || d < V.y0 || b > V.y1) { return false; }
		const w = (c - a) * V.s, h = (d - b) * V.s;
		if (w < minPx && h < minPx) { return false; }
		(thin && (w < 1 || h < 1) ? thin : ctx).rect((a - V.cx) * V.s + V.hw, V.hh - (d - V.cy) * V.s, Math.max(w, 1), Math.max(h, 1));
		return true;
	}
	function rectsPath(r, minPx, splitThin) {
		ctx.beginPath();
		thin = splitThin ? new Path2D() : null;
		let n = 0;
		for (let k = 0; k < r.length; k += 4) { if (addRect(r[k], r[k + 1], r[k + 2], r[k + 3], minPx)) { n++; } }
		if (!n) { thin = null; }   // nothing to fill: later rects must not land in a stale thin path
		return n;
	}
	// Fills the shapes collected by rectsPath(.., true) at `alpha` (thin ones at a third of it) and outlines them when zoomed in.
	function fillShapes(alpha, outline) {
		ctx.globalAlpha = alpha;
		ctx.fill();
		if (outline) { ctx.globalAlpha = Math.min(1, alpha * 1.6); ctx.stroke(); }
		ctx.globalAlpha = alpha / 3;
		ctx.fill(thin);
		thin = null;
	}
	function sx(x) { return (x - V.cx) * V.s + V.hw; }
	function sy(y) { return V.hh - (y - V.cy) * V.s; }

	function draw() {
		pending = false;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.globalAlpha = 1;
		ctx.fillStyle = theme.bg;
		ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
		if (!L) { return; }
		frame();
		scaleText.textContent = (1 / (view.s * L.dbu)).toPrecision(3) + ' µm/px';
		ctx.lineWidth = 1;
		const d = L.die;

		// die, core, rows
		ctx.strokeStyle = theme.fg;
		ctx.globalAlpha = 0.8;
		ctx.strokeRect(sx(d[0]), sy(d[3]), (d[2] - d[0]) * V.s, (d[3] - d[1]) * V.s);
		if (L.core) {
			ctx.setLineDash([6, 4]);
			ctx.globalAlpha = 0.5;
			ctx.strokeRect(sx(L.core[0]), sy(L.core[3]), (L.core[2] - L.core[0]) * V.s, (L.core[3] - L.core[1]) * V.s);
			ctx.setLineDash([]);
		}
		if (vis.rows && L.rowH * V.s >= 3) {
			rectsPath(L.rows, 0);
			ctx.globalAlpha = 0.15;
			ctx.stroke();
		}
		if (vis.blockages && L.blockages.length) {
			rectsPath(L.blockages, 0);
			ctx.globalAlpha = 0.25;
			ctx.fillStyle = hatch(theme.fg);
			ctx.fill();
			ctx.globalAlpha = 0.7;
			ctx.stroke();
		}

		drawInsts();

		// routing and power, bottom-up so upper metals sit on top
		const detailed = V.s * L.dbu >= 20;   // >= 20 px per micron: outline shapes too
		layers.forEach(function (t) {
			if (!t.on) { return; }
			ctx.fillStyle = t.color;
			ctx.strokeStyle = t.color;
			if (vis.power && t.pwr.length && rectsPath(t.pwr, 1, true)) { fillShapes(0.35, detailed); }
			if (t.sig.length && rectsPath(t.sig, 1, true)) { fillShapes(t.type === 'cut' ? 0.85 : 0.55, detailed); }
			if (vis.blockages && t.obs.length && rectsPath(t.obs, 1)) {
				ctx.globalAlpha = 0.6;
				ctx.fillStyle = hatch(t.color);
				ctx.fill();
				ctx.stroke();
			}
		});
		if (vis.pins) { drawPins(); }
		if (sel) { drawSelection(); }
		ctx.globalAlpha = 1;
	}

	const hatches = {};
	function hatch(color) {
		if (!hatches[color]) {
			const c = document.createElement('canvas');
			c.width = c.height = 8;
			const g = c.getContext('2d');
			g.strokeStyle = color;
			g.beginPath();
			g.moveTo(0, 8); g.lineTo(8, 0);
			g.moveTo(-2, 2); g.lineTo(2, -2);
			g.moveTo(6, 10); g.lineTo(10, 6);
			g.stroke();
			hatches[color] = ctx.createPattern(c, 'repeat');
		}
		return hatches[color];
	}

	function kindColor(k) { return (KINDS[k] && KINDS[k][1]) || theme.muted; }

	function drawInsts() {
		const d = L.inst;
		const zoomed = L.rowH * V.s >= 12;   // rows at least 12 px tall: fill, outline and label cells
		const labels = [];
		L.kinds.forEach(function (k, ki) {
			if (!kindOn[ki]) { return; }
			const list = kindInsts[ki];
			const minPx = k === 'fill' ? 2 : 0.5;    // fillers are noise until they are a couple of pixels wide
			ctx.beginPath();
			for (let j = 0; j < list.length; j++) {
				const o = list[j] * 7;
				if (addRect(d[o + 3], d[o + 4], d[o + 5], d[o + 6], minPx) && zoomed && vis.labels && labels.length < MAX_LABELS && k !== 'fill') {
					labels.push(list[j]);
				}
			}
			const color = kindColor(k);
			ctx.strokeStyle = color;
			if (zoomed) {
				ctx.fillStyle = color;
				ctx.globalAlpha = 0.1;
				ctx.fill();
			}
			ctx.globalAlpha = zoomed ? 0.8 : 0.45;
			ctx.stroke();
		});
		if (labels.length) {
			ctx.font = '11px ' + theme.font;
			ctx.fillStyle = theme.fg;
			ctx.globalAlpha = 0.85;
			ctx.textBaseline = 'top';
			const cw = ctx.measureText('M').width;
			labels.forEach(function (i) {
				const o = i * 7, name = L.insts.names[i];
				const w = (d[o + 5] - d[o + 3]) * V.s, h = (d[o + 6] - d[o + 4]) * V.s;
				if (h < 13 || name.length * cw > w - 4) { return; }
				ctx.fillText(name, sx(d[o + 3]) + 2, sy(d[o + 6]) + 2);
			});
		}
	}

	// IO pins: the real shape plus a fixed-size marker so they stay findable when zoomed out.
	function drawPins() {
		const p = L.pin;
		const showNames = vis.labels && V.s >= fitScale * 3;
		ctx.font = '11px ' + theme.font;
		ctx.textBaseline = 'middle';
		for (let o = 0; o < p.length; o += 6) {
			const t = layers[p[o + 1]];
			if (t && !t.on) { continue; }
			const cx = (p[o + 2] + p[o + 4]) / 2, cy = (p[o + 3] + p[o + 5]) / 2;
			if (cx < V.x0 || cx > V.x1 || cy < V.y0 || cy > V.y1) { continue; }
			const color = t ? t.color : theme.fg;
			ctx.beginPath();
			addRect(p[o + 2], p[o + 3], p[o + 4], p[o + 5], 0);
			ctx.rect(sx(cx) - 3, sy(cy) - 3, 6, 6);
			ctx.fillStyle = color;
			ctx.globalAlpha = 0.9;
			ctx.fill();
			ctx.strokeStyle = theme.fg;
			ctx.stroke();
			if (showNames) {
				ctx.fillStyle = theme.fg;
				ctx.fillText(L.pins.names[p[o]], sx(cx) + 6, sy(cy));
			}
		}
	}

	// Dim everything, then redraw the selected object (and for nets its shapes, cells, pins and flylines) on top.
	function drawSelection() {
		ctx.globalAlpha = 0.6;
		ctx.fillStyle = theme.bg;
		ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
		ctx.strokeStyle = theme.fg;
		ctx.lineWidth = 2;
		if (sel.kind === 'inst') {
			const b = instBox(sel.i);
			ctx.beginPath();
			ctx.rect(sx(b[0]), sy(b[3]), Math.max((b[2] - b[0]) * V.s, 3), Math.max((b[3] - b[1]) * V.s, 3));
			ctx.globalAlpha = 0.35;
			ctx.fillStyle = kindColor(L.kinds[L.inst[sel.i * 7 + 1]]);
			ctx.fill();
			ctx.globalAlpha = 1;
			ctx.stroke();
			ctx.lineWidth = 1;
			return;
		}
		const net = sel.kind === 'net' ? sel.i : L.pins.nets[sel.i];
		const pins = pinBoxes(function (p) { return sel.kind === 'pin' ? p === sel.i : L.pins.nets[p] === net; });
		if (net >= 0) {
			const sh = netShapes(net);
			sh.byLayer.forEach(function (x) {
				if (rectsPath(x[1], 0)) {
					ctx.fillStyle = layers[x[0]].color;
					ctx.globalAlpha = 0.9;
					ctx.fill();
					ctx.lineWidth = 1;
					ctx.globalAlpha = 1;
					ctx.stroke();
				}
			});
			const cells = netInsts(net);
			ctx.beginPath();
			cells.forEach(function (i) { const b = instBox(i); addRect(b[0], b[1], b[2], b[3], 0); });
			ctx.lineWidth = 2;
			ctx.globalAlpha = 0.9;
			ctx.stroke();
			if (!sh.signal) {
				// Unrouted net: flylines from the driver (first instance, or the IO pin) to every other connection.
				const ends = cells.map(function (i) { const b = instBox(i); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; })
					.concat(pins.map(function (b) { return [(b[1] + b[3]) / 2, (b[2] + b[4]) / 2]; }));
				const src = cells.length ? ends[0] : ends[ends.length - 1];
				if (src) {
					ctx.beginPath();
					ends.forEach(function (e) { ctx.moveTo(sx(src[0]), sy(src[1])); ctx.lineTo(sx(e[0]), sy(e[1])); });
					ctx.lineWidth = 1;
					ctx.globalAlpha = 0.9;
					ctx.stroke();
				}
			}
		}
		pins.forEach(function (b) {
			const cx = (b[1] + b[3]) / 2, cy = (b[2] + b[4]) / 2;
			ctx.beginPath();
			ctx.rect(sx(cx) - 5, sy(cy) - 5, 10, 10);
			ctx.lineWidth = 2;
			ctx.globalAlpha = 1;
			ctx.stroke();
		});
		ctx.lineWidth = 1;
	}

	// ---- picking: every visible object under the pointer, topmost first ----
	function pickAll(px, py) {
		if (!L) { return []; }
		frame();
		const w = toWorld(px, py), x = w[0], y = w[1], tol = 3 / view.s;
		const hits = [];
		if (vis.pins) {
			const p = L.pin;
			for (let o = 0; o < p.length; o += 6) {
				const t = layers[p[o + 1]];
				if (t && !t.on) { continue; }
				const cx = (p[o + 2] + p[o + 4]) / 2, cy = (p[o + 3] + p[o + 5]) / 2;
				// On the fixed-size marker, or on the pin shape itself (power pins can be die-wide straps).
				const m = 4 / view.s;
				const onMarker = Math.abs(x - cx) <= m && Math.abs(y - cy) <= m;
				const onShape = x >= p[o + 2] - tol && x <= p[o + 4] + tol && y >= p[o + 3] - tol && y <= p[o + 5] + tol;
				if (onMarker || onShape) { hits.push({ kind: 'pin', i: p[o], layer: p[o + 1] }); break; }
			}
		}
		for (let li = layers.length - 1; li >= 0; li--) {
			const t = layers[li];
			if (!t.on) { continue; }
			const groups = vis.power ? [['sig', 'sigNet'], ['pwr', 'pwrNet']] : [['sig', 'sigNet']];
			groups.forEach(function (g) {
				const r = t[g[0]], nets = t[g[1]];
				for (let k = 0; k < nets.length; k++) {
					const o = 4 * k;
					if (x >= r[o] - tol && x <= r[o + 2] + tol && y >= r[o + 1] - tol && y <= r[o + 3] + tol &&
						!hits.some(function (h) { return h.kind === 'net' && h.i === nets[k]; })) {
						hits.push({ kind: 'net', i: nets[k], layer: li });
						break;
					}
				}
			});
		}
		const d = L.inst;
		let best = -1, bestArea = Infinity;
		for (let ki = 0; ki < kindInsts.length; ki++) {
			if (!kindOn[ki]) { continue; }
			const list = kindInsts[ki];
			for (let j = 0; j < list.length; j++) {
				const o = list[j] * 7;
				if (x >= d[o + 3] && x <= d[o + 5] && y >= d[o + 4] && y <= d[o + 6]) {
					const area = (d[o + 5] - d[o + 3]) * (d[o + 6] - d[o + 4]);
					if (area < bestArea) { best = list[j]; bestArea = area; }
				}
			}
		}
		if (best >= 0) { hits.push({ kind: 'inst', i: best }); }
		return hits;
	}

	function describe(h) {
		if (h.kind === 'inst') {
			const o = h.i * 7;
			return L.insts.names[h.i] + '\n' + L.masters[L.inst[o]] + ' · ' + (KINDS[L.kinds[L.inst[o + 1]]] || [L.kinds[L.inst[o + 1]]])[0] +
				(L.inst[o + 2] ? ' · fixed' : '');
		}
		if (h.kind === 'pin') { return 'Pin ' + L.pins.names[h.i] + '\n' + L.pins.dirs[h.i] + ' · ' + (layers[h.layer] ? layers[h.layer].name : ''); }
		return 'Net ' + L.nets.names[h.i] + '\n' + layers[h.layer].name;
	}

	// ---- search ----
	function find(q) {
		if (!L || !q) { return; }
		if (q !== lastQuery) {
			lastQuery = q;
			matchAt = -1;
			if (!nameIndex) {
				nameIndex = { inst: new Map(), net: new Map(), pin: new Map() };
				L.insts.names.forEach(function (n, i) { nameIndex.inst.set(n, i); });
				L.nets.names.forEach(function (n, i) { nameIndex.net.set(n, i); });
				L.pins.names.forEach(function (n, i) { nameIndex.pin.set(n, i); });
			}
			matches = [];
			['inst', 'net', 'pin'].forEach(function (k) { if (nameIndex[k].has(q)) { matches.push({ kind: k, i: nameIndex[k].get(q) }); } });
			const lq = q.toLowerCase();
			[['inst', L.insts.names], ['net', L.nets.names]].forEach(function (src) {
				for (let i = 0; i < src[1].length && matches.length < 1000; i++) {
					if (src[1][i].toLowerCase().includes(lq) && src[1][i] !== q) { matches.push({ kind: src[0], i: i }); }
				}
			});
		}
		if (!matches.length) { setMsg('No instance, net or pin matches "' + q + '".'); return; }
		matchAt = (matchAt + 1) % matches.length;
		const m = matches[matchAt];
		select({ kind: m.kind, i: m.i });
		zoomToSelection();
		setMsg('Match ' + (matchAt + 1) + ' of ' + matches.length + (matches.length >= 1000 ? '+' : '') + ' — Enter for next');
	}

	// ---- export ----
	function exportPng() {
		draw();
		const name = ((L && L.design) || 'layout') + (meta && meta.stage ? '_' + meta.stage : '') + '.png';
		vscode.postMessage({ type: 'savePng', dataUrl: canvas.toDataURL('image/png'), suggestedName: name.replace(/[^\w.-]+/g, '_') });
	}

	// ---- events ----
	btn.fit.addEventListener('click', fit);
	btn.in.addEventListener('click', function () { zoomAt(1.5, canvas.clientWidth / 2, canvas.clientHeight / 2); });
	btn.out.addEventListener('click', function () { zoomAt(1 / 1.5, canvas.clientWidth / 2, canvas.clientHeight / 2); });
	btn.png.addEventListener('click', exportPng);
	btn.panel.addEventListener('click', function () {
		side.hidden = !side.hidden;
		btn.panel.setAttribute('aria-pressed', String(!side.hidden));
	});
	btn.panel.setAttribute('aria-pressed', 'true');
	search.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { find(search.value.trim()); }
	});

	canvas.addEventListener('wheel', function (e) {
		if (!L) { return; }
		e.preventDefault();
		const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
		zoomAt(Math.exp(-dy * 0.002), e.offsetX, e.offsetY);
	}, { passive: false });

	let drag = null;
	canvas.addEventListener('pointerdown', function (e) {
		if (!L || e.button !== 0) { return; }
		stage.focus();
		drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, id: e.pointerId, moved: false };
	});
	let hoverPending = null;
	canvas.addEventListener('pointermove', function (e) {
		if (!L) { return; }
		const w = toWorld(e.offsetX, e.offsetY);
		coordText.textContent = 'x ' + um(w[0]) + '  y ' + um(w[1]) + ' µm';
		if (drag && e.pointerId === drag.id) {
			const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
			if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) { return; }
			if (!drag.moved) { drag.moved = true; canvas.setPointerCapture(drag.id); stage.classList.add('ly-panning'); tip.hidden = true; }
			view.cx = drag.cx - dx / view.s;
			view.cy = drag.cy + dy / view.s;
			fitted = false;
			schedule();
			return;
		}
		if (!hoverPending) {
			requestAnimationFrame(function () {
				const p = hoverPending;
				hoverPending = null;
				const hits = pickAll(p.x, p.y);
				if (!hits.length) { tip.hidden = true; return; }
				tip.textContent = describe(hits[0]);
				tip.hidden = false;
				const W = stage.clientWidth, H = stage.clientHeight;
				tip.style.left = Math.min(p.x + 14, Math.max(0, W - tip.offsetWidth - 4)) + 'px';
				tip.style.top = (p.y + 16 + tip.offsetHeight > H ? Math.max(0, p.y - tip.offsetHeight - 8) : p.y + 16) + 'px';   // flip above near the bottom edge
			});
		}
		hoverPending = { x: e.offsetX, y: e.offsetY };
	});
	canvas.addEventListener('pointerleave', function () { tip.hidden = true; });
	function endDrag(e) {
		if (!drag || e.pointerId !== drag.id) { return; }
		const wasClick = !drag.moved;
		drag = null;
		stage.classList.remove('ly-panning');
		if (!wasClick) { saveState(); return; }
		// Click: select the topmost object; clicking the same spot again cycles through what lies underneath.
		const hits = pickAll(e.offsetX, e.offsetY);
		const same = lastClick && Math.abs(lastClick.x - e.offsetX) < 3 && Math.abs(lastClick.y - e.offsetY) < 3;
		const n = same ? (lastClick.n + 1) % Math.max(hits.length, 1) : 0;
		lastClick = { x: e.offsetX, y: e.offsetY, n: n };
		select(hits.length ? hits[n] : null);
		if (hits.length > 1) { setMsg('Selected ' + (n + 1) + ' of ' + hits.length + ' objects here — click again to cycle'); }
	}
	canvas.addEventListener('pointerup', endDrag);
	canvas.addEventListener('pointercancel', endDrag);
	canvas.addEventListener('dblclick', function () {
		if (sel && sel.kind === 'inst') { vscode.postMessage({ type: 'reveal', kind: 'inst', name: L.insts.names[sel.i] }); }
	});
	stage.addEventListener('keydown', function (e) {
		if (!L) { return; }
		const W = canvas.clientWidth, H = canvas.clientHeight, step = 0.2 / view.s;
		const pan = { ArrowLeft: [-W * step, 0], ArrowRight: [W * step, 0], ArrowUp: [0, H * step], ArrowDown: [0, -H * step] }[e.key];
		if (pan) { view.cx += pan[0]; view.cy += pan[1]; fitted = false; saveState(); schedule(); }
		else if (e.key === 'f' || e.key === 'F') { fit(); }
		else if (e.key === '+' || e.key === '=') { zoomAt(1.5, W / 2, H / 2); }
		else if (e.key === '-') { zoomAt(1 / 1.5, W / 2, H / 2); }
		else if (e.key === 'Escape') { select(null); }
		else { return; }
		e.preventDefault();
	});

	new ResizeObserver(resize).observe(stage);
	// VS Code swaps the body class on theme changes; re-read the colours and redraw.
	new MutationObserver(function () { readTheme(); schedule(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
	readTheme();

	window.addEventListener('message', function (e) {
		const m = e.data;
		if (m && m.type === 'load') { load(m); }
	});
	vscode.postMessage({ type: 'ready' });
}());
