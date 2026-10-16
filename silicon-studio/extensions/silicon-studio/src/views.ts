/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — tree views: Flow (stage navigator, PRD 6.2), Run History, Design Hierarchy.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseYosysSrc } from './diagnostics';
import { digestEntries, RunRecord, RunStatus, RunStore, ToolInfo, ToolName, valueDigest } from './engine';
import { physicalDigest, PnrStage } from './flows';
import { CONFIG_FILE, inputFiles, ProjectConfig, RunKind } from './project';

export const KIND_LABEL: Record<RunKind, string> = { lint: 'Lint', sim: 'Simulation', synth: 'Synthesis', equiv: 'Equivalence', pnr: 'Place & Route' };
export const PNR_LABEL: Record<PnrStage, string> = { floorplan: 'Floorplan', pdn: 'Power grid', place: 'Placement', cts: 'Clock tree', route: 'Routing', finish: 'Extraction & signoff timing' };

/** The latest place-and-route run matching `predicate`, preferring runs of the active floorplan scenario. */
export function latestPnr(store: RunStore, predicate: (r: RunRecord) => boolean = () => true): RunRecord | undefined {
	const active = store.project.config.physical?.activeScenario;
	return store.latest('pnr', r => predicate(r) && r.metrics?.scenario === active) ?? store.latest('pnr', predicate);
}

/** The latest place-and-route run that executed (or reused) a stage. */
export function latestPnrWith(store: RunStore, stage: PnrStage): RunRecord | undefined {
	return latestPnr(store, r => !!(r.metrics?.stages as Record<string, unknown> | undefined)?.[stage]);
}

/** The configuration that matters to lint, simulation, synthesis and equivalence (not floorplan settings). */
function logicalConfigDigest(config: ProjectConfig): string {
	return valueDigest({ ...config, id: undefined, name: undefined, physical: config.physical ? { platform: config.physical.platform } : undefined });
}

/** Shared, cheap-to-read state the views render from. */
export interface Workspace {
	store(): RunStore | undefined;
	tools(): Record<ToolName, ToolInfo> | undefined;
	running(): RunKind | undefined;
}

export function statusIcon(status: RunStatus | 'none'): vscode.ThemeIcon {
	switch (status) {
		case 'passed': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
		case 'failed': return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
		case 'error': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
		case 'inconclusive': return new vscode.ThemeIcon('question', new vscode.ThemeColor('problemsInfoIcon.foreground'));
		case 'cancelled': return new vscode.ThemeIcon('circle-slash');
		case 'running': return new vscode.ThemeIcon('sync~spin');
		default: return new vscode.ThemeIcon('circle-large-outline');
	}
}

export function timeAgo(iso: string): string {
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) {
		return 'just now';
	}
	const units: [number, string][] = [[86400, 'd'], [3600, 'h'], [60, 'm']];
	const [div, unit] = units.find(([d]) => s >= d)!;
	return `${Math.floor(s / div)}${unit} ago`;
}

/** Inputs of `kind` changed since `run` was taken → its results are stale (PRD 9). */
export class Staleness {
	private digests = new Map<RunKind, string | undefined>();

	constructor(private readonly store: RunStore) { }

	isStale(run: RunRecord): boolean {
		// Equivalence and place-and-route are about one specific netlist: a newer synthesis supersedes them.
		if ((run.kind === 'equiv' || run.kind === 'pnr') && run.basedOn !== this.store.latest('synth', r => r.status === 'passed')?.id) {
			return true;
		}
		if (run.kind === 'pnr') {
			// The netlist's synthesis must itself be current, and the physical settings it used unchanged.
			const synth = run.basedOn ? this.store.get(run.basedOn) : undefined;
			if (!synth || this.isStale(synth)) {
				return true;
			}
			try {
				return physicalDigest(this.store.project.config, (run.metrics?.scenario as string | undefined) ?? '') !== run.metrics?.physicalDigest;
			} catch {
				return true; // the scenario no longer exists
			}
		}
		// Floorplan settings live in silicon.json but do not affect these runs: compare files without it,
		// and the configuration without the physical section (except the platform, which picks the cells).
		const kind = run.kind === 'equiv' ? 'synth' : run.kind;
		if (!this.digests.has(kind)) {
			try {
				const files = inputFiles(this.store.project.root, this.store.project.config, kind).filter(f => f !== CONFIG_FILE);
				this.digests.set(kind, this.store.currentDigest(files));
			} catch {
				this.digests.set(kind, undefined);
			}
		}
		const files = digestEntries(run.inputs.filter(i => i.path !== CONFIG_FILE && !i.path.startsWith('.silicon-')));
		if (this.digests.get(kind) !== files) {
			return true;
		}
		try {
			const snapshot = JSON.parse(fs.readFileSync(path.join(this.store.runDir(run.id), 'inputs', CONFIG_FILE), 'utf8')) as ProjectConfig;
			return logicalConfigDigest(snapshot) !== logicalConfigDigest(this.store.project.config);
		} catch {
			return true;
		}
	}
}

export function runTooltip(run: RunRecord, stale: boolean): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.appendMarkdown(`**${KIND_LABEL[run.kind]} — ${run.status}**${stale ? ' · ⚠ stale (inputs changed since this run)' : ''}\n\n`);
	md.appendText(run.summary + '\n\n');
	md.appendMarkdown(`Run \`${run.id}\` · ${new Date(run.startedAt).toLocaleString()}${run.durationMs !== undefined ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}\n\n`);
	md.appendMarkdown(`Execution: ${run.executionTarget}\n\n`);
	for (const s of run.steps) {
		md.appendMarkdown(`- \`${s.tool}\` ${s.version} (${s.mode}) → exit ${s.exitCode ?? 'killed'}\n`);
	}
	if (run.reproduction) {
		md.appendMarkdown(`\nReproduction of \`${run.reproducedFrom}\`: ${run.reproduction.identical ? 'identical outputs ✓' : run.reproduction.differences.join(', ')}\n`);
	}
	md.appendMarkdown(`\nInput digest \`${run.inputDigest.slice(0, 12)}\``);
	return md;
}

// ---------------------------------------------------------------------------------------------
// Flow (stage navigator)

type FlowNode =
	| { type: 'stage'; index: number; title: string; children: FlowNode[] }
	| { type: 'step'; kind: RunKind | 'export'; label: string }
	| { type: 'pnr'; stage: PnrStage }
	| { type: 'check'; label: string; value: string; ok: boolean | undefined; tooltip: string }
	| { type: 'link'; label: string; icon: string; command: vscode.Command; description?: string };

type Metrics = Record<string, number | string | null | undefined>;

function num(m: Metrics | undefined, ...keys: string[]): number | undefined {
	for (const k of keys) {
		const v = m?.[k];
		if (typeof v === 'number' && isFinite(v)) {
			return v;
		}
	}
	return undefined;
}

/** One headline number per stage, from that stage's metrics.json. */
export function stageHeadline(stage: PnrStage, m: Metrics | undefined): string {
	const f = (v: number | undefined, unit: string, digits = 2) => v === undefined ? undefined : `${v.toFixed(digits)}${unit}`;
	const parts = {
		floorplan: [f(num(m, 'die_width_um'), ''), f(num(m, 'die_height_um'), ' µm'), f(num(m, 'utilization_pct', 'utilization'), '% util', 1)],
		pdn: [num(m, 'power_grid_ok') === 1 ? 'grid connected' : num(m, 'power_grid_ok') === 0 ? 'grid check failed' : undefined, num(m, 'pdn_shapes') !== undefined ? `${num(m, 'pdn_shapes')} shapes` : undefined],
		place: [f(num(m, 'hpwl_um', 'wirelength_um'), ' µm HPWL', 0), f(num(m, 'setup_ws_ns', 'setup_wns_ns'), ' ns slack', 3)],
		cts: [f(num(m, 'clock_skew_setup_ns', 'clock_skew_ns'), ' ns skew', 3), f(num(m, 'setup_ws_ns', 'setup_wns_ns'), ' ns slack', 3)],
		route: [num(m, 'drc_violations') !== undefined ? `${num(m, 'drc_violations')} DRC` : undefined, f(num(m, 'wirelength_um', 'routed_wirelength_um'), ' µm', 0)],
		finish: [f(num(m, 'setup_ws_ns', 'setup_wns_ns'), ' ns slack', 3), f(num(m, 'total_power_mw', 'power_total_mw'), ' mW', 3)],
	}[stage];
	const fp = stage === 'floorplan' && parts[0] && parts[1] ? [`${parts[0]}×${parts[1]}`, parts[2]] : parts;
	return fp.filter(Boolean).join(', ');
}

const TOOL_FOR: Partial<Record<RunKind, ToolName[]>> = { sim: ['iverilog', 'vvp'], synth: ['yosys'], equiv: ['yosys'], pnr: ['openroad'] };

export class FlowProvider implements vscode.TreeDataProvider<FlowNode> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private staleness: Staleness | undefined;

	constructor(private readonly ws: Workspace) { }

	refresh(): void {
		const store = this.ws.store();
		this.staleness = store ? new Staleness(store) : undefined;
		this.changed.fire();
	}

	getChildren(node?: FlowNode): FlowNode[] {
		const store = this.ws.store();
		if (!store) {
			return [];
		}
		if (node) {
			return node.type === 'stage' ? node.children : [];
		}
		const synth = store.latest('synth');
		const synthLinks: FlowNode[] = synth?.status === 'passed' ? [
			{ type: 'link', label: 'Synthesis report', icon: 'graph', command: { title: 'Report', command: 'siliconStudio.showReport', arguments: [synth.id] } },
			{ type: 'link', label: 'Gate-level schematic', icon: 'type-hierarchy', command: { title: 'Schematic', command: 'siliconStudio.showSchematic', arguments: [synth.id, 'gate'] } },
			{ type: 'link', label: 'RTL schematic', icon: 'type-hierarchy-sub', command: { title: 'Schematic', command: 'siliconStudio.showSchematic', arguments: [synth.id, 'rtl'] } },
			{ type: 'link', label: 'netlist.v', description: 'gate-level Verilog', icon: 'file-code', command: { title: 'Netlist', command: 'siliconStudio.openNetlist', arguments: [synth.id] } },
		] : [];
		const physical = store.project.config.physical;
		const configure: FlowNode[] = [{ type: 'link', label: 'Set physical.platform in silicon.json', description: 'nangate45 or sky130hd', icon: 'settings-gear', command: { title: 'Configure', command: 'siliconStudio.openProjectConfig' } }];
		const pnrStage = (stage: PnrStage, extra: FlowNode[] = []): FlowNode[] => physical ? [{ type: 'pnr', stage }, ...extra] : stage === 'floorplan' ? configure : [];
		const final = latestPnr(store, r => !!(r.metrics?.stages as Record<string, unknown> | undefined)?.route);
		const route = (final?.metrics?.stages as Record<string, Metrics> | undefined)?.route;
		const finish = (final?.metrics?.stages as Record<string, Metrics> | undefined)?.finish;
		const drc = num(route, 'drc_violations');
		const antenna = num(route, 'antenna_violations') ?? num(finish, 'antenna_violations');
		const checks: FlowNode[] = physical ? [
			{ type: 'check', label: 'Routing DRC (TritonRoute)', value: drc === undefined ? 'not run' : `${drc} violation${drc === 1 ? '' : 's'}`, ok: drc === undefined ? undefined : drc === 0, tooltip: 'Design-rule violations reported by the detailed router against the tech LEF rules.' },
			{ type: 'check', label: 'Antenna check', value: antenna === undefined ? 'not run' : `${antenna} violation${antenna === 1 ? '' : 's'}`, ok: antenna === undefined ? undefined : antenna === 0, tooltip: 'OpenROAD check_antennas after routing.' },
			{ type: 'check', label: 'Foundry DRC / LVS decks', value: 'unavailable — needs the KLayout application', ok: undefined, tooltip: 'The platforms ship KLayout DRC/LVS decks, but running them needs the KLayout desktop app (not installed).' },
		] : [];
		const gds = final && fs.existsSync(path.join(store.runDir(final.id), 'outputs', 'pnr', '6_final.gds'));
		const stages: FlowNode[] = [
			{ type: 'stage', index: 1, title: 'RTL and verification', children: [
				{ type: 'step', kind: 'lint', label: 'Lint' },
				{ type: 'step', kind: 'sim', label: 'Simulation' },
				{ type: 'step', kind: 'equiv', label: 'Equivalence (RTL ↔ netlist)' },
			] },
			{ type: 'stage', index: 2, title: 'Synthesis (Yosys + ABC)', children: [{ type: 'step', kind: 'synth', label: 'Synthesize' }, ...synthLinks] },
			{ type: 'stage', index: 3, title: 'Floorplanning', children: pnrStage('floorplan', physical ? [
				{ type: 'link', label: 'Explore floorplan scenarios…', description: `${physical.scenarios?.length ?? 0} defined`, icon: 'layout', command: { title: 'Explore', command: 'siliconStudio.pnr.explore' } },
				{ type: 'link', label: `Scenario: ${physical.activeScenario ?? 'default'}`, icon: 'settings', command: { title: 'Select', command: 'siliconStudio.pnr.selectScenario' } },
			] : []) },
			{ type: 'stage', index: 4, title: 'Power planning', children: pnrStage('pdn') },
			{ type: 'stage', index: 5, title: 'Placement', children: pnrStage('place') },
			{ type: 'stage', index: 6, title: 'Clock-tree synthesis', children: pnrStage('cts') },
			{ type: 'stage', index: 7, title: 'Routing', children: pnrStage('route') },
			{ type: 'stage', index: 8, title: 'Extraction and timing', children: pnrStage('finish', final ? [
				{ type: 'link', label: 'Physical design report', icon: 'graph', command: { title: 'Report', command: 'siliconStudio.pnr.report', arguments: [final.id] } },
			] : []) },
			{ type: 'stage', index: 9, title: 'Physical verification', children: checks },
			{ type: 'stage', index: 10, title: 'Final export', children: [
				{ type: 'step', kind: 'export', label: 'Handoff bundle' },
				...(gds ? [{ type: 'link', label: '6_final.gds', description: 'GDSII', icon: 'file-binary', command: { title: 'Reveal', command: 'siliconStudio.pnr.revealGds', arguments: [final!.id] } } as FlowNode] : []),
			] },
		];
		return stages;
	}

	getTreeItem(node: FlowNode): vscode.TreeItem {
		if (node.type === 'stage') {
			const item = new vscode.TreeItem(`${node.index}. ${node.title}`, node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
			const icons = ['beaker', 'circuit-board', 'layout', 'zap', 'symbol-structure', 'watch', 'git-merge', 'pulse', 'shield', 'package'];
			item.iconPath = new vscode.ThemeIcon(icons[node.index - 1]);
			item.contextValue = 'stage';
			return item;
		}
		if (node.type === 'pnr') {
			return this.pnrItem(node.stage);
		}
		if (node.type === 'check') {
			const item = new vscode.TreeItem(node.label);
			item.description = node.value;
			item.tooltip = node.tooltip;
			item.iconPath = node.ok === undefined ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')) : statusIcon(node.ok ? 'passed' : 'failed');
			return item;
		}
		if (node.type === 'link') {
			const item = new vscode.TreeItem(node.label);
			item.iconPath = new vscode.ThemeIcon(node.icon);
			item.command = node.command;
			item.description = node.description;
			return item;
		}
		return this.stepItem(node.kind, node.label);
	}

	private pnrItem(stage: PnrStage): vscode.TreeItem {
		const store = this.ws.store()!;
		const item = new vscode.TreeItem(PNR_LABEL[stage]);
		const run = latestPnrWith(store, stage);
		const m = (run?.metrics?.stages as Record<string, Metrics & { status?: string }> | undefined)?.[stage];
		const openroad = this.ws.tools()?.openroad;
		item.contextValue = `pnrstage${run ? '.hasRun' : ''}`;
		if (this.ws.running() === 'pnr') {
			item.iconPath = statusIcon('running');
			item.description = 'running…';
		} else if (openroad?.mode === 'unavailable') {
			item.iconPath = new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('disabledForeground'));
			item.description = 'unavailable — openroad not installed';
			item.tooltip = openroad.detail;
		} else if (run && m) {
			const stale = this.staleness?.isStale(run) ?? false;
			const status = m.status === 'failed' ? 'failed' : 'passed';
			item.iconPath = statusIcon(status);
			const headline = stageHeadline(stage, m);
			const scenario = run.metrics?.scenario as string | undefined;
			item.description = `${m.status === 'reused' ? 'reused' : status}${headline ? ` · ${headline}` : ''}${scenario ? ` · ${scenario}` : ''}${stale ? ' · stale' : ''} · ${timeAgo(run.startedAt)}`;
			item.tooltip = runTooltip(run, stale);
			item.command = { title: 'Open layout', command: 'siliconStudio.pnr.layout', arguments: [run.id, stage] };
		} else {
			item.iconPath = statusIcon('none');
			item.description = 'not run';
		}
		return item;
	}

	private stepItem(kind: RunKind | 'export', label: string): vscode.TreeItem {
		const item = new vscode.TreeItem(label);
		const store = this.ws.store()!;
		if (kind === 'export') {
			item.iconPath = new vscode.ThemeIcon('package');
			item.description = 'RTL, netlist, reports, manifest';
			item.tooltip = 'Export a zip with sources, the synthesized netlist, reports, run manifests and SHA-256 checksums.';
			item.contextValue = 'step.export';
			item.command = { title: 'Export', command: 'siliconStudio.exportBundle' };
			return item;
		}
		const missing = (TOOL_FOR[kind] ?? []).map(n => this.ws.tools()?.[n]).find(t => t?.mode === 'unavailable');
		const run = store.latest(kind);
		item.contextValue = `step.${kind}${run ? '.hasRun' : ''}`;
		if (this.ws.running() === kind) {
			item.iconPath = statusIcon('running');
			item.description = 'running…';
		} else if (missing) {
			item.iconPath = new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('disabledForeground'));
			item.description = `unavailable — ${missing.name} not installed`;
			item.tooltip = missing.detail;
		} else if (run) {
			const stale = this.staleness?.isStale(run) ?? false;
			item.iconPath = statusIcon(run.status);
			item.description = `${run.status}${stale ? ' · stale' : ''} · ${timeAgo(run.startedAt)}`;
			item.tooltip = runTooltip(run, stale);
			item.command = { title: 'Open', command: kind === 'synth' ? 'siliconStudio.showReport' : kind === 'sim' && run.metrics?.waveform ? 'siliconStudio.showWaveform' : 'siliconStudio.openRunLog', arguments: [run.id] };
		} else {
			item.iconPath = statusIcon('none');
			item.description = 'not run';
		}
		return item;
	}
}

// ---------------------------------------------------------------------------------------------
// Run history

type RunNode =
	| { type: 'run'; run: RunRecord }
	| { type: 'group'; run: RunRecord; label: string; files: string[] }
	| { type: 'file'; run: RunRecord; rel: string }
	| { type: 'info'; text: string; icon: string };

export class RunsProvider implements vscode.TreeDataProvider<RunNode> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private staleness: Staleness | undefined;

	constructor(private readonly ws: Workspace) { }

	refresh(): void {
		const store = this.ws.store();
		this.staleness = store ? new Staleness(store) : undefined;
		this.changed.fire();
	}

	getChildren(node?: RunNode): RunNode[] {
		const store = this.ws.store();
		if (!store) {
			return [];
		}
		if (!node) {
			return store.list().map(run => ({ type: 'run', run }));
		}
		if (node.type === 'run') {
			const { run } = node;
			const outputs = run.outputs.map(o => o.path);
			const children: RunNode[] = [{ type: 'info', text: run.summary, icon: 'info' }];
			children.push(...run.notes.map((n): RunNode => ({ type: 'info', text: n, icon: 'note' })));
			children.push({ type: 'group', run, label: 'Outputs', files: outputs.filter(p => p.startsWith('outputs/')) });
			children.push({ type: 'group', run, label: 'Logs', files: outputs.filter(p => p.startsWith('logs/')) });
			children.push({ type: 'group', run, label: 'Input snapshot', files: run.inputs.map(i => `inputs/${i.path}`) });
			children.push({ type: 'file', run, rel: 'run.json' });
			return children;
		}
		if (node.type === 'group') {
			return node.files.map(rel => ({ type: 'file', run: node.run, rel }));
		}
		return [];
	}

	getTreeItem(node: RunNode): vscode.TreeItem {
		const store = this.ws.store()!;
		switch (node.type) {
			case 'run': {
				const { run } = node;
				const stale = this.staleness?.isStale(run) ?? false;
				const item = new vscode.TreeItem(`${KIND_LABEL[run.kind]} — ${run.status}`, vscode.TreeItemCollapsibleState.Collapsed);
				item.id = run.id;
				item.iconPath = statusIcon(run.status);
				item.description = `${timeAgo(run.startedAt)}${stale ? ' · stale' : ''}${run.reproducedFrom ? ' · reproduction' : ''}`;
				item.tooltip = runTooltip(run, stale);
				item.contextValue = `run.${run.kind}`;
				return item;
			}
			case 'group': {
				const item = new vscode.TreeItem(node.label, node.files.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon(node.label === 'Logs' ? 'output' : node.label === 'Outputs' ? 'files' : 'archive');
				item.description = `${node.files.length} file${node.files.length === 1 ? '' : 's'}`;
				return item;
			}
			case 'file': {
				const uri = vscode.Uri.file(path.join(store.runDir(node.run.id), node.rel));
				const item = new vscode.TreeItem(path.posix.basename(node.rel));
				item.resourceUri = uri;
				item.description = path.posix.dirname(node.rel).replace(/^(inputs|outputs|logs)\/?/, '');
				item.command = { title: 'Open', command: 'vscode.open', arguments: [uri] };
				return item;
			}
			case 'info': {
				const item = new vscode.TreeItem(node.text);
				item.iconPath = new vscode.ThemeIcon(node.icon);
				item.tooltip = node.text;
				return item;
			}
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Design hierarchy

interface HierNode {
	root?: boolean;
	name: string;
	module: string;
	src?: string;
	modules: Record<string, any>;
}

/** "$paramod\counter\WIDTH=s32'00000000000000000000000000001000" → "counter #(WIDTH=8)". */
export function prettyModule(name: string): string {
	const m = /^\$paramod(?:\$[0-9a-f]+)?\\([^\\]+)(.*)$/.exec(name);
	if (!m) {
		return name.replace(/^\\/, '');
	}
	const params = m[2].split('\\').filter(Boolean).map(p => {
		const [k, v = ''] = p.split('=');
		const c = /^s?\d+'([01]+)$/.exec(v);
		return `${k}=${c ? parseInt(c[1], 2) : v}`;
	});
	return params.length ? `${m[1]} #(${params.join(', ')})` : m[1];
}

function isTop(module: any): boolean {
	const top = module?.attributes?.top;
	return typeof top === 'string' ? /1/.test(top) : !!top;
}

export class HierarchyProvider implements vscode.TreeDataProvider<HierNode> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private source: string | undefined;

	constructor(private readonly ws: Workspace) { }

	refresh(): void {
		this.changed.fire();
	}

	/** Newest elaborated netlist: on-save lint, latest lint run, or the RTL view of the latest synthesis. */
	private latestJson(store: RunStore): string | undefined {
		const lint = store.latest('lint');
		const synth = store.latest('synth');
		const candidates = [
			path.join(store.project.stateDir, 'scratch', 'lint', 'outputs', 'elab.json'),
			lint && path.join(store.runDir(lint.id), 'outputs', 'elab.json'),
			synth && path.join(store.runDir(synth.id), 'outputs', 'rtl.json'),
		].filter((f): f is string => !!f && fs.existsSync(f));
		return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
	}

	getChildren(node?: HierNode): HierNode[] {
		const store = this.ws.store();
		if (!store) {
			return [];
		}
		if (!node) {
			this.source = this.latestJson(store);
			if (!this.source) {
				return [];
			}
			let netlist: any;
			try {
				netlist = JSON.parse(fs.readFileSync(this.source, 'utf8'));
			} catch {
				return [];
			}
			const modules: Record<string, any> = netlist.modules ?? {};
			const top = Object.keys(modules).find(m => isTop(modules[m]));
			return top ? [{ root: true, name: prettyModule(top), module: top, src: modules[top].attributes?.src, modules }] : [];
		}
		const cells: Record<string, any> = node.modules[node.module]?.cells ?? {};
		return Object.entries(cells)
			.filter(([, cell]) => node.modules[cell.type])
			.map(([name, cell]) => ({ name, module: cell.type, src: cell.attributes?.src, modules: node.modules }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	getTreeItem(node: HierNode): vscode.TreeItem {
		const sub = Object.values(node.modules[node.module]?.cells ?? {}).some((c: any) => node.modules[c.type]);
		const item = new vscode.TreeItem(node.name, sub ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		const store = this.ws.store();
		const isRoot = !!node.root;
		item.description = isRoot ? 'top' : prettyModule(node.module);
		item.iconPath = new vscode.ThemeIcon(isRoot ? 'symbol-class' : 'symbol-module');
		const loc = node.src ? parseYosysSrc(node.src) : undefined;
		if (loc && store) {
			const uri = vscode.Uri.file(path.join(store.project.root, loc.file.replace(/^(\.\/)?inputs\//, '')));
			const line = Math.max(0, loc.line - 1);
			item.command = { title: 'Go to source', command: 'vscode.open', arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }] };
			item.tooltip = `${prettyModule(node.module)} — ${loc.file.replace(/^(\.\/)?inputs\//, '')}:${loc.line}`;
		}
		return item;
	}
}
