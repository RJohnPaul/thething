/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — extension entry point: project discovery, job queue, commands, diagnostics.
 *--------------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { exportBundle } from './bundle';
import { ToolMessage } from './diagnostics';
import { RunContext, RunRecord, RunStore, ToolInfo, ToolName, Tools, USER_TOOLS } from './engine';
import { Flows, NETLIST_INPUT, physicalDigest, PNR_CHECKPOINT, PNR_DIR, PNR_STAGES, PnrOptions, PnrStage, UserError } from './flows';
import { loadPlatform } from './physicalSynth';
import { Panels } from './panels';
import { CONFIG_FILE, declaredModules, loadProject, Project, RunKind, scaffoldProject, validateProject } from './project';
import { FlowProvider, HierarchyProvider, KIND_LABEL, latestPnr, PNR_LABEL, RunsProvider, timeAgo, Workspace } from './views';

const ACTIVE_LABEL: Record<RunKind, string> = { lint: 'Linting', sim: 'Simulating', synth: 'Synthesizing', equiv: 'Checking equivalence', pnr: 'Placing and routing' };
type JobOptions = { scratch?: boolean; basedOn?: RunRecord; reproduce?: RunRecord; pnr?: PnrOptions };
type ShellKind = 'dc' | 'icc2' | 'pt';
const SHELLS: Record<ShellKind, { name: string; script: string }> = {
	dc: { name: 'DC Shell', script: 'dc_shell.tcl' },
	icc2: { name: 'ICC2 Shell', script: 'icc2_shell.tcl' },
	pt: { name: 'PrimeTime Shell', script: 'pt_shell.tcl' },
};

export function activate(context: vscode.ExtensionContext): void {
	const version: string = context.extension.packageJSON.version;
	const output = vscode.window.createOutputChannel('Silicon Studio', 'log');
	const tools = new Tools(context.extensionPath);
	const panels = new Panels(context.extensionUri);
	const problems = new Map<string, vscode.DiagnosticCollection>();
	const statusItem = vscode.window.createStatusBarItem('siliconStudio.status', vscode.StatusBarAlignment.Left, 50);
	statusItem.name = 'Silicon Studio';
	context.subscriptions.push(output, statusItem);

	let store: RunStore | undefined;
	let toolInfo: Record<ToolName, ToolInfo> | undefined;
	let current: { kind: RunKind; cts: vscode.CancellationTokenSource } | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	let scratchLintQueued = false;

	const ws: Workspace = { store: () => store, tools: () => toolInfo, running: () => current?.kind };
	const flowView = new FlowProvider(ws);
	const runsView = new RunsProvider(ws);
	const hierarchyView = new HierarchyProvider(ws);
	context.subscriptions.push(
		vscode.window.createTreeView('siliconStudio.flow', { treeDataProvider: flowView }),
		vscode.window.createTreeView('siliconStudio.runs', { treeDataProvider: runsView }),
		vscode.window.createTreeView('siliconStudio.hierarchy', { treeDataProvider: hierarchyView }),
	);

	let refreshTimer: NodeJS.Timeout | undefined;
	const refresh = () => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			flowView.refresh();
			runsView.refresh();
			hierarchyView.refresh();
			updateStatus();
		}, 100);
	};

	function updateStatus(): void {
		if (current) {
			statusItem.text = `$(sync~spin) ${ACTIVE_LABEL[current.kind]}…`;
			statusItem.tooltip = 'Silicon Studio job running — click to cancel';
			statusItem.command = 'siliconStudio.cancelJob';
		} else if (store) {
			const yosys = toolInfo?.yosys;
			statusItem.text = `$(circuit-board) ${store.project.config.name} · top ${store.project.config.top || '?'}`;
			statusItem.tooltip = new vscode.MarkdownString(`**Silicon Studio** — ${store.project.root}\n\nYosys: ${yosys ? `${yosys.version || 'unavailable'} (${yosys.mode})` : 'detecting…'}\n\nClick for engine status`);
			statusItem.command = 'siliconStudio.toolStatus';
		}
		statusItem[store || current ? 'show' : 'hide']();
	}

	async function detectTools(): Promise<void> {
		toolInfo = await tools.resolve();
		for (const t of Object.values(toolInfo)) {
			output.appendLine(`[engine] ${t.name}: ${t.mode}${t.version ? ` — ${t.version}` : ''} (${t.detail})`);
		}
		refresh();
	}

	async function findProjectRoot(): Promise<string | undefined> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (fs.existsSync(path.join(folder.uri.fsPath, CONFIG_FILE))) {
				return folder.uri.fsPath;
			}
		}
		const found = await vscode.workspace.findFiles(`**/${CONFIG_FILE}`, '**/{node_modules,.silicon,exports}/**', 10);
		const active = vscode.window.activeTextEditor?.document.uri.fsPath;
		const roots = found.map(u => path.dirname(u.fsPath)).sort((a, b) => a.length - b.length);
		return roots.find(r => active?.startsWith(r + path.sep)) ?? roots[0];
	}

	async function loadStore(root?: string): Promise<void> {
		root ??= await findProjectRoot();
		let project: Project | undefined;
		if (root) {
			try {
				project = loadProject(root);
			} catch (e) {
				vscode.window.showErrorMessage(`Silicon Studio: ${e.message}`, 'Open silicon.json').then(a => a && vscode.window.showTextDocument(vscode.Uri.file(path.join(root!, CONFIG_FILE))));
			}
		}
		if (store && (!project || project.root !== store.project.root)) {
			store.dispose();
			store = undefined;
		}
		if (project) {
			const previous = store;
			store = new RunStore(project, version);
			if (!current) {
				store.markInterrupted();
			}
			previous?.dispose();
			store.onDidChange(refresh);
		}
		vscode.commands.executeCommand('setContext', 'siliconStudio.hasProject', !!store);
		refresh();
	}

	function requireStore(): RunStore {
		if (!store) {
			throw new UserError('No Silicon Studio project is open. Run "Silicon Studio: New Project…" or open a folder containing silicon.json.');
		}
		return store;
	}

	// ---- diagnostics (Problems panel) -------------------------------------------------------

	/**
	 * Maps a tool-reported path to a file. Paths are relative to where the tool ran (yosys: the run directory,
	 * the others: its inputs/ snapshot). Snapshot files of the live project map back to the project; anything
	 * else (generated files, reproductions and equivalence checks of older snapshots) stays in the run.
	 */
	function toUri(project: Project, ctx: RunContext, m: ToolMessage): vscode.Uri {
		if (!m.file) {
			return vscode.Uri.file(project.configPath);
		}
		const abs = path.resolve(m.tool === 'yosys' ? ctx.dir : ctx.inputsDir, m.file);
		const rel = path.relative(ctx.inputsDir, abs);
		if (rel.startsWith('..') || path.isAbsolute(rel) || rel === NETLIST_INPUT || ctx.source.root !== project.root) {
			return vscode.Uri.file(abs);
		}
		return vscode.Uri.file(path.join(project.root, rel));
	}

	function publish(project: Project, ctx: RunContext, messages: ToolMessage[]): void {
		const key = ctx.run.kind;
		let collection = problems.get(key);
		if (!collection) {
			collection = vscode.languages.createDiagnosticCollection(`silicon-studio-${key}`);
			problems.set(key, collection);
			context.subscriptions.push(collection);
		}
		collection.clear();
		const byFile = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
		for (const m of messages) {
			const uri = toUri(project, ctx, m);
			const line = Math.max(0, (m.line ?? 1) - 1);
			const col = Math.max(0, (m.column ?? 1) - 1);
			const range = new vscode.Range(line, m.column ? col : 0, m.endLine ? m.endLine - 1 : line, m.endColumn ?? (m.column ? col + 1 : 1000));
			const severity = m.severity === 'error' ? vscode.DiagnosticSeverity.Error : m.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
			const diagnostic = new vscode.Diagnostic(range, m.message, severity);
			diagnostic.source = m.tool;
			if (m.code) {
				diagnostic.code = m.code;
			}
			const entry = byFile.get(uri.toString()) ?? { uri, list: [] };
			entry.list.push(diagnostic);
			byFile.set(uri.toString(), entry);
		}
		for (const { uri, list } of byFile.values()) {
			collection.set(uri, list);
		}
	}

	const flows = new Flows({ extensionPath: context.extensionPath, tools, output, publish });

	// ---- job queue ----------------------------------------------------------------------------

	/** Queues a run; jobs execute one at a time and never block the UI (PRD 11, 13). */
	function runJob(kind: RunKind, opts: JobOptions = {}): Promise<RunRecord | undefined> {
		const job = queue.then(() => {
			// A save after this point needs a new snapshot, so allow the next on-save lint to queue.
			if (opts.scratch) {
				scratchLintQueued = false;
			}
			return execute(kind, opts);
		});
		queue = job.catch(() => undefined);
		return job;
	}

	async function execute(kind: RunKind, opts: JobOptions): Promise<RunRecord | undefined> {
		const cts = new vscode.CancellationTokenSource();
		try {
			const s = requireStore();
			current = { kind, cts };
			vscode.commands.executeCommand('setContext', 'siliconStudio.jobRunning', true);
			refresh();
			const pnr = opts.pnr && [opts.pnr.scenario && `scenario ${opts.pnr.scenario}`, opts.pnr.fromStage && `from ${opts.pnr.fromStage}`, opts.pnr.stopAfter && `through ${opts.pnr.stopAfter}`].filter(Boolean).join(', ');
			const title = `${ACTIVE_LABEL[kind]}${pnr ? ` (${pnr})` : ''}${opts.reproduce ? ` (reproducing ${opts.reproduce.id})` : ''}…`;
			return await vscode.window.withProgress({ location: opts.scratch ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title, cancellable: !opts.scratch }, (_progress, token) => {
				token.onCancellationRequested(() => cts.cancel());
				return flows.run(s, kind, cts.token, opts);
			});
		} catch (e) {
			if (!opts.scratch) {
				const actions = e instanceof UserError && store ? ['Open silicon.json'] : [];
				vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Silicon Studio: ${kind} failed unexpectedly: ${e.message}`, ...actions).then(a => {
					if (a && store) {
						vscode.window.showTextDocument(vscode.Uri.file(store.project.configPath));
					}
				});
			}
			output.appendLine(`[error] ${e.stack ?? e.message}`);
			return undefined;
		} finally {
			current = undefined;
			cts.dispose();
			vscode.commands.executeCommand('setContext', 'siliconStudio.jobRunning', false);
			refresh();
		}
	}

	function notify(run: RunRecord, actions: string[] = []): Thenable<string | undefined> {
		const text = `${KIND_LABEL[run.kind]} ${run.status}: ${run.summary}`;
		const all = [...actions, 'Show Log'];
		const shown = run.status === 'passed'
			? vscode.window.showInformationMessage(text, ...all)
			: run.status === 'inconclusive' || run.status === 'cancelled'
				? vscode.window.showWarningMessage(text, ...all)
				: vscode.window.showErrorMessage(text, ...all);
		return shown.then(a => {
			if (a === 'Show Log') {
				openLog(run);
			}
			return a;
		});
	}

	function openLog(run: RunRecord): void {
		const s = requireStore();
		const log = run.steps.at(-1)?.log ?? 'run.json';
		vscode.window.showTextDocument(vscode.Uri.file(path.join(s.runDir(run.id), log)), { preview: true });
	}

	/** Commands receive a run id, a tree node from the Runs/Flow views, or nothing (→ latest of kind). */
	function resolveRun(arg: unknown, kind?: RunKind, predicate?: (r: RunRecord) => boolean): RunRecord | undefined {
		const s = requireStore();
		const node = arg as { run?: RunRecord; kind?: RunKind } | undefined;
		const id = typeof arg === 'string' ? arg : node?.run?.id;
		if (id) {
			return s.get(id);
		}
		const k = node?.kind && node.kind in KIND_LABEL ? node.kind : kind;
		return k ? s.latest(k, predicate) : s.list()[0];
	}

	/** True for a run id or a Run History run node (title-bar actions receive whatever row has focus). */
	function isRunArg(arg: unknown): boolean {
		return typeof arg === 'string' || !!(arg as { run?: RunRecord } | undefined)?.run;
	}

	async function pickRun(placeHolder: string, filter: (r: RunRecord) => boolean = () => true): Promise<RunRecord | undefined> {
		const runs = requireStore().list().filter(r => r.status !== 'running' && filter(r));
		if (!runs.length) {
			vscode.window.showInformationMessage('No matching runs yet.');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(runs.map(r => ({
			label: `${KIND_LABEL[r.kind]} — ${r.status}`,
			description: `${timeAgo(r.startedAt)} · ${r.id}`,
			detail: r.summary,
			run: r,
		})), { placeHolder, matchOnDescription: true, matchOnDetail: true });
		return picked?.run;
	}

	async function synthesizeAndReport(): Promise<RunRecord | undefined> {
		const run = await runJob('synth');
		if (run) {
			if (run.status === 'passed') {
				panels.showSynthesisReport(requireStore(), run);
			}
			notify(run, run.status === 'passed' ? ['Open Schematic', 'Open Netlist'] : []).then(a => {
				if (a === 'Open Schematic') {
					panels.showSchematic(requireStore(), run, 'gate');
				} else if (a === 'Open Netlist') {
					openNetlist(run);
				}
			});
		}
		return run;
	}

	function openNetlist(run: RunRecord): void {
		const file = path.join(requireStore().runDir(run.id), 'outputs', 'netlist.v');
		if (fs.existsSync(file)) {
			vscode.window.showTextDocument(vscode.Uri.file(file));
		} else {
			vscode.window.showWarningMessage(`Run ${run.id} has no netlist.`);
		}
	}

	async function simulateAndShow(silent = false): Promise<RunRecord | undefined> {
		const run = await runJob('sim');
		if (run) {
			const open = vscode.workspace.getConfiguration('siliconStudio').get<boolean>('openWaveformAfterSimulation', true);
			if (run.metrics?.waveform && open && run.status !== 'error' && run.status !== 'cancelled') {
				panels.showWaveform(requireStore(), run);
			}
			if (!silent) {
				notify(run, run.metrics?.waveform ? ['Open Waveform'] : []).then(a => a === 'Open Waveform' && panels.showWaveform(requireStore(), run));
			}
		}
		return run;
	}

	async function equivalence(): Promise<RunRecord | undefined> {
		const s = requireStore();
		const synth = s.latest('synth', r => r.status === 'passed');
		if (!synth) {
			const a = await vscode.window.showWarningMessage('Equivalence checking needs a synthesized netlist.', 'Synthesize Now');
			if (a) {
				const run = await synthesizeAndReport();
				return run?.status === 'passed' ? equivalence() : undefined;
			}
			return undefined;
		}
		return runJob('equiv', { basedOn: synth });
	}

	// ---- commands -----------------------------------------------------------------------------

	const command = (id: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
		try {
			await handler(...args);
		} catch (e) {
			vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Silicon Studio: ${e.message}`);
		}
	}));

	command('siliconStudio.newProject', async () => {
		const name = await vscode.window.showInputBox({
			title: 'New Silicon Studio Project',
			prompt: 'Project name (a PWM generator template with RTL, testbench, constraints and a demo cell library is created)',
			value: 'pwm',
			validateInput: v => /^[A-Za-z_][\w-]*$/.test(v) ? undefined : 'Use letters, digits, "_" or "-"',
		});
		if (!name) {
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		let dir: string | undefined;
		if (folder && !fs.existsSync(path.join(folder.uri.fsPath, CONFIG_FILE))) {
			const where = await vscode.window.showQuickPick([
				{ label: `$(folder) Current folder`, description: folder.uri.fsPath, dir: folder.uri.fsPath },
				{ label: `$(new-folder) New subfolder "${name}"`, description: path.join(folder.uri.fsPath, name), dir: path.join(folder.uri.fsPath, name) },
				{ label: '$(folder-opened) Choose another location…', dir: '' },
			], { placeHolder: 'Where should the project be created?' });
			if (!where) {
				return;
			}
			dir = where.dir || undefined;
		}
		if (!dir) {
			const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create Project Here', title: 'Select Parent Folder' });
			if (!parent?.[0]) {
				return;
			}
			dir = path.join(parent[0].fsPath, name);
		}
		if (fs.existsSync(path.join(dir, CONFIG_FILE))) {
			throw new UserError(`${dir} already contains a ${CONFIG_FILE}.`);
		}
		scaffoldProject(path.join(context.extensionPath, 'templates', 'pwm'), dir, name);
		const inWorkspace = vscode.workspace.workspaceFolders?.some(f => dir === f.uri.fsPath || dir!.startsWith(f.uri.fsPath + path.sep));
		if (inWorkspace) {
			await loadStore(dir);
			await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'rtl', 'pwm.v')));
			vscode.commands.executeCommand('workbench.view.extension.siliconStudio');
		} else {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir));
		}
	});

	command('siliconStudio.lint', async () => {
		const run = await runJob('lint');
		if (run) {
			notify(run, run.diagnostics.errors + run.diagnostics.warnings ? ['Show Problems'] : []).then(a => a === 'Show Problems' && vscode.commands.executeCommand('workbench.actions.view.problems'));
		}
	});
	command('siliconStudio.simulate', () => simulateAndShow());
	command('siliconStudio.synthesize', () => synthesizeAndReport());
	command('siliconStudio.equivalence', async () => {
		const run = await equivalence();
		if (run) {
			notify(run);
		}
	});

	command('siliconStudio.runFlow', async () => {
		const s = requireStore();
		const steps: string[] = [];
		const lint = await runJob('lint');
		steps.push(`lint ${lint?.status ?? 'not run'}`);
		if (lint?.status === 'passed') {
			let simOk = true;
			if (s.project.config.testbench) {
				const sim = await simulateAndShow(true);
				steps.push(`simulation ${sim?.status ?? 'not run'}`);
				simOk = sim?.status === 'passed' || sim?.status === 'inconclusive';
			}
			if (simOk) {
				const synth = await runJob('synth');
				steps.push(`synthesis ${synth?.status ?? 'not run'}`);
				if (synth?.status === 'passed') {
					const eq = await runJob('equiv', { basedOn: synth });
					steps.push(`equivalence ${eq?.status ?? 'not run'}`);
					if (s.project.config.physical && eq?.status !== 'failed') {
						const pnr = await runJob('pnr', { basedOn: synth, pnr: {} });
						steps.push(`place & route ${pnr?.status ?? 'not run'}`);
						if (pnr) {
							panels.showPhysicalReport(s, pnr);
						}
					} else {
						panels.showSynthesisReport(s, synth);
					}
				}
			}
		}
		const ok = steps.every(x => /passed$/.test(x));
		const text = `Flow ${ok ? 'complete' : 'stopped'}: ${steps.join(' → ')}`;
		(ok ? vscode.window.showInformationMessage(text, 'Export Bundle') : vscode.window.showWarningMessage(text, 'Show Runs')).then(a => {
			if (a === 'Export Bundle') {
				vscode.commands.executeCommand('siliconStudio.exportBundle');
			} else if (a) {
				vscode.commands.executeCommand('siliconStudio.runs.focus');
			}
		});
	});

	command('siliconStudio.showWaveform', async (arg?: unknown) => {
		const run = resolveRun(arg, 'sim', r => !!r.metrics?.waveform) ?? await pickRun('Select a simulation run', r => r.kind === 'sim' && !!r.metrics?.waveform);
		if (run) {
			panels.showWaveform(requireStore(), run);
		}
	});
	command('siliconStudio.showSchematic', async (arg?: unknown, view?: 'gate' | 'rtl') => {
		const run = resolveRun(arg, 'synth', r => r.status === 'passed');
		if (!run || run.kind !== 'synth') {
			throw new UserError('No synthesis run with a netlist yet — run "Silicon Studio: Synthesize" first.');
		}
		if (!view) {
			const pick = await vscode.window.showQuickPick([
				{ label: 'Gate-level netlist', description: 'after technology mapping', view: 'gate' as const },
				{ label: 'RTL', description: 'elaborated design before synthesis', view: 'rtl' as const },
			], { placeHolder: 'Which schematic?' });
			view = pick?.view;
		}
		if (view) {
			await panels.showSchematic(requireStore(), run, view);
		}
	});
	command('siliconStudio.showReport', async (arg?: unknown) => {
		const run = resolveRun(arg, 'synth') ?? await pickRun('Select a synthesis run', r => r.kind === 'synth');
		if (run?.kind === 'synth') {
			panels.showSynthesisReport(requireStore(), run);
		} else if (run) {
			openLog(run);
		}
	});
	command('siliconStudio.openNetlist', (arg?: unknown) => {
		const run = resolveRun(arg, 'synth', r => r.status === 'passed');
		if (!run) {
			throw new UserError('No synthesized netlist yet — run "Silicon Studio: Synthesize" first.');
		}
		openNetlist(run);
	});
	command('siliconStudio.openRunLog', async (arg?: unknown) => {
		const run = (isRunArg(arg) ? resolveRun(arg) : undefined) ?? await pickRun('Select a run');
		if (run) {
			openLog(run);
		}
	});
	command('siliconStudio.revealRun', (arg?: unknown) => {
		const run = resolveRun(arg);
		if (run) {
			vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(requireStore().runDir(run.id), 'run.json')));
		}
	});
	command('siliconStudio.compareRuns', async (arg?: unknown) => {
		const first = (isRunArg(arg) ? resolveRun(arg) : undefined) ?? await pickRun('Select the first run (A)');
		if (!first) {
			return;
		}
		const second = await pickRun(`Compare ${first.id} with…`, r => r.id !== first.id && r.kind === first.kind);
		if (second) {
			const [a, b] = first.startedAt <= second.startedAt ? [first, second] : [second, first];
			panels.showComparison(a, b);
		}
	});
	command('siliconStudio.reproduceRun', async (arg?: unknown) => {
		const original = (isRunArg(arg) ? resolveRun(arg) : undefined) ?? await pickRun('Select a run to reproduce from its recorded inputs');
		if (!original) {
			return;
		}
		const run = await runJob(original.kind, { reproduce: original, basedOn: original.basedOn ? requireStore().get(original.basedOn) : undefined });
		if (run?.reproduction) {
			const msg = run.reproduction.identical
				? `Reproduced ${original.id}: same status (${run.status}) and all ${run.reproduction.compared} outputs identical.`
				: `Reproduction of ${original.id} differs: ${run.reproduction.differences.join('; ')}`;
			(run.reproduction.identical ? vscode.window.showInformationMessage(msg, 'Compare') : vscode.window.showWarningMessage(msg, 'Compare')).then(a => a && panels.showComparison(original, run));
		}
	});
	command('siliconStudio.exportBundle', async () => {
		const s = requireStore();
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting handoff bundle…' }, () => exportBundle(s, version));
		const rel = path.relative(s.project.root, result.file);
		const msg = `Exported ${result.files} files to ${rel}${result.warnings.length ? ` — ${result.warnings.length} warning(s): ${result.warnings.join(' ')}` : ''}`;
		const show = result.warnings.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
		show(msg, 'Reveal').then(a => a && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.file)));
	});
	command('siliconStudio.selectTop', async () => {
		const s = requireStore();
		const modules = declaredModules(s.project);
		const picked = await vscode.window.showQuickPick(modules.map(m => ({ label: m, description: m === s.project.config.top ? 'current top' : undefined })), { placeHolder: 'Select the top-level module' });
		if (picked && picked.label !== s.project.config.top) {
			const config = JSON.parse(fs.readFileSync(s.project.configPath, 'utf8'));
			config.top = picked.label;
			fs.writeFileSync(s.project.configPath, JSON.stringify(config, undefined, '\t') + '\n');
			await loadStore(s.project.root);
		}
	});
	command('siliconStudio.validateConfig', () => {
		const s = requireStore();
		const kinds: RunKind[] = ['lint', 'sim', 'synth'];
		const issues = [...new Map(kinds.flatMap(k => validateProject(s.project, k)).map(i => [i.message, i])).values()];
		if (!issues.length) {
			vscode.window.showInformationMessage(`${CONFIG_FILE} is valid: lint, simulation and synthesis can run.`);
			return;
		}
		output.appendLine(`\n[config] ${issues.length} issue(s) in ${s.project.configPath}:`);
		issues.forEach(i => output.appendLine(`  ${i.severity}: ${i.message}`));
		output.show(true);
		const errors = issues.filter(i => i.severity === 'error').length;
		vscode.window[errors ? 'showErrorMessage' : 'showWarningMessage'](`${CONFIG_FILE}: ${errors} error(s), ${issues.length - errors} warning(s) — see the Silicon Studio output.`);
	});
	command('siliconStudio.toolStatus', async () => {
		tools.invalidate();
		await detectTools();
		const items = Object.values(toolInfo!).map(t => ({
			label: `${t.mode === 'unavailable' ? '$(error)' : t.mode === 'wasm' ? '$(globe)' : '$(check)'} ${t.name}`,
			description: t.mode === 'unavailable' ? 'unavailable' : `${t.mode === 'wasm' ? 'WebAssembly (local, no install)' : 'native'} · ${t.version}`,
			detail: t.detail,
		}));
		vscode.window.showQuickPick(items, { title: 'Silicon Studio Engines', placeHolder: 'Execution environment used for jobs (configure under Settings › Silicon Studio)' });
	});
	command('siliconStudio.cancelJob', () => current?.cts.cancel());
	command('siliconStudio.refresh', async () => {
		tools.invalidate();
		await Promise.all([detectTools(), loadStore()]);
	});
	command('siliconStudio.openProjectConfig', () => vscode.window.showTextDocument(vscode.Uri.file(requireStore().project.configPath)));

	// ---- physical implementation (OpenROAD) ---------------------------------------------------

	/** The synthesis run place and route starts from; offers to synthesize when it is missing or for another platform. */
	async function synthForPnr(): Promise<RunRecord | undefined> {
		const s = requireStore();
		const platform = s.project.config.physical?.platform;
		if (!platform) {
			const a = await vscode.window.showWarningMessage('Place and route needs a platform: add "physical": { "platform": "nangate45" } (or "sky130hd") to silicon.json.', 'Open silicon.json');
			if (a) {
				vscode.window.showTextDocument(vscode.Uri.file(s.project.configPath));
			}
			return undefined;
		}
		const synth = s.latest('synth', r => r.status === 'passed');
		if (synth && synth.metrics?.platform === platform) {
			return synth;
		}
		const a = await vscode.window.showWarningMessage(`Place and route needs a netlist synthesized for ${platform}.`, 'Synthesize Now');
		if (!a) {
			return undefined;
		}
		const run = await runJob('synth');
		return run?.status === 'passed' ? run : undefined;
	}

	async function runPnr(o: PnrOptions): Promise<RunRecord | undefined> {
		const synth = await synthForPnr();
		if (!synth) {
			return undefined;
		}
		const run = await runJob('pnr', { basedOn: synth, pnr: o });
		if (run) {
			const done = PNR_STAGES.filter(st => (run.metrics?.stages as Record<string, unknown> | undefined)?.[st]);
			const last = done[done.length - 1] as PnrStage | undefined;
			notify(run, ['Open Report', ...(last ? ['Open Layout'] : [])]).then(a => {
				if (a === 'Open Report') {
					panels.showPhysicalReport(requireStore(), run);
				} else if (a === 'Open Layout' && last) {
					showLayout(run, last);
				}
			});
		}
		return run;
	}

	function stageArg(arg: unknown): PnrStage | undefined {
		const stage = typeof arg === 'string' ? arg : (arg as { stage?: string } | undefined)?.stage;
		return PNR_STAGES.includes(stage as PnrStage) ? stage as PnrStage : undefined;
	}

	async function pickStage(placeHolder: string, stages: readonly PnrStage[] = PNR_STAGES): Promise<PnrStage | undefined> {
		const pick = await vscode.window.showQuickPick(stages.map(st => ({ label: PNR_LABEL[st], stage: st })), { placeHolder });
		return pick?.stage;
	}

	function checkpointStages(run: RunRecord): PnrStage[] {
		const dir = path.join(requireStore().runDir(run.id), PNR_DIR);
		return PNR_STAGES.filter(st => fs.existsSync(path.join(dir, PNR_CHECKPOINT[st])));
	}

	async function showLayout(run: RunRecord, stage: PnrStage): Promise<void> {
		const s = requireStore();
		const json = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading ${PNR_LABEL[stage].toLowerCase()} layout…`, cancellable: true },
			(_p, token) => flows.exportLayout(s, run, stage, token));
		panels.showLayout(s, run, stage, json);
	}

	async function pnrRunArg(arg: unknown): Promise<RunRecord | undefined> {
		const run = (isRunArg(arg) ? resolveRun(arg) : undefined) ?? latestPnr(requireStore());
		if (!run || run.kind !== 'pnr') {
			throw new UserError('No place-and-route run yet — run "Silicon Studio: Run Place & Route" first.');
		}
		return run;
	}

	command('siliconStudio.pnr.run', () => runPnr({}));
	command('siliconStudio.pnr.runTo', async (arg?: unknown) => {
		const stage = stageArg(arg) ?? await pickStage('Run place and route through which stage?');
		if (stage) {
			await runPnr({ stopAfter: stage });
		}
	});
	command('siliconStudio.pnr.resume', async (arg?: unknown) => {
		const s = requireStore();
		const stage = stageArg(arg) ?? await pickStage('Re-run place and route starting at which stage?', PNR_STAGES.slice(1));
		if (!stage) {
			return;
		}
		const previous = PNR_STAGES[PNR_STAGES.indexOf(stage) - 1];
		const synth = await synthForPnr();
		if (!synth) {
			return;
		}
		// Only a checkpoint of the current netlist with unchanged physical settings may be reused.
		const config = s.project.config;
		const current = (r: RunRecord) => {
			try {
				return r.metrics?.physicalDigest === physicalDigest(config, (r.metrics?.scenario as string | undefined) ?? '');
			} catch {
				return false;
			}
		};
		const fromRun = latestPnr(s, r => r.basedOn === synth.id && current(r) && checkpointStages(r).includes(previous));
		if (!fromRun) {
			throw new UserError(`No run of the current netlist and floorplan has a ${PNR_LABEL[previous].toLowerCase()} checkpoint; run place and route from the floorplan.`);
		}
		await runPnr({ fromStage: stage, fromRun, scenario: (fromRun.metrics?.scenario as string | undefined) ?? '' });
	});
	command('siliconStudio.pnr.explore', async () => {
		const s = requireStore();
		let scenarios = s.project.config.physical?.scenarios ?? [];
		if (!s.project.config.physical) {
			await synthForPnr();
			return;
		}
		if (!scenarios.length) {
			const a = await vscode.window.showInformationMessage('No floorplan scenarios are defined. Add three example scenarios (low/high utilization, wide aspect ratio) to silicon.json?', 'Add Examples');
			if (!a) {
				return;
			}
			const config = JSON.parse(fs.readFileSync(s.project.configPath, 'utf8'));
			config.physical.scenarios = [
				{ name: 'util30-square', utilization: 30, aspectRatio: 1 },
				{ name: 'util55-square', utilization: 55, aspectRatio: 1 },
				{ name: 'util40-wide', utilization: 40, aspectRatio: 0.5 },
			];
			fs.writeFileSync(s.project.configPath, JSON.stringify(config, undefined, '\t') + '\n');
			await loadStore(s.project.root);
			scenarios = config.physical.scenarios;
		}
		const picked = await vscode.window.showQuickPick(scenarios.map(sc => ({
			label: sc.name,
			description: [sc.utilization !== undefined && `${sc.utilization}% util`, sc.aspectRatio !== undefined && `aspect ${sc.aspectRatio}`, sc.dieArea && `die ${sc.dieArea.join(' ')}`].filter(Boolean).join(' · '),
			picked: true,
		})), { canPickMany: true, placeHolder: 'Scenarios to compare' });
		if (!picked?.length) {
			return;
		}
		const depth = await vscode.window.showQuickPick([
			{ label: 'Through placement', description: 'fast: floorplan, power grid, placement', stage: 'place' as PnrStage },
			{ label: 'Through routing', description: 'adds clock tree and routing (DRC, wirelength)', stage: 'route' as PnrStage },
			{ label: 'Full flow', description: 'adds parasitic extraction, signoff timing, power and GDSII', stage: 'finish' as PnrStage },
		], { placeHolder: 'How far should each scenario run?' });
		if (!depth) {
			return;
		}
		const synth = await synthForPnr();
		if (!synth) {
			return;
		}
		const runs: RunRecord[] = [];
		for (const sc of picked) {
			const run = await runJob('pnr', { basedOn: synth, pnr: { scenario: sc.label, stopAfter: depth.stage } });
			if (run) {
				runs.push(run);
			}
		}
		if (runs.length) {
			panels.showScenarioComparison(s, runs);
		}
	});
	command('siliconStudio.pnr.selectScenario', async () => {
		const s = requireStore();
		const scenarios = s.project.config.physical?.scenarios ?? [];
		const picked = await vscode.window.showQuickPick([
			{ label: 'default', description: 'the physical section itself', name: undefined as string | undefined },
			...scenarios.map(sc => ({ label: sc.name, description: sc.name === s.project.config.physical?.activeScenario ? 'active' : '', name: sc.name as string | undefined })),
		], { placeHolder: 'Floorplan scenario used by Run Place & Route' });
		if (!picked || !s.project.config.physical) {
			return;
		}
		const config = JSON.parse(fs.readFileSync(s.project.configPath, 'utf8'));
		if (picked.name) {
			config.physical.activeScenario = picked.name;
		} else {
			delete config.physical.activeScenario;
		}
		fs.writeFileSync(s.project.configPath, JSON.stringify(config, undefined, '\t') + '\n');
		await loadStore(s.project.root);
	});
	command('siliconStudio.pnr.layout', async (arg?: unknown, stageName?: string) => {
		const run = await pnrRunArg(arg);
		const available = checkpointStages(run!);
		const stage = stageArg(stageName) ?? (available.length === 1 ? available[0] : await pickStage('Which stage?', available));
		if (stage) {
			await showLayout(run!, stage);
		}
	});
	command('siliconStudio.pnr.report', async (arg?: unknown) => panels.showPhysicalReport(requireStore(), (await pnrRunArg(arg))!));
	command('siliconStudio.pnr.revealGds', async (arg?: unknown) => {
		const run = await pnrRunArg(arg);
		const gds = path.join(requireStore().runDir(run!.id), PNR_DIR, '6_final.gds');
		if (!fs.existsSync(gds)) {
			throw new UserError(`Run ${run!.id} did not write a GDSII file.`);
		}
		vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(gds));
	});
	command('siliconStudio.pnr.gui', async (arg?: unknown, stageName?: string) => {
		const run = await pnrRunArg(arg);
		const available = checkpointStages(run!);
		const stage = stageArg(stageName) ?? available[available.length - 1];
		const openroad = (await tools.resolve()).openroad;
		if (!stage || openroad.mode === 'unavailable') {
			throw new UserError(openroad.mode === 'unavailable' ? 'openroad is not installed.' : 'This run has no checkpoint to open.');
		}
		const dir = path.join(requireStore().runDir(run!.id), PNR_DIR);
		const script = path.join(dir, `gui_${stage}.tcl`);
		fs.writeFileSync(script, `read_db {${path.join(dir, PNR_CHECKPOINT[stage])}}\n`);
		const child = childProcess.spawn(openroad.command, ['-gui', '-no_init', '-no_splash', script], { cwd: dir, detached: true, stdio: 'ignore' });
		child.unref();
		vscode.window.setStatusBarMessage(`Opening ${PNR_LABEL[stage]} in the OpenROAD GUI…`, 5000);
	});

	/** Creates the per-user KLayout Python environment used for the GDSII merge, in a visible terminal. */
	command('siliconStudio.setupKlayout', async () => {
		const python = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find(p => fs.existsSync(p)) ?? 'python3';
		const venv = path.join(USER_TOOLS, 'pyenv');
		const ok = await vscode.window.showInformationMessage(`Install the KLayout layout engine (pip package "klayout", GPL-3.0) into ${venv}? It merges routed designs with cell layouts into GDSII.`, { modal: true }, 'Install');
		if (!ok) {
			return;
		}
		const terminal = vscode.window.createTerminal({ name: 'Silicon Studio Setup' });
		terminal.show();
		terminal.sendText(`"${python}" -m venv "${venv}" && "${venv}/bin/python3" -m pip install --upgrade klayout && echo "KLayout installed - run Silicon Studio: Show Engine Status to confirm."`);
		tools.invalidate();
	});

	// ---- Synopsys-style shells (DC / ICC2 / PrimeTime) ------------------------------------------

	function shellOptions(kind: ShellKind, script?: string): vscode.TerminalOptions {
		const t = toolInfo;
		const tool = kind === 'dc' ? t?.yosys : t?.openroad;
		if (!tool || tool.mode !== 'native') {
			throw new UserError(`${SHELLS[kind].name} needs a native ${kind === 'dc' ? 'yosys' : 'openroad'} installation.`);
		}
		const physical = store?.project.config.physical;
		let platformTcl = '';
		if (physical?.platform) {
			try {
				platformTcl = path.join(loadPlatform(context.extensionPath, physical.platform).dir, 'platform.tcl');
			} catch {
				// the shell still starts; libraries can be set with set_app_var / create_lib
			}
		}
		const shellScript = path.join(context.extensionPath, 'shells', SHELLS[kind].script);
		return {
			name: SHELLS[kind].name,
			shellPath: tool.command,
			shellArgs: kind === 'dc' ? ['-q', '-c', shellScript] : ['-no_init', '-no_splash', shellScript],
			cwd: store?.project.root,
			iconPath: new vscode.ThemeIcon(kind === 'dc' ? 'circuit-board' : kind === 'icc2' ? 'layout' : 'watch'),
			env: {
				SILICON_PLATFORM_TCL: platformTcl,
				SILICON_OPENROAD: t?.openroad.mode === 'native' ? t.openroad.command : '',
				SILICON_PYTHON: t?.klayout.mode === 'native' ? t.klayout.command : '',
				SILICON_FLOW_DIR: path.join(context.extensionPath, 'flow'),
				SILICON_INTERACTIVE: '1',
				SILICON_SCRIPT: script ?? '',
			},
		};
	}

	for (const kind of Object.keys(SHELLS) as ShellKind[]) {
		command(`siliconStudio.shell.${kind}`, async () => {
			toolInfo = await tools.resolve();
			vscode.window.createTerminal(shellOptions(kind)).show();
		});
		context.subscriptions.push(vscode.window.registerTerminalProfileProvider(`siliconStudio.${kind}Shell`, {
			provideTerminalProfile: async () => {
				await detectTools();
				return new vscode.TerminalProfile(shellOptions(kind));
			},
		}));
	}
	command('siliconStudio.shell.runScript', async (uri?: vscode.Uri) => {
		const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
		if (!file || !/\.(tcl|sdc)$/i.test(file)) {
			throw new UserError('Open a .tcl script to run it in a shell.');
		}
		await vscode.window.activeTextEditor?.document.save();
		const guess: ShellKind = /icc2|pnr|place|route|floorplan/i.test(path.basename(file)) ? 'icc2' : /pt|sta|timing/i.test(path.basename(file)) ? 'pt' : 'dc';
		const kinds = (Object.keys(SHELLS) as ShellKind[]).sort((x, y) => (x === guess ? -1 : y === guess ? 1 : 0));
		const items: (vscode.QuickPickItem & { shell: ShellKind })[] = kinds.map(k => ({ label: SHELLS[k].name, shell: k }));
		const picked = await vscode.window.showQuickPick(items, { placeHolder: `Run ${path.basename(file)} in…` });
		if (picked) {
			toolInfo = await tools.resolve();
			vscode.window.createTerminal(shellOptions(picked.shell, file)).show();
		}
	});

	// ---- events -------------------------------------------------------------------------------

	let lintTimer: NodeJS.Timeout | undefined;
	const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
	context.subscriptions.push(
		configWatcher,
		configWatcher.onDidChange(() => loadStore(store?.project.root)),
		configWatcher.onDidCreate(() => loadStore()),
		configWatcher.onDidDelete(() => loadStore()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => loadStore()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('siliconStudio.tools') || e.affectsConfiguration('siliconStudio.yosys')) {
				tools.invalidate();
				detectTools();
			}
		}),
		vscode.workspace.onDidSaveTextDocument(doc => {
			const s = store;
			if (!s || !doc.uri.fsPath.startsWith(s.project.root + path.sep) || doc.uri.fsPath.includes(`${path.sep}.silicon${path.sep}`)) {
				return;
			}
			refresh();
			const hdl = doc.languageId === 'verilog' || doc.languageId === 'systemverilog';
			if (hdl && vscode.workspace.getConfiguration('siliconStudio').get<boolean>('lintOnSave', true)) {
				clearTimeout(lintTimer);
				lintTimer = setTimeout(() => {
					if (!scratchLintQueued) {
						scratchLintQueued = true;
						runJob('lint', { scratch: true });
					}
				}, 400);
			}
		}),
		{ dispose: () => { clearTimeout(lintTimer); clearTimeout(refreshTimer); store?.dispose(); } },
	);

	detectTools();
	loadStore();
}

export function deactivate(): void { }
