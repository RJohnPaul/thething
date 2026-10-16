/*---------------------------------------------------------------------------------------------
 *  Silicon Studio - netlist schematic rendering (Yosys write_json -> themeable SVG via netlistsvg).
 *  Runs in the extension host; no 'vscode' import.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';

export interface SchematicResult { svg: string; module: string; cellCount: number; truncated: false }

type NetlistSvg = { render(skin: string, netlist: unknown): Promise<string | undefined> };

// netlistsvg keeps layout state in module-level globals, so renders must never overlap.
let renderQueue: Promise<unknown> = Promise.resolve();

// Yosys writes integer attributes as binary strings ("000...001"); hide_name is a plain number.
const isSet = (v: unknown) => typeof v === 'string' ? v.includes('1') : !!v;

// netlistsvg concatenates names into the SVG without escaping them.
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escKeys = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [esc(k), v]));

export async function renderSchematicSvg(netlist: any, opts: { module?: string; maxCells?: number } = {}): Promise<SchematicResult> {
	const modules: Record<string, any> = netlist?.modules ?? {};
	const names = Object.keys(modules);
	const name = opts.module
		?? names.find(n => isSet(modules[n].attributes?.top))
		?? names.find(n => !isSet(modules[n].attributes?.blackbox));
	if (!name || !modules[name]) {
		throw new Error(opts.module
			? `Module "${opts.module}" is not in the netlist (available: ${names.join(', ') || 'none'}).`
			: 'The netlist contains no module that can be drawn.');
	}
	const mod = modules[name];
	const cells: Record<string, any> = mod.cells ?? {};
	const cellCount = Object.keys(cells).length;
	const maxCells = opts.maxCells ?? 2500;
	if (cellCount > maxCells) {
		throw new Error(`Module "${name}" has ${cellCount} cells, more than the schematic limit of ${maxCells}. ` +
			'Open a submodule instead, synthesize without flattening, or raise the limit.');
	}

	// Only the drawn module is passed on: netlistsvg ignores the others, and instances of them
	// render as generic boxes anyway. Paramod instances are labelled with the original module name.
	const reducedCells: Record<string, any> = {};
	for (const [k, c] of Object.entries(cells)) {
		reducedCells[esc(k)] = {
			...c,
			type: esc(modules[c.type]?.attributes?.hdlname ?? c.type),
			attributes: { ...c.attributes }, // netlistsvg writes into it; keep the caller's netlist untouched
			connections: escKeys(c.connections),
			port_directions: escKeys(c.port_directions),
		};
	}
	const reduced = { modules: { [esc(name)]: { attributes: { top: 1 }, ports: escKeys(mod.ports), cells: reducedCells } } };

	const netlistsvg: NetlistSvg = require('netlistsvg');
	const skin = fs.readFileSync(require.resolve('netlistsvg/lib/default.svg'), 'utf8');
	const run = renderQueue.then(() => netlistsvg.render(skin, reduced));
	renderQueue = run.catch(() => undefined);
	const raw = await run;
	if (typeof raw !== 'string' || !raw.includes('<svg')) {
		throw new Error(`Schematic layout failed for module "${name}" (netlistsvg returned no SVG; see the extension host log).`);
	}

	// Annotations for the webview: data-type on cells (info bar), data-net on wires (net name for "reveal").
	const typeOf: Record<string, string> = {};
	for (const [k, c] of Object.entries(reducedCells)) { typeOf[k] = c.type; }
	for (const [k, p] of Object.entries<any>(mod.ports ?? {})) { typeOf[esc(k)] = esc(p.direction); }
	const netOf: Record<string, string> = {};
	const nets = Object.entries<any>(mod.netnames ?? {})
		.sort((a, b) => Number(isSet(b[1].hide_name)) - Number(isSet(a[1].hide_name))); // visible names last, so they win
	for (const [n, w] of nets) {
		for (const bit of w.bits ?? []) { if (typeof bit === 'number') { netOf[bit] = esc(n); } }
	}

	const svg = raw
		.replace(/ id="cell_([^"]*)"/g, (m, k) => typeOf[k] ? `${m} data-type="${typeOf[k]}"` : m)
		.replace(/ class="net_(\d+)[^"]*"/g, (m, bit) => netOf[bit] ? `${m} data-net="${netOf[bit]}"` : m)
		// Theming: black ink follows the CSS `color`, white fills become transparent.
		.replace(/(fill|stroke)\s*:\s*(#000000|#000|black)\b/gi, '$1:currentColor')
		.replace(/fill\s*:\s*(#ffffff|#fff|white)\b/gi, 'fill:none')
		.replace(/<svg\b[^>]*>/, tag => {
			if (/\sviewBox=/.test(tag)) { return tag; }
			const w = /\swidth="([\d.]+)"/.exec(tag)?.[1];
			const h = /\sheight="([\d.]+)"/.exec(tag)?.[1];
			return w && h ? `${tag.slice(0, -1)} viewBox="0 0 ${w} ${h}">` : tag;
		});
	if (!/<svg\b[^>]*\sviewBox=/.test(svg)) {
		throw new Error(`Schematic for module "${name}" has no size information.`);
	}
	return { svg, module: name, cellCount, truncated: false };
}
