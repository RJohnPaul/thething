// Silicon Studio - netlist schematic webview: pan/zoom, cell selection, net highlighting, SVG/PNG export.
// The page only needs to load this script and schematic.css; the DOM is built here.
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const DROPPED = new Set(['script', 'foreignobject', 'iframe', 'set', 'animate']);

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		e.className = cls;
		if (text) { e.textContent = text; }
		return e;
	}

	const toolbar = el('div', 'ss-toolbar');
	const title = el('span', 'ss-title', 'Schematic');
	toolbar.appendChild(title);
	const buttons = {};
	[['out', '−', 'Zoom out'], ['in', '+', 'Zoom in'], ['fit', 'Fit', 'Fit to window'], ['one', '1:1', 'Actual size'],
		['svg', 'Export SVG', 'Save the schematic as SVG'], ['png', 'Export PNG', 'Save the schematic as PNG']].forEach(function (b) {
		const btn = el('button', 'ss-btn', b[1]);
		btn.type = 'button';
		btn.title = b[2];
		btn.setAttribute('aria-label', b[2]);
		btn.disabled = true;
		buttons[b[0]] = btn;
		toolbar.appendChild(btn);
	});
	const stage = el('div', 'ss-stage');
	stage.tabIndex = 0;
	const info = el('div', 'ss-info', 'Waiting for netlist…');
	info.setAttribute('role', 'status');
	document.body.append(toolbar, stage, info);

	let svg = null;      // live <svg> element
	let full = null;     // original viewBox {x,y,w,h}
	let vb = null;       // current viewBox
	let meta = null;     // last 'load' message
	let summary = '';

	function setInfo(text, isError) {
		info.textContent = text;
		info.classList.toggle('ss-error', !!isError);
	}

	// Only the netlistsvg drawing is wanted: drop active content and external references.
	function sanitize(root) {
		[root].concat(Array.from(root.querySelectorAll('*'))).forEach(function (node) {
			if (DROPPED.has(node.localName.toLowerCase())) { node.remove(); return; }
			Array.from(node.attributes).forEach(function (a) {
				const n = a.localName.toLowerCase();
				if (n.startsWith('on') || (n === 'href' && !a.value.trim().startsWith('#'))) { node.removeAttributeNode(a); }
			});
		});
	}

	// Wires are 1px lines; invisible wide copies underneath the cells make them easy to click.
	function addHitLines(root) {
		const g = document.createElementNS(SVG_NS, 'g');
		g.setAttribute('class', 'ss-hits');
		root.querySelectorAll('line[class^="net_"]').forEach(function (line) {
			const hit = line.cloneNode(false);
			hit.setAttribute('data-cls', line.getAttribute('class'));
			hit.setAttribute('class', 'ss-hit');
			g.appendChild(hit);
		});
		root.insertBefore(g, root.firstChild);
	}

	function load(msg) {
		const doc = new DOMParser().parseFromString(msg.svg, 'image/svg+xml');
		const root = doc.documentElement;
		const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
		if (root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length ||
			box.length !== 4 || box.some(isNaN) || box[2] <= 0 || box[3] <= 0) {
			setInfo('Could not display the schematic: the SVG is invalid.', true);
			return;
		}
		sanitize(root);
		const node = document.importNode(root, true);
		node.removeAttribute('width');
		node.removeAttribute('height');
		addHitLines(node);
		stage.replaceChildren(node);
		svg = node;
		meta = msg;
		full = { x: box[0], y: box[1], w: box[2], h: box[3] };
		title.textContent = msg.title || msg.module;
		summary = msg.module + ': ' + msg.cellCount + ' cell' + (msg.cellCount === 1 ? '' : 's') + (msg.note ? ' — ' + msg.note : '');
		clearSelection();
		const st = vscode.getState();
		setView(st && st.key === (msg.title || msg.module) && st.vb ? st.vb : full);
		Object.keys(buttons).forEach(function (k) { buttons[k].disabled = false; });
	}

	function setView(v) {
		vb = { x: v.x, y: v.y, w: v.w, h: v.h };
		svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
		vscode.setState({ key: meta.title || meta.module, vb: vb });
	}

	// Screen pixels per SVG unit for a viewBox (preserveAspectRatio "meet").
	function scaleOf(v) {
		return Math.min(stage.clientWidth / v.w, stage.clientHeight / v.h);
	}

	// Zoom by k keeping the SVG point under (cx, cy) fixed on screen.
	function zoom(k, cx, cy) {
		const ctm = svg && svg.getScreenCTM();
		if (!ctm || !stage.clientWidth || !stage.clientHeight) { return; }
		const s = scaleOf(vb);
		k = Math.min(Math.max(s * k, scaleOf(full) / 4), 20) / s;
		const p = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
		setView({ x: p.x - (p.x - vb.x) / k, y: p.y - (p.y - vb.y) / k, w: vb.w / k, h: vb.h / k });
	}

	function zoomCenter(k) {
		const r = stage.getBoundingClientRect();
		zoom(k, r.left + r.width / 2, r.top + r.height / 2);
	}

	function actualSize() {
		const w = stage.clientWidth, h = stage.clientHeight;
		if (!w || !h) { return; }
		setView({ x: vb.x + vb.w / 2 - w / 2, y: vb.y + vb.h / 2 - h / 2, w: w, h: h });
	}

	// What a click landed on: a net (wire, junction or hit line) or a cell group.
	function pick(target) {
		if (!svg || !(target instanceof Element) || !svg.contains(target)) { return null; }
		const hit = target.closest('.ss-hit');
		const cls = hit ? hit.getAttribute('data-cls') : Array.from(target.classList).find(function (c) { return c.startsWith('net_'); });
		if (cls) { return { kind: 'net', cls: cls, el: hit || target }; }
		const cell = target.closest('g[id^="cell_"]');
		return cell ? { kind: 'cell', el: cell } : null;
	}

	function clearSelection() {
		if (svg) {
			svg.querySelectorAll('.ss-sel, .ss-hl').forEach(function (e) { e.classList.remove('ss-sel', 'ss-hl'); });
		}
		setInfo(summary);
	}

	function select(target) {
		clearSelection();
		const p = pick(target);
		if (!p) { return; }
		if (p.kind === 'cell') {
			p.el.classList.add('ss-sel');
			const type = p.el.getAttribute('data-type') || p.el.getAttribute('s:type') || '';
			setInfo('Cell ' + p.el.id.slice(5) + (type ? ' · ' + type : ''));
		} else {
			Array.from(svg.getElementsByClassName(p.cls)).forEach(function (e) { e.classList.add('ss-hl'); });
			const bits = p.cls.slice(4).split(',').length;
			setInfo('Net ' + (p.el.getAttribute('data-net') || p.cls) + ' · ' + bits + ' bit' + (bits === 1 ? '' : 's'));
		}
	}

	function fileName(ext) {
		return ((meta && meta.module) || 'schematic').replace(/[^\w.-]+/g, '_') + '.' + ext;
	}

	// Standalone copy of the whole drawing with the current theme colours baked in.
	function exportSvgText() {
		const c = svg.cloneNode(true);
		const hits = c.querySelector('.ss-hits');
		if (hits) { hits.remove(); }
		c.querySelectorAll('.ss-sel, .ss-hl').forEach(function (e) { e.classList.remove('ss-sel', 'ss-hl'); });
		const cs = getComputedStyle(stage);
		const bg = document.createElementNS(SVG_NS, 'rect');
		bg.setAttribute('x', full.x);
		bg.setAttribute('y', full.y);
		bg.setAttribute('width', full.w);
		bg.setAttribute('height', full.h);
		bg.setAttribute('style', 'fill:' + cs.backgroundColor + ';stroke:none');
		c.insertBefore(bg, c.firstChild);
		c.setAttribute('viewBox', full.x + ' ' + full.y + ' ' + full.w + ' ' + full.h);
		c.setAttribute('width', full.w);
		c.setAttribute('height', full.h);
		c.setAttribute('style', 'color:' + cs.color);
		return new XMLSerializer().serializeToString(c);
	}

	function exportPng() {
		const img = new Image();
		img.onload = function () {
			const scale = Math.min(2, 8192 / full.w, 8192 / full.h); // stay inside canvas size limits
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(full.w * scale));
			canvas.height = Math.max(1, Math.round(full.h * scale));
			canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
			vscode.postMessage({ type: 'savePng', dataUrl: canvas.toDataURL('image/png'), suggestedName: fileName('png') });
		};
		img.onerror = function () { setInfo('PNG export failed.', true); };
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(exportSvgText());
	}

	buttons.in.addEventListener('click', function () { zoomCenter(1.25); });
	buttons.out.addEventListener('click', function () { zoomCenter(0.8); });
	buttons.fit.addEventListener('click', function () { setView(full); });
	buttons.one.addEventListener('click', actualSize);
	buttons.svg.addEventListener('click', function () {
		vscode.postMessage({ type: 'saveSvg', svg: exportSvgText(), suggestedName: fileName('svg') });
	});
	buttons.png.addEventListener('click', exportPng);

	stage.addEventListener('wheel', function (e) {
		if (!svg) { return; }
		e.preventDefault();
		const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
		zoom(Math.exp(-dy * 0.002), e.clientX, e.clientY);
	}, { passive: false });

	// Pan by drag; a press that does not move becomes a normal click (selection).
	let drag = null;
	let dragged = false;
	stage.addEventListener('pointerdown', function (e) {
		if (svg && e.button === 0) { drag = { x: e.clientX, y: e.clientY, vb: vb, id: e.pointerId }; dragged = false; }
	});
	stage.addEventListener('pointermove', function (e) {
		if (!drag || e.pointerId !== drag.id) { return; }
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (!dragged) {
			if (Math.abs(dx) + Math.abs(dy) < 4) { return; }
			dragged = true;
			stage.setPointerCapture(drag.id);
			stage.classList.add('ss-panning');
		}
		const s = scaleOf(drag.vb);
		setView({ x: drag.vb.x - dx / s, y: drag.vb.y - dy / s, w: drag.vb.w, h: drag.vb.h });
	});
	function endDrag() {
		drag = null;
		stage.classList.remove('ss-panning');
	}
	stage.addEventListener('pointerup', endDrag);
	stage.addEventListener('pointercancel', endDrag);
	stage.addEventListener('click', function (e) {
		if (dragged) { dragged = false; return; }
		select(e.target);
	});
	stage.addEventListener('dblclick', function (e) {
		const p = pick(e.target);
		const name = p && (p.kind === 'cell' ? p.el.id.slice(5) : p.el.getAttribute('data-net'));
		if (name) { vscode.postMessage({ type: 'reveal', name: name, kind: p.kind }); }
	});
	window.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') { clearSelection(); }
	});

	window.addEventListener('message', function (e) {
		const m = e.data;
		if (m && m.type === 'load' && typeof m.svg === 'string') { load(m); }
	});
	vscode.postMessage({ type: 'ready' });
}());
