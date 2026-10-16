/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — webview panels: waveform viewer, netlist schematic, synthesis/compare reports.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseYosysSrc, ToolMessage } from './diagnostics';
import { RunRecord, RunStore } from './engine';
import { PNR_DIR, PNR_STAGES, PnrStage, statTotals } from './flows';
import { renderSchematicSvg } from './schematic';
import { KIND_LABEL, PNR_LABEL, prettyModule, stageHeadline } from './views';

const MAX_VCD_BYTES = 256 * 1024 * 1024;

function esc(s: unknown): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(webview: vscode.Webview, media: vscode.Uri, title: string, opts: { scripts?: string[]; styles?: string[]; body: string; css?: string }): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const csp = `default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
	const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
${(opts.styles ?? []).map(s => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
${opts.css ? `<style>${opts.css}</style>` : ''}
</head>
<body>
${opts.body}
${(opts.scripts ?? []).map(s => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n')}
</body>
</html>`;
}

async function saveData(suggestedName: string, data: Uint8Array, defaultDir: string | undefined): Promise<void> {
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(path.join(defaultDir ?? '', suggestedName)),
		filters: suggestedName.endsWith('.svg') ? { SVG: ['svg'] } : { PNG: ['png'] },
	});
	if (target) {
		await vscode.workspace.fs.writeFile(target, data);
		vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
	}
}

function dataUrlBytes(dataUrl: unknown): Uint8Array | undefined {
	const m = typeof dataUrl === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
	return m ? Buffer.from(m[1], 'base64') : undefined;
}

/** A single reusable webview panel that loads its content once the page reports 'ready'. */
class Panel {
	private panel: vscode.WebviewPanel | undefined;
	private ready = false;
	private last: unknown;

	constructor(private readonly viewType: string, private readonly media: vscode.Uri, private readonly scripts: string[], private readonly styles: string[], private readonly onMessage: (msg: any) => void) { }

	show(title: string, message: unknown): void {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(this.viewType, title, vscode.ViewColumn.Active, {
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.media],
			});
			this.ready = false;
			this.panel.webview.html = page(this.panel.webview, this.media, title, { scripts: this.scripts, styles: this.styles, body: '<div id="app"></div>' });
			this.panel.webview.onDidReceiveMessage(msg => {
				// The page announces 'ready' again whenever VS Code re-creates the webview (moved to another window, Reload Webviews).
				if (msg?.type === 'ready') {
					this.ready = true;
					if (this.last) {
						this.panel?.webview.postMessage(this.last);
					}
				} else {
					this.onMessage(msg);
				}
			});
			this.panel.onDidDispose(() => { this.panel = undefined; this.last = undefined; });
		}
		this.panel.title = title;
		this.panel.reveal();
		this.last = message;
		if (this.ready) {
			this.panel.webview.postMessage(message);
		}
	}
}

export class Panels {
	private readonly waveform: Panel;
	private readonly schematic: Panel;
	private readonly layout: Panel;
	private schematicContext: { netlist: any; module: string; store: RunStore } | undefined;
	private layoutContext: { store: RunStore; run: RunRecord } | undefined;
	private exportDir: string | undefined;

	constructor(private readonly extensionUri: vscode.Uri) {
		const media = vscode.Uri.joinPath(extensionUri, 'media');
		this.waveform = new Panel('siliconStudio.waveform', media, ['vcd.js', 'waveform.js'], ['waveform.css'], msg => this.onSaveOrError(msg));
		this.schematic = new Panel('siliconStudio.schematic', media, ['schematic.js'], ['schematic.css'], msg => this.onSchematicMessage(msg));
		this.layout = new Panel('siliconStudio.layout', media, ['layout.js'], ['layout.css'], msg => this.onLayoutMessage(msg));
	}

	/** Layout viewer selections jump to the instance or net in the final (or synthesized) netlist. */
	private async onLayoutMessage(msg: any): Promise<void> {
		if (msg?.type !== 'reveal') {
			return this.onSaveOrError(msg);
		}
		const ctx = this.layoutContext;
		if (!ctx || typeof msg.name !== 'string') {
			return;
		}
		const dir = ctx.store.runDir(ctx.run.id);
		const file = [path.join(dir, PNR_DIR, '6_final.v'), path.join(dir, 'inputs', '.silicon-netlist.v')].find(f => fs.existsSync(f));
		if (!file) {
			return;
		}
		const lines = fs.readFileSync(file, 'utf8').split('\n');
		const name = msg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = msg.kind === 'net' ? new RegExp(`\\b(wire|input|output)\\b.*\\b${name}\\b`) : new RegExp(`\\s${name}\\s*\\(`);
		const line = Math.max(0, lines.findIndex(l => re.test(l)));
		await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside, preview: true });
	}

	showLayout(store: RunStore, run: RunRecord, stage: PnrStage, layoutJson: string): void {
		this.layoutContext = { store, run };
		this.exportDir = path.join(store.project.root, 'exports');
		this.layout.show(`Layout — ${run.project.top} · ${PNR_LABEL[stage]}`, {
			type: 'load',
			title: `${run.project.top} · ${PNR_LABEL[stage]} · ${run.id}`,
			stage,
			layout: JSON.parse(fs.readFileSync(layoutJson, 'utf8')),
		});
	}

	showPhysicalReport(store: RunStore, run: RunRecord): void {
		const dir = store.runDir(run.id);
		const panel = vscode.window.createWebviewPanel('siliconStudio.report', `Physical Design — ${run.project.top}`, vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [vscode.Uri.file(dir)] });
		const img = (file: string) => panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
		panel.webview.html = page(panel.webview, this.extensionUri, panel.title, { css: REPORT_CSS + PHYSICAL_CSS, body: physicalReport(store, run, img) });
	}

	showScenarioComparison(store: RunStore, runs: RunRecord[]): void {
		const panel = vscode.window.createWebviewPanel('siliconStudio.report', 'Floorplan Scenarios', vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: runs.map(r => vscode.Uri.file(store.runDir(r.id))) });
		const img = (file: string) => panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
		panel.webview.html = page(panel.webview, this.extensionUri, panel.title, { css: REPORT_CSS + PHYSICAL_CSS, body: scenarioReport(store, runs, img) });
	}

	private async onSaveOrError(msg: any): Promise<void> {
		const name = String(msg?.suggestedName ?? 'export').replace(/[^\w.-]+/g, '_');
		if (msg?.type === 'savePng') {
			const bytes = dataUrlBytes(msg.dataUrl);
			if (bytes) {
				await saveData(name, bytes, this.exportDir);
			}
		} else if (msg?.type === 'saveSvg' && typeof msg.svg === 'string') {
			await saveData(name, Buffer.from(msg.svg, 'utf8'), this.exportDir);
		} else if (msg?.type === 'error') {
			vscode.window.showErrorMessage(`Waveform viewer: ${msg.message}`);
		}
	}

	private async onSchematicMessage(msg: any): Promise<void> {
		if (msg?.type !== 'reveal') {
			return this.onSaveOrError(msg);
		}
		const ctx = this.schematicContext;
		const mod = ctx?.netlist.modules?.[ctx.module];
		if (!ctx || !mod || typeof msg.name !== 'string') {
			return;
		}
		const src = (msg.kind === 'net' ? mod.netnames?.[msg.name] : mod.cells?.[msg.name])?.attributes?.src
			?? mod.netnames?.[msg.name]?.attributes?.src ?? mod.cells?.[msg.name]?.attributes?.src;
		const loc = typeof src === 'string' ? parseYosysSrc(src) : undefined;
		if (!loc) {
			vscode.window.setStatusBarMessage(`No source location recorded for ${msg.name}`, 4000);
			return;
		}
		const file = path.join(ctx.store.project.root, loc.file.replace(/^(\.\/)?inputs\//, ''));
		const line = Math.max(0, loc.line - 1);
		await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(line, Math.max(0, (loc.column ?? 1) - 1), line, Math.max(0, (loc.column ?? 1) - 1)), viewColumn: vscode.ViewColumn.Beside });
	}

	showWaveform(store: RunStore, run: RunRecord): void {
		const rel = run.metrics?.waveform as string | undefined;
		const file = rel && path.join(store.runDir(run.id), rel);
		if (!file || !fs.existsSync(file)) {
			vscode.window.showWarningMessage(`Simulation run ${run.id} has no waveform file.`);
			return;
		}
		if (file.endsWith('.fst')) {
			vscode.window.showWarningMessage('FST waveforms are not supported by the built-in viewer yet; dump VCD instead ($dumpfile("wave.vcd")).');
			return;
		}
		const size = fs.statSync(file).size;
		if (size > MAX_VCD_BYTES) {
			vscode.window.showErrorMessage(`Waveform is ${(size / 1e6).toFixed(0)} MB; the viewer limit is ${MAX_VCD_BYTES / 1e6} MB. Reduce the $dumpvars scope or simulation time.`);
			return;
		}
		this.exportDir = path.join(store.project.root, 'exports');
		this.waveform.show(`Waveform — ${run.project.name} (${run.id})`, { type: 'load', title: `${path.basename(file)} · ${run.id}`, vcd: fs.readFileSync(file, 'utf8') });
	}

	async showSchematic(store: RunStore, run: RunRecord, view: 'gate' | 'rtl'): Promise<void> {
		const file = path.join(store.runDir(run.id), 'outputs', view === 'gate' ? 'netlist.json' : 'rtl.json');
		if (!fs.existsSync(file)) {
			vscode.window.showWarningMessage(`Run ${run.id} has no ${view === 'gate' ? 'netlist' : 'RTL'} JSON.`);
			return;
		}
		const netlist = JSON.parse(fs.readFileSync(file, 'utf8'));
		try {
			const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Laying out schematic…' }, () => renderSchematicSvg(netlist));
			this.schematicContext = { netlist, module: result.module, store };
			this.exportDir = path.join(store.project.root, 'exports');
			const label = view === 'gate' ? 'gate-level' : 'RTL';
			this.schematic.show(`Schematic — ${prettyModule(result.module)} (${label})`, {
				type: 'load',
				title: `${prettyModule(result.module)} · ${label} · ${run.id}`,
				svg: result.svg,
				module: result.module,
				cellCount: result.cellCount,
				note: view === 'gate' ? 'Synthesized netlist after technology mapping.' : 'Elaborated RTL before synthesis (coarse-grained cells).',
			});
		} catch (e) {
			vscode.window.showErrorMessage(`Schematic: ${e.message}`);
		}
	}

	showSynthesisReport(store: RunStore, run: RunRecord): void {
		const panel = vscode.window.createWebviewPanel('siliconStudio.report', `Synthesis Report — ${run.project.name}`, vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
		panel.webview.html = page(panel.webview, this.extensionUri, panel.title, { css: REPORT_CSS, body: synthesisReport(store, run) });
	}

	showComparison(a: RunRecord, b: RunRecord): void {
		const panel = vscode.window.createWebviewPanel('siliconStudio.report', `Compare — ${a.id} ↔ ${b.id}`, vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
		panel.webview.html = page(panel.webview, this.extensionUri, panel.title, { css: REPORT_CSS, body: comparisonReport(a, b) });
	}
}

// ---------------------------------------------------------------------------------------------
// Static HTML reports

const REPORT_CSS = `
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 24px 40px; max-width: 1100px; line-height: 1.5; }
h1 { font-size: 1.6em; font-weight: 600; margin: 24px 0 4px; }
h2 { font-size: 1.15em; font-weight: 600; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
.sub { color: var(--vscode-descriptionForeground); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 600; margin-left: 8px; vertical-align: middle; border: 1px solid currentColor; }
.passed { color: var(--vscode-testing-iconPassed); } .failed { color: var(--vscode-testing-iconFailed); }
.error { color: var(--vscode-problemsWarningIcon-foreground); } .inconclusive, .cancelled, .running { color: var(--vscode-problemsInfoIcon-foreground); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin: 16px 0; }
.card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 10px 14px; background: var(--vscode-sideBar-background, transparent); }
.card .v { font-size: 1.5em; font-weight: 600; font-variant-numeric: tabular-nums; }
.card .k { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 3px 10px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.2)); vertical-align: top; }
th { color: var(--vscode-descriptionForeground); font-weight: 600; }
td.n, th.n { text-align: right; }
code, .mono { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
.note { border-left: 3px solid var(--vscode-textLink-foreground); padding: 6px 12px; background: var(--vscode-textBlockQuote-background); margin: 10px 0; }
.up { color: var(--vscode-testing-iconFailed); } .down { color: var(--vscode-testing-iconPassed); }
`;

function card(value: unknown, label: string): string {
	return `<div class="card"><div class="v">${esc(value ?? '—')}</div><div class="k">${esc(label)}</div></div>`;
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

/** Per-cell-type area from Yosys' text `stat -liberty` table ("count  area  CELL"). */
function areaByType(statText: string | undefined): Record<string, number> {
	const result: Record<string, number> = {};
	for (const m of (statText ?? '').matchAll(/^\s+\d+\s+([\d.]+)\s+(\S+)\s*$/gm)) {
		result[m[2]] = parseFloat(m[1]);
	}
	return result;
}

function cellTable(byType: Record<string, number>, area?: Record<string, number>): string {
	const rows = Object.entries(byType).sort((x, y) => y[1] - x[1]);
	if (!rows.length) {
		return '<p class="sub">No cells.</p>';
	}
	return `<table><tr><th>Cell type</th><th class="n">Count</th>${area ? '<th class="n">Area</th>' : ''}</tr>${rows.map(([t, n]) =>
		`<tr><td class="mono">${esc(t)}</td><td class="n">${n}</td>${area ? `<td class="n">${area[t] !== undefined ? area[t].toFixed(2) : '—'}</td>` : ''}</tr>`).join('')}</table>`;
}

function diagnosticsTable(store: RunStore, run: RunRecord): string {
	let msgs: ToolMessage[] = [];
	try {
		msgs = JSON.parse(fs.readFileSync(path.join(store.runDir(run.id), 'logs', 'diagnostics.json'), 'utf8'));
	} catch {
		// older run
	}
	if (!msgs.length) {
		return '<p class="sub">No warnings or errors.</p>';
	}
	return `<table><tr><th>Severity</th><th>Location</th><th>Message</th></tr>${msgs.map(m =>
		`<tr><td class="${m.severity === 'error' ? 'failed' : 'error'}">${esc(m.severity)}</td><td class="mono">${esc(m.file ? `${m.file.replace(/^inputs\//, '')}:${m.line ?? ''}` : '—')}</td><td>${esc(m.message)}</td></tr>`).join('')}</table>`;
}

function provenance(run: RunRecord): string {
	return `<table>
<tr><th>Run</th><td class="mono">${esc(run.id)}</td></tr>
<tr><th>Started</th><td>${esc(new Date(run.startedAt).toLocaleString())} (${((run.durationMs ?? 0) / 1000).toFixed(2)} s)</td></tr>
<tr><th>Execution</th><td>${esc(run.executionTarget)}</td></tr>
${run.steps.map(s => `<tr><th>${esc(s.tool)}</th><td>${esc(s.version)} · ${esc(s.mode)} · exit ${esc(s.exitCode ?? 'killed')} · <span class="mono">${esc(s.args.join(' '))}</span></td></tr>`).join('')}
<tr><th>Input digest</th><td class="mono">${esc(run.inputDigest)}</td></tr>
<tr><th>Config digest</th><td class="mono">${esc(run.configDigest)}</td></tr>
<tr><th>Environment</th><td>${esc(`${run.environment.app} ${run.environment.appVersion} · ${run.environment.platform}-${run.environment.arch} · ${run.environment.remote}`)}</td></tr>
${run.reproducedFrom ? `<tr><th>Reproduction of</th><td class="mono">${esc(run.reproducedFrom)} — ${run.reproduction?.identical ? 'identical outputs' : esc(run.reproduction?.differences.join('; '))}</td></tr>` : ''}
</table>
<h2>Inputs</h2>
<table><tr><th>File</th><th class="n">Bytes</th><th>SHA-256</th></tr>${run.inputs.map(i => `<tr><td class="mono">${esc(i.path)}</td><td class="n">${i.bytes}</td><td class="mono">${esc(i.sha256.slice(0, 16))}…</td></tr>`).join('')}</table>`;
}

function synthesisReport(store: RunStore, run: RunRecord): string {
	const dir = store.runDir(run.id);
	const m = (run.metrics ?? {}) as any;
	const generic = m.generic as ReturnType<typeof statTotals>;
	const mapped = m.mapped as ReturnType<typeof statTotals>;
	const rtl = m.rtl as ReturnType<typeof statTotals>;
	const area = areaByType(readText(path.join(dir, 'outputs', 'stat.txt')));
	const pdk = m.pdk as { name?: string; version?: string; source?: string } | undefined;
	return `
<h1>Synthesis report — ${esc(run.project.name)}<span class="badge ${esc(run.status)}">${esc(run.status)}</span></h1>
<div class="sub">Top module <code>${esc(run.project.top)}</code> · ${esc(run.summary)}</div>
<div class="cards">
${mapped ? card(mapped.cells, 'standard cells (mapped)') : ''}
${mapped?.area !== undefined ? card(mapped.area.toFixed(2), `cell area · ${m.liberty ?? ''}`) : ''}
${mapped?.sequentialArea !== undefined ? card(mapped.sequentialArea.toFixed(2), 'sequential area') : ''}
${card(generic?.cells, 'generic gates (tech-independent)')}
${card(generic?.wires, 'wires')}
${card(rtl?.cells, 'RTL cells before synthesis')}
</div>
<div class="note">Generic gate counts are technology-independent Yosys primitives and are <b>not</b> standard-cell area.
${mapped ? `Area comes from the liberty library <code>${esc(m.liberty)}</code>${pdk?.source ? ` (${esc(pdk.source)})` : ''}.` : 'No liberty library is configured, so standard-cell area was not computed — set <code>synthesis.liberty</code> in silicon.json.'}
No static timing analysis was performed in this release (OpenSTA integration is planned), and a synthesized netlist is not a signed-off design.</div>
${mapped ? `<h2>Standard-cell mapping</h2>${cellTable(mapped.cellsByType, area)}` : ''}
<h2>Generic logic</h2>${generic ? cellTable(generic.cellsByType) : '<p class="sub">Not available.</p>'}
<h2>RTL cells (before synthesis)</h2>${rtl ? cellTable(rtl.cellsByType) : '<p class="sub">Not available.</p>'}
<h2>Diagnostics</h2>${diagnosticsTable(store, run)}
<h2>Configuration</h2>
<table><tr><th>Flatten</th><td>${m.flatten ? 'yes' : 'no'}</td></tr><tr><th>ABC</th><td>${m.abc ? 'yes' : 'no'}</td></tr><tr><th>Liberty</th><td>${esc(m.liberty ?? 'none (generic gates only)')}</td></tr>
<tr><th>PDK</th><td>${esc(pdk ? `${pdk.name ?? ''} ${pdk.version ?? ''}` : '—')}</td></tr><tr><th>Script</th><td class="mono">outputs/synth.ys</td></tr></table>
<h2>Provenance</h2>${provenance(run)}`;
}

function delta(a: number | undefined, b: number | undefined, digits = 0): string {
	if (a === undefined || b === undefined) {
		return '';
	}
	const d = b - a;
	return d === 0 ? '<span class="sub">=</span>' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d.toFixed(digits)}</span>`;
}

function comparisonReport(a: RunRecord, b: RunRecord): string {
	const ma = (a.metrics ?? {}) as any;
	const mb = (b.metrics ?? {}) as any;
	const row = (label: string, x: unknown, y: unknown, d = '') => `<tr><th>${esc(label)}</th><td>${esc(x ?? '—')}</td><td>${esc(y ?? '—')}</td><td class="n">${d}</td></tr>`;
	let metrics = '';
	if (a.kind === 'synth' && b.kind === 'synth') {
		metrics += row('Mapped cells', ma.mapped?.cells, mb.mapped?.cells, delta(ma.mapped?.cells, mb.mapped?.cells));
		metrics += row('Cell area', ma.mapped?.area?.toFixed(2), mb.mapped?.area?.toFixed(2), delta(ma.mapped?.area, mb.mapped?.area, 2));
		metrics += row('Generic gates', ma.generic?.cells, mb.generic?.cells, delta(ma.generic?.cells, mb.generic?.cells));
		metrics += row('Wires', ma.generic?.wires, mb.generic?.wires, delta(ma.generic?.wires, mb.generic?.wires));
		metrics += row('Flatten / ABC', `${ma.flatten} / ${ma.abc}`, `${mb.flatten} / ${mb.abc}`);
		metrics += row('Liberty', ma.liberty ?? 'none', mb.liberty ?? 'none');
	} else {
		for (const k of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
			metrics += row(k, typeof ma[k] === 'object' ? JSON.stringify(ma[k]) : ma[k], typeof mb[k] === 'object' ? JSON.stringify(mb[k]) : mb[k],
				typeof ma[k] === 'number' && typeof mb[k] === 'number' ? delta(ma[k], mb[k]) : '');
		}
	}
	const typesA = (ma.mapped ?? ma.generic)?.cellsByType ?? {};
	const typesB = (mb.mapped ?? mb.generic)?.cellsByType ?? {};
	const types = [...new Set([...Object.keys(typesA), ...Object.keys(typesB)])].sort();
	const inputsA = new Map(a.inputs.map(i => [i.path, i.sha256]));
	const changed = b.inputs.filter(i => inputsA.get(i.path) !== i.sha256).map(i => i.path);
	const removed = a.inputs.filter(i => !b.inputs.some(j => j.path === i.path)).map(i => i.path);
	return `
<h1>Run comparison</h1>
<div class="sub">${esc(KIND_LABEL[a.kind])} <code>${esc(a.id)}</code> ↔ ${esc(KIND_LABEL[b.kind])} <code>${esc(b.id)}</code></div>
<h2>Results</h2>
<table><tr><th></th><th>A · ${esc(a.id)}</th><th>B · ${esc(b.id)}</th><th class="n">Δ (B − A)</th></tr>
${row('Status', a.status, b.status)}
${row('Summary', a.summary, b.summary)}
${row('Started', new Date(a.startedAt).toLocaleString(), new Date(b.startedAt).toLocaleString())}
${row('Duration (s)', ((a.durationMs ?? 0) / 1000).toFixed(2), ((b.durationMs ?? 0) / 1000).toFixed(2))}
${metrics}
${row('Tools', a.steps.map(s => `${s.tool} ${s.version}`).join(', '), b.steps.map(s => `${s.tool} ${s.version}`).join(', '))}
${row('Config digest', a.configDigest.slice(0, 16), b.configDigest.slice(0, 16), a.configDigest === b.configDigest ? 'same' : 'differs')}
${row('Input digest', a.inputDigest.slice(0, 16), b.inputDigest.slice(0, 16), a.inputDigest === b.inputDigest ? 'same' : 'differs')}
</table>
${types.length ? `<h2>Cells by type</h2><table><tr><th>Type</th><th class="n">A</th><th class="n">B</th><th class="n">Δ</th></tr>${types.map(t =>
		`<tr><td class="mono">${esc(t)}</td><td class="n">${typesA[t] ?? 0}</td><td class="n">${typesB[t] ?? 0}</td><td class="n">${delta(typesA[t] ?? 0, typesB[t] ?? 0)}</td></tr>`).join('')}</table>` : ''}
<h2>Input changes</h2>
${changed.length || removed.length ? `<table>${changed.map(p => `<tr><td class="mono">${esc(p)}</td><td>${inputsA.has(p) ? 'modified' : 'added'}</td></tr>`).join('')}${removed.map(p => `<tr><td class="mono">${esc(p)}</td><td>removed</td></tr>`).join('')}</table>` : '<p class="sub">Identical inputs.</p>'}`;
}

// ---------------------------------------------------------------------------------------------
// Physical design reports

const PHYSICAL_CSS = `
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin: 12px 0; }
.shot { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; overflow: hidden; background: var(--vscode-sideBar-background, transparent); }
.shot img { width: 100%; display: block; background: #000; image-rendering: auto; }
.shot .cap { padding: 6px 10px; font-size: 0.9em; }
pre.rpt { font-family: var(--vscode-editor-font-family); font-size: 0.85em; background: var(--vscode-textCodeBlock-background); padding: 10px; overflow: auto; max-height: 360px; border-radius: 4px; }
td.best { font-weight: 600; color: var(--vscode-testing-iconPassed); }
`;

type StageMetrics = Record<string, number | string | null | undefined> & { status?: string };

function stagesOf(run: RunRecord): Partial<Record<PnrStage | 'gds', StageMetrics>> {
	return (run.metrics?.stages ?? {}) as Partial<Record<PnrStage | 'gds', StageMetrics>>;
}

function images(store: RunStore, run: RunRecord): { stage: PnrStage; file: string; label: string }[] {
	const dir = path.join(store.runDir(run.id), PNR_DIR, 'images');
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort() : [];
	return PNR_STAGES.flatMap(stage => files.filter(f => f.startsWith(stage)).map(f => ({ stage, file: path.join(dir, f), label: `${PNR_LABEL[stage]}${f === `${stage}.png` ? '' : ` — ${f.slice(stage.length + 1, -4).replace(/_/g, ' ')}`}` })));
}

function metricRows(m: StageMetrics | undefined): string {
	const entries = Object.entries(m ?? {}).filter(([k, v]) => k !== 'status' && k !== 'from' && v !== null && v !== undefined && v !== '');
	return entries.length ? `<table>${entries.map(([k, v]) => `<tr><th>${esc(k.replace(/_/g, ' '))}</th><td class="n">${esc(typeof v === 'number' ? +v.toFixed(4) : v)}</td></tr>`).join('')}</table>` : '<p class="sub">No metrics.</p>';
}

function reportExcerpt(store: RunStore, run: RunRecord, names: RegExp, maxLines = 60): string {
	const dir = path.join(store.runDir(run.id), PNR_DIR, 'reports');
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => names.test(f) && !f.endsWith('.json')).sort() : [];
	return files.map(f => `<h3>${esc(f)}</h3><pre class="rpt">${esc(readText(path.join(dir, f))?.split('\n').slice(0, maxLines).join('\n') ?? '')}</pre>`).join('');
}

function physicalReport(store: RunStore, run: RunRecord, img: (file: string) => string): string {
	const st = stagesOf(run);
	const m = (run.metrics ?? {}) as { platform?: string; scenario?: string; floorplan?: Record<string, unknown> };
	const rows = PNR_STAGES.map(stage => {
		const s = st[stage];
		return `<tr><td>${esc(PNR_LABEL[stage])}</td><td class="${s ? (s.status === 'failed' ? 'failed' : 'passed') : 'sub'}">${esc(s?.status ?? 'not run')}</td><td>${esc(s ? stageHeadline(stage, s) : '')}</td></tr>`;
	}).join('');
	const gds = path.join(store.runDir(run.id), PNR_DIR, '6_final.gds');
	return `
<h1>Physical design — ${esc(run.project.top)}<span class="badge ${esc(run.status)}">${esc(run.status)}</span></h1>
<div class="sub">${esc(run.summary)}</div>
<div class="cards">
${card(m.platform, 'platform')}
${card(m.scenario ?? 'default', 'floorplan scenario')}
${card(stageHeadline('floorplan', st.floorplan) || '—', 'die / utilization')}
${card(st.route?.drc_violations ?? '—', 'routing DRC violations')}
${card(stageHeadline('finish', st.finish) || '—', 'signoff timing / power')}
${card(fs.existsSync(gds) ? `${(fs.statSync(gds).size / 1024).toFixed(0)} KB` : 'not written', 'GDSII (6_final.gds)')}
</div>
<div class="note">OpenROAD timing uses the platform's single liberty corner and OpenRCX parasitics. Routing DRC comes from the detailed router's
rule checks, not a foundry signoff deck. The GDSII is <b>not</b> manufacturing-ready.</div>
<h2>Stages</h2>
<table><tr><th>Stage</th><th>Status</th><th>Result</th></tr>${rows}</table>
<h2>Layout snapshots</h2>
<div class="shots">${images(store, run).map(i => `<div class="shot"><img src="${img(i.file)}" alt="${esc(i.label)}"><div class="cap">${esc(i.label)}</div></div>`).join('') || '<p class="sub">No images were produced.</p>'}</div>
${PNR_STAGES.filter(stage => st[stage]).map(stage => `<h2>${esc(PNR_LABEL[stage])} metrics</h2>${metricRows(st[stage])}`).join('')}
<h2>Timing and power reports</h2>${reportExcerpt(store, run, /^finish\.rpt$/, 400) || '<p class="sub">Run the flow through signoff to get timing and power reports.</p>'}
<h2>Floorplan settings</h2><pre class="rpt">${esc(JSON.stringify(m.floorplan ?? {}, undefined, 2))}</pre>
<h2>Provenance</h2>${provenance(run)}`;
}

function scenarioReport(store: RunStore, runs: RunRecord[], img: (file: string) => string): string {
	const col = (label: string, get: (st: ReturnType<typeof stagesOf>) => number | undefined, best: 'min' | 'max', digits = 2) => {
		const values = runs.map(r => get(stagesOf(r)));
		const known = values.filter((v): v is number => typeof v === 'number');
		const target = known.length ? (best === 'min' ? Math.min(...known) : Math.max(...known)) : undefined;
		return `<tr><th>${esc(label)}</th>${values.map(v => `<td class="n${v === target && known.length > 1 ? ' best' : ''}">${v === undefined ? '—' : v.toFixed(digits)}</td>`).join('')}</tr>`;
	};
	const n = (m: StageMetrics | undefined, ...keys: string[]) => keys.map(k => m?.[k]).find((v): v is number => typeof v === 'number');
	return `
<h1>Floorplan scenario exploration</h1>
<div class="sub">${runs.length} scenario run${runs.length === 1 ? '' : 's'} of ${esc(runs[0]?.project.top ?? '')} · best value per row highlighted</div>
<table>
<tr><th></th>${runs.map(r => `<th>${esc(String(r.metrics?.scenario ?? 'default'))}<div class="sub">${esc(r.status)}</div></th>`).join('')}</tr>
${col('Die area (µm²)', st => n(st.floorplan, 'die_area_um2'), 'min', 1)}
${col('Core utilization (%)', st => n(st.floorplan, 'utilization_pct', 'utilization'), 'max', 1)}
${col('HPWL after placement (µm)', st => n(st.place, 'hpwl_um', 'wirelength_um'), 'min', 0)}
${col('Clock skew (ns)', st => n(st.cts, 'clock_skew_setup_ns', 'clock_skew_ns'), 'min', 3)}
${col('Routed wirelength (µm)', st => n(st.route, 'wirelength_um', 'routed_wirelength_um'), 'min', 0)}
${col('Routing DRC violations', st => n(st.route, 'drc_violations'), 'min', 0)}
${col('Worst setup slack (ns)', st => n(st.finish, 'setup_ws_ns') ?? n(st.cts, 'setup_ws_ns') ?? n(st.place, 'setup_ws_ns'), 'max', 3)}
${col('Total power (mW)', st => n(st.finish, 'total_power_mw', 'power_total_mw'), 'min', 4)}
</table>
<h2>Floorplans and placements</h2>
${runs.map(r => `<h3>${esc(String(r.metrics?.scenario ?? 'default'))} — <span class="sub">${esc(r.summary)}</span></h3>
<div class="shots">${images(store, r).filter(i => i.stage === 'floorplan' || i.stage === 'place' || i.stage === 'route').map(i => `<div class="shot"><img src="${img(i.file)}" alt="${esc(i.label)}"><div class="cap">${esc(i.label)}</div></div>`).join('') || '<p class="sub">No images.</p>'}</div>
<pre class="rpt">${esc(JSON.stringify(r.metrics?.floorplan ?? {}, undefined, 2))}</pre>`).join('')}`;
}
