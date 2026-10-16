/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — the EDA flows: lint, simulation, Yosys synthesis, equivalence, reproduction.
 *  Every run executes against an immutable snapshot of its inputs (see RunStore.create).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { applySeverityOverrides, parseIverilogLog, parseOpenroadLog, parseVerilatorLog, parseVvpLog, parseYosysLog, ToolMessage } from './diagnostics';
import { comparableDigest, exec, ExecResult, RunContext, RunRecord, RunSource, RunStore, sha256File, ToolInfo, ToolName, Tools, valueDigest } from './engine';
import { loadPlatform, physicalSynthScript, PlatformInfo } from './physicalSynth';
import { CONFIG_FILE, expandEntries, FloorplanSettings, includeDirs, inputFiles, Project, ProjectConfig, rtlSources, RunKind, testbenchSources, toPosix, unsafeYosysCommand, validateProject } from './project';

export class UserError extends Error { }
class Cancelled extends Error { }

export const NETLIST_INPUT = '.silicon-netlist.v';
const RTL_JSON_INPUT = '.silicon-rtl.json';
const RESET_PORT = /^(a?rst|a?reset)(_?n|_b)?$|^n_?(rst|reset)$/i;
const CLOCKS_GOLD = 'clocks_gold.json';
const CLOCKS_GATE = 'clocks_gate.json';
// Zero-count summaries ("0 failed", "errors: 0") are not failures; "FAIL: 0 != 1" and "vector 0 MISMATCH" are.
const ZERO_FAILURES = /\b0\s+(fail(ed|ures?|s)?|mismatches|errors?)\b|\b(failures?|fails|mismatch(es)?|errors?)\s*[:=]\s*0\b/gi;

/** The first simulation log line that reports a failure, if any. */
export function failureLine(log: string): string | undefined {
	return log.split('\n').find(l => /\b(FAIL(ED|URES?|S)?|MISMATCH(ES)?)\b/i.test(l.replace(ZERO_FAILURES, '')));
}
/** Compiled simulator images embed heap addresses and absolute paths; they are not engineering outputs. */
const NOT_COMPARED = /\.vvp$|\/config\.tcl$/;

/** Physical implementation stages in order (PRD 6.2 stages 3-8), each leaving an OpenROAD checkpoint. */
export const PNR_STAGES = ['floorplan', 'pdn', 'place', 'cts', 'route', 'finish'] as const;
export type PnrStage = typeof PNR_STAGES[number];
export const PNR_CHECKPOINT: Record<PnrStage, string> = {
	floorplan: '2_floorplan.odb', pdn: '3_pdn.odb', place: '4_place.odb', cts: '5_cts.odb', route: '6_route.odb', finish: '6_final.odb',
};
export const PNR_DIR = 'outputs/pnr';
const PLATFORM_INPUT = '.silicon-platform';

export interface PnrOptions {
	stopAfter?: PnrStage;
	fromStage?: PnrStage;
	/** A previous place-and-route run whose checkpoints feed fromStage. */
	fromRun?: RunRecord;
	scenario?: string;
}

/** The floorplan used by a run: the physical section, overridden by the named (or active) scenario. */
export function effectiveFloorplan(config: ProjectConfig, scenario?: string): FloorplanSettings & { scenario?: string } {
	const p = config.physical!;
	const name = scenario ?? p.activeScenario;
	const s = p.scenarios?.find(x => x.name === name);
	if (name && !s) {
		throw new UserError(`Unknown floorplan scenario "${name}"`);
	}
	const { scenarios: _s, activeScenario: _a, platform: _p, minRoutingLayer: _min, maxRoutingLayer: _max, ctsBuffer: _c, ...base } = p;
	return { ...base, ...(s ?? {}), scenario: s?.name };
}

/** Tcl literal for config.tcl: numbers bare, strings and lists braced (inputs are validated to contain no braces). */
function tcl(value: unknown): string {
	if (typeof value === 'number') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `{${value.map(tcl).join(' ')}}`;
	}
	const str = String(value ?? '');
	if (/[{}\\]/.test(str)) {
		throw new UserError(`Unsupported character in "${str}" (braces and backslashes are not allowed in physical settings or paths)`);
	}
	return `{${str}}`;
}

/** The first create_clock period in the SDC files (comments ignored, simple "set var value" resolved). */
function sdcClock(inputsDir: string, config: ProjectConfig): { periodPs?: number; hasClock: boolean } {
	let hasClock = false;
	for (const file of expandEntries(inputsDir, config.constraints).files) {
		const text = fs.readFileSync(path.join(inputsDir, file), 'utf8').replace(/^\s*#.*$/gm, '').replace(/;\s*#.*$/gm, '');
		const vars = new Map([...text.matchAll(/^\s*set\s+(\w+)\s+([\d.]+)\s*$/gm)].map(m => [m[1], m[2]]));
		for (const m of text.matchAll(/create_clock\b[^\n]*?-period\s+(\$\{?(\w+)\}?|[\d.]+)/g)) {
			hasClock = true;
			const value = m[2] ? vars.get(m[2]) : m[1];
			if (value !== undefined && isFinite(parseFloat(value))) {
				return { periodPs: Math.round(parseFloat(value) * 1000), hasClock };
			}
		}
		hasClock ||= /create_clock\b/.test(text);
	}
	return { hasClock };
}

/** Identifies the physical settings a place-and-route run used; '' selects the base settings (no scenario). */
export function physicalDigest(config: ProjectConfig, scenario: string): string {
	const p = config.physical!;
	return valueDigest({ platform: p.platform, floorplan: effectiveFloorplan(config, scenario), minRoutingLayer: p.minRoutingLayer, maxRoutingLayer: p.maxRoutingLayer, ctsBuffer: p.ctsBuffer });
}

/** Which flow stage a report or image file belongs to ("6_route_drc.rpt" -> route, "place_congestion.png" -> place). */
function stageOfFile(file: string): PnrStage | undefined {
	if (/^6_(route|grt)/.test(file)) {
		return 'route';
	}
	if (/^6_final/.test(file)) {
		return 'finish';
	}
	return PNR_STAGES.find(st => file.startsWith(`${st}.`) || file.startsWith(`${st}_`));
}

export interface FlowHost {
	readonly extensionPath: string;
	readonly tools: Tools;
	readonly output: vscode.OutputChannel;
	publish(project: Project, ctx: RunContext, messages: ToolMessage[]): void;
}

const REQUIRED: Record<RunKind, ToolName[]> = { lint: [], sim: ['iverilog', 'vvp'], synth: ['yosys'], equiv: ['yosys'], pnr: ['openroad'] };
const INSTALL_HINT: Record<ToolName, string> = {
	yosys: 'install Yosys (https://yosyshq.net/yosys/download.html, e.g. "brew install yosys") or set siliconStudio.yosys.engine to "wasm"',
	iverilog: 'install Icarus Verilog (e.g. "brew install icarus-verilog")',
	vvp: 'install Icarus Verilog (e.g. "brew install icarus-verilog")',
	verilator: 'install Verilator (e.g. "brew install verilator")',
	openroad: 'install OpenROAD (https://openroad.org; see SILICON_STUDIO.md) or set siliconStudio.tools.openroadPath',
	klayout: 'run "Silicon Studio: Set Up GDSII Export (KLayout)" or set siliconStudio.tools.klayoutPython',
};

function quote(arg: string): string {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function defineArgs(config: ProjectConfig): string[] {
	return Object.entries(config.defines ?? {}).filter(([, v]) => v !== false).map(([k, v]) => v === true ? `-D${k}` : `-D${k}=${v}`);
}

function yosysRead(config: ProjectConfig, files: string[], incs: string[]): string[] {
	const read = ['read_verilog', '-sv', ...defineArgs(config), ...incs.map(d => `-Iinputs/${d}`), ...files.map(f => `inputs/${f}`)];
	const lines = [read.map(quote).join(' ')];
	for (const [name, value] of Object.entries(config.parameters ?? {})) {
		lines.push(`chparam -set ${name} ${value} ${config.top}`);
	}
	return lines;
}

/** The liberty file synthesis and equivalence read: the platform's copy in the snapshot, else synthesis.liberty. */
function libPath(config: ProjectConfig, inputsDir: string): string | undefined {
	if (config.physical?.platform) {
		const dir = path.join(inputsDir, PLATFORM_INPUT);
		const lib = fs.existsSync(dir) ? listFiles(dir).find(f => f.endsWith('.lib')) : undefined;
		return lib ? `inputs/${PLATFORM_INPUT}/${lib}` : undefined;
	}
	return config.synthesis?.liberty ? `inputs/${toPosix(path.normalize(config.synthesis.liberty))}` : undefined;
}

function counts(messages: ToolMessage[]): { errors: number; warnings: number } {
	return {
		errors: messages.filter(m => m.severity === 'error').length,
		warnings: messages.filter(m => m.severity === 'warning').length,
	};
}

function listFiles(dir: string, base = dir): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		const full = path.join(dir, e.name);
		return e.isDirectory() ? listFiles(full, base) : [toPosix(path.relative(base, full))];
	});
}

function readJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** Totals of a `stat -json` report (yosys 0.40+ layout: { design: {...}, modules: {...} }). */
export function statTotals(stat: any): { cells: number; wires: number; wireBits: number; area?: number; sequentialArea?: number; cellsByType: Record<string, number> } | undefined {
	const d = stat?.design;
	if (!d) {
		return undefined;
	}
	return {
		cells: d.num_cells ?? 0,
		wires: d.num_wires ?? 0,
		wireBits: d.num_wire_bits ?? 0,
		area: typeof d.area === 'number' ? d.area : undefined,
		sequentialArea: typeof d.sequential_area === 'number' ? d.sequential_area : undefined,
		cellsByType: d.num_cells_by_type ?? {},
	};
}

/** Edge-triggered flip-flops (coarse and fine-grained yosys cells); group 1 is a fine-grained cell's clock polarity. */
const FLIP_FLOP = /^\$(?:_(?:DFF|DFFE|DFFSR|DFFSRE|SDFF|SDFFE|SDFFCE|ALDFF|ALDFFE)_([NP])\w*|dff|dffe|adff|adffe|sdff|sdffe|sdffce|dffsr|dffsre|aldff|aldffe)$/;
const INVERTERS = new Set(['$_NOT_', '$not', '$logic_not']);
const BUFFERS = new Set(['$_BUF_', '$pos']);

interface ClockSource {
	/** port or const: a module input or a constant; net: a named internal net (gated or divided clock); internal: unnamed. */
	kind: 'port' | 'const' | 'net' | 'internal';
	edge: string;
	name?: string;
}

/** Every flip-flop output bit (all of its names) with the clock edge that triggers it, traced back through buffers and inverters. */
function flipFlopClocks(module: any): { q: string[]; clock: ClockSource }[] {
	const nameBits = (entries: [string, any][]) => {
		const names = new Map<number | string, string[]>();
		for (const [name, net] of entries) {
			net.bits.forEach((bit: number | string, i: number) => {
				const index = (net.offset ?? 0) + (net.upto ? net.bits.length - 1 - i : i);
				names.set(bit, [...names.get(bit) ?? [], net.bits.length > 1 ? `${name}[${index}]` : name]);
			});
		}
		return names;
	};
	const names = nameBits(Object.entries<any>(module?.netnames ?? {}).filter(([, net]) => !net.hide_name));
	const inputs = nameBits(Object.entries<any>(module?.ports ?? {}).filter(([, port]) => port.direction === 'input'));
	const cells = Object.values<any>(module?.cells ?? {});
	const driver = new Map<number | string, { cell: any; index: number }>();
	for (const cell of cells) {
		for (const [port, bits] of Object.entries<any>(cell.connections)) {
			if (cell.port_directions?.[port] === 'output') {
				bits.forEach((bit: number | string, index: number) => driver.set(bit, { cell, index }));
			}
		}
	}
	return cells.flatMap(cell => {
		const ff = FLIP_FLOP.exec(cell.type);
		if (!ff) {
			return [];
		}
		let rising = ff[1] ? ff[1] === 'P' : /1$/.test(String(cell.parameters?.CLK_POLARITY ?? '1'));
		let bit = (cell.connections.C ?? cell.connections.CLK)[0];
		for (let hops = 0; hops < 10000; hops++) {
			const d = driver.get(bit);
			const next = d && (INVERTERS.has(d.cell.type) || BUFFERS.has(d.cell.type)) && (d.cell.type !== '$logic_not' || d.index === 0) ? d.cell.connections.A[d.index] : undefined;
			if (next === undefined) {
				break;
			}
			rising = INVERTERS.has(d!.cell.type) ? !rising : rising;
			bit = next;
		}
		const port = inputs.get(bit)?.[0];
		const name = typeof bit === 'string' ? bit : port ?? names.get(bit)?.[0];
		const clock: ClockSource = { kind: typeof bit === 'string' ? 'const' : port ? 'port' : name ? 'net' : 'internal', edge: `${rising ? 'rising' : 'falling'} ${name ?? 'unnamed net'}`, name };
		return (cell.connections.Q as (number | string)[]).map(q => ({ q: names.get(q) ?? [], clock }));
	});
}

/**
 * Compares how the RTL (gold) and the netlist (gate) clock each flip-flop, pairing them by output net name.
 * wrong: a definite difference; untraced: a netlist clock that cannot be traced to the RTL's clock.
 */
export function clockMismatches(gold: any, gate: any): { wrong: string[]; untraced: string[] } {
	const rtl = new Map(flipFlopClocks(gold).flatMap(f => f.q.map(n => [n, f.clock] as const)));
	const rtlEdges = new Set([...rtl.values()].filter(c => c.kind === 'port' || c.kind === 'const').map(c => c.edge));
	const wrong: string[] = [];
	const untraced: string[] = [];
	for (const { q, clock } of flipFlopClocks(gate)) {
		const fixed = clock.kind === 'port' || clock.kind === 'const';
		const name = q.find(n => rtl.has(n));
		const ref = name ? rtl.get(name)! : undefined;
		if (!ref) {
			// Unpaired (e.g. a register stored inverted): its function is the logic check's job; its clock must still be an RTL clock.
			if (fixed && !rtlEdges.has(clock.edge)) {
				wrong.push(`${q[0] ?? 'unnamed flip-flop'}: netlist ${clock.edge}, which clocks no RTL flip-flop`);
			}
		} else if ((ref.kind === 'port' || ref.kind === 'const') ? fixed : ref.name === clock.name) {
			if (ref.edge !== clock.edge) {
				wrong.push(`${name}: RTL ${ref.edge}, netlist ${clock.edge}`);
			}
		} else {
			untraced.push(`${name}: RTL ${ref.edge}, netlist ${clock.edge}`);
		}
	}
	return { wrong, untraced };
}

export class Flows {
	constructor(private readonly host: FlowHost) { }

	/** Validates, snapshots and executes one run. Throws UserError for problems found before the run starts. */
	async run(store: RunStore, kind: RunKind, token: vscode.CancellationToken, opts: { scratch?: boolean; basedOn?: RunRecord; reproduce?: RunRecord; pnr?: PnrOptions } = {}): Promise<RunRecord> {
		const project = store.project;
		const tools = await this.host.tools.resolve();
		let source: RunSource;
		if (opts.reproduce) {
			source = store.sourceOf(opts.reproduce);
		} else {
			const issues = validateProject(project, kind);
			const errors = issues.filter(i => i.severity === 'error');
			if (errors.length) {
				throw new UserError(`Cannot start ${kind}: ${errors.map(e => e.message).join(' ')}`);
			}
			if (kind === 'pnr') {
				source = this.pnrSource(store, opts.basedOn);
				this.checkResume(store, opts.basedOn!, opts.pnr ?? {});
			} else if (kind === 'equiv') {
				const synth = opts.basedOn;
				if (!synth) {
					throw new UserError('Run synthesis first: equivalence compares the RTL with the synthesized netlist.');
				}
				const base = store.sourceOf(synth);
				const outputs = path.join(store.runDir(synth.id), 'outputs');
				source = { ...base, extra: [...(base.extra ?? []), ...[{ from: path.join(outputs, 'netlist.v'), to: NETLIST_INPUT }, { from: path.join(outputs, 'rtl.json'), to: RTL_JSON_INPUT }].filter(x => fs.existsSync(x.from))] };
			} else {
				source = { root: project.root, config: project.config, files: inputFiles(project.root, project.config, kind) };
				if (kind === 'synth' && project.config.physical?.platform) {
					source.extra = this.platformFiles(this.platform(project.config.physical.platform), ['lib', 'latchMap', 'clkgateMap', 'adderMap']);
				}
			}
		}
		for (const name of REQUIRED[kind]) {
			if (tools[name].mode === 'unavailable') {
				throw new UserError(`${name} is unavailable (${tools[name].detail}): ${INSTALL_HINT[name]}.`);
			}
		}
		if (kind === 'lint' && !this.lintTool(source.config, tools) && tools.yosys.mode === 'unavailable') {
			throw new UserError(`No lint engine available: ${INSTALL_HINT.verilator}, or ${INSTALL_HINT.yosys}.`);
		}
		const blocked = (source.config.synthesis?.extraCommands ?? []).map(c => [c, unsafeYosysCommand(c)]).find(([, problem]) => problem);
		if (blocked && kind === 'synth') {
			throw new UserError(`synthesis.extraCommands: "${blocked[0]}" ${blocked[1]}`);
		}

		const used = kind === 'sim' ? [tools.iverilog] : kind === 'lint' ? [this.lintTool(source.config, tools), tools.yosys] : kind === 'pnr' ? [tools.openroad, tools.klayout] : [tools.yosys];
		const target = used.filter(t => t && t.mode !== 'unavailable').map(t => `${t!.name} ${t!.mode === 'wasm' ? '(local WebAssembly)' : '(local native)'}`).join(', ');
		const ctx = store.create(kind, source, {
			scratch: opts.scratch,
			basedOn: opts.basedOn?.id,
			reproducedFrom: opts.reproduce?.id,
			executionTarget: target || 'none',
		});
		this.host.output.appendLine(`\n▶ ${kind} run ${ctx.run.id} — ${target}`);

		let messages: ToolMessage[] = [];
		try {
			switch (kind) {
				case 'lint': messages = await this.lint(ctx, tools, token); break;
				case 'sim': messages = await this.simulate(ctx, tools, token); break;
				case 'synth': messages = await this.synthesize(ctx, tools, token); break;
				case 'equiv': messages = await this.equivalence(ctx, tools, token); break;
				case 'pnr': messages = await this.placeAndRoute(store, ctx, tools, token, opts.reproduce ? this.pnrOptionsOf(store, opts.reproduce) : opts.pnr ?? {}); break;
			}
		} catch (e) {
			ctx.run.status = e instanceof Cancelled ? 'cancelled' : 'error';
			ctx.run.summary = e instanceof Cancelled ? 'Cancelled by user' : e.message;
		}
		ctx.run.diagnostics = counts(messages);
		fs.writeFileSync(path.join(ctx.logsDir, 'diagnostics.json'), JSON.stringify(messages, undefined, '\t') + '\n');
		if (opts.reproduce) {
			this.compareWith(store, ctx, opts.reproduce);
		}
		store.finish(ctx);
		this.host.publish(project, ctx, messages);
		this.host.output.appendLine(`■ ${ctx.run.id}: ${ctx.run.status} — ${ctx.run.summary}`);
		return ctx.run;
	}

	private lintTool(config: ProjectConfig, tools: Record<ToolName, ToolInfo>): ToolInfo | undefined {
		const wanted = config.lint?.engine ?? 'auto';
		const order: ToolName[] = wanted === 'auto' ? ['verilator', 'iverilog'] : wanted === 'yosys' ? [] : [wanted];
		return order.map(n => tools[n]).find(t => t.mode !== 'unavailable');
	}

	private async step(ctx: RunContext, tool: ToolInfo, args: string[], cwd: string, log: string, token: vscode.CancellationToken, timeoutMs?: number, env?: Record<string, string>): Promise<ExecResult> {
		const out = this.host.output;
		const shownCwd = toPosix(path.relative(ctx.dir, cwd)) || '.';
		out.appendLine(`$ (cd ${shownCwd} && ${tool.name} ${args.map(quote).join(' ')})`);
		const timeout = timeoutMs ?? vscode.workspace.getConfiguration('siliconStudio').get<number>('jobTimeoutSeconds', 600) * 1000;
		const result = await exec(tool, args, { cwd, timeoutMs: timeout, token, env, onData: text => out.append(text) });
		fs.writeFileSync(path.join(ctx.logsDir, log), result.output);
		ctx.run.steps.push({
			tool: tool.name,
			mode: tool.mode,
			version: tool.version,
			args,
			cwd: shownCwd,
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			timedOut: result.timedOut,
			log: `logs/${log}`,
		});
		if (result.cancelled) {
			throw new Cancelled();
		}
		if (result.spawnError) {
			throw new Error(`${tool.name} could not be started: ${result.spawnError}`);
		}
		if (result.timedOut && !timeoutMs) {
			throw new Error(`${tool.name} exceeded the ${timeout / 1000}s job timeout (siliconStudio.jobTimeoutSeconds)`);
		}
		return result;
	}

	private async lint(ctx: RunContext, tools: Record<ToolName, ToolInfo>, token: vscode.CancellationToken): Promise<ToolMessage[]> {
		const { config } = ctx.source;
		const rtl = rtlSources(ctx.inputsDir, config);
		const incs = includeDirs(config, rtl);
		const engine = this.lintTool(config, tools);
		const messages: ToolMessage[] = [];

		if (engine?.name === 'verilator') {
			const params = Object.entries(config.parameters ?? {}).map(([k, v]) => `-G${k}=${v}`);
			const r = await this.step(ctx, engine, ['--lint-only', '-Wall', '-Wno-fatal', '--top-module', config.top, ...incs.map(d => `-I${d}`), ...defineArgs(config), ...params, ...rtl], ctx.inputsDir, 'verilator.log', token);
			messages.push(...parseVerilatorLog(r.output));
			if (r.exitCode !== 0 && !messages.some(m => m.severity === 'error')) {
				messages.push({ tool: 'verilator', severity: 'error', message: `verilator exited with code ${r.exitCode}` });
			}
		} else if (engine?.name === 'iverilog') {
			const params = Object.entries(config.parameters ?? {}).map(([k, v]) => `-P${config.top}.${k}=${v}`);
			const r = await this.step(ctx, engine, ['-g2012', '-Wall', '-tnull', '-s', config.top, ...incs.map(d => `-I${d}`), ...defineArgs(config), ...params, ...rtl], ctx.inputsDir, 'iverilog.log', token);
			messages.push(...parseIverilogLog(r.output));
			if (r.exitCode !== 0 && !messages.some(m => m.severity === 'error')) {
				messages.push({ tool: 'iverilog', severity: 'error', message: `iverilog exited with code ${r.exitCode}` });
			}
		}

		// Yosys elaboration adds latch/driver checks and the hierarchy used by the Design Hierarchy view.
		const parsed = !messages.some(m => m.severity === 'error');
		if (parsed && tools.yosys.mode !== 'unavailable') {
			const script = [...yosysRead(config, rtl, incs), `hierarchy -check -top ${config.top}`, 'proc', 'check', 'write_json outputs/elab.json'];
			fs.writeFileSync(path.join(ctx.outputsDir, 'lint.ys'), script.join('\n') + '\n');
			const r = await this.step(ctx, tools.yosys, ['-s', 'outputs/lint.ys'], ctx.dir, 'yosys.log', token);
			const yosysMessages = parseYosysLog(r.output);
			messages.push(...yosysMessages);
			if (r.exitCode !== 0 && !yosysMessages.some(m => m.severity === 'error')) {
				messages.push({ tool: 'yosys', severity: 'error', message: `yosys exited with code ${r.exitCode}` });
			}
		}
		const result = applySeverityOverrides(messages, config.lint?.severity ?? {});
		const { errors, warnings } = counts(result);
		ctx.run.status = errors ? 'failed' : 'passed';
		const engines = [engine?.name, parsed && tools.yosys.mode !== 'unavailable' ? 'yosys' : undefined].filter(Boolean).join(' + ');
		ctx.run.summary = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} (${engines})`;
		ctx.run.metrics = { engine: engines, errors, warnings };
		return result;
	}

	private async simulate(ctx: RunContext, tools: Record<ToolName, ToolInfo>, token: vscode.CancellationToken): Promise<ToolMessage[]> {
		const { config } = ctx.source;
		const tb = config.testbench!;
		const rtl = rtlSources(ctx.inputsDir, config);
		const tbs = testbenchSources(ctx.inputsDir, config);
		const files = [...rtl, ...tbs];
		const incs = includeDirs(config, files);
		const tops = ['-s', tb.top];

		const dumps = tbs.some(f => /\$dump(file|vars)\b/.test(fs.readFileSync(path.join(ctx.inputsDir, f), 'utf8')));
		if (!dumps) {
			fs.writeFileSync(path.join(ctx.outputsDir, 'silicon_dump.v'), `// Added by Silicon Studio: the testbench does not dump waveforms itself.\nmodule silicon_dump;\n  initial begin\n    $dumpfile("wave.vcd");\n    $dumpvars(0, ${tb.top});\n  end\nendmodule\n`);
			files.push('../outputs/silicon_dump.v');
			tops.push('-s', 'silicon_dump');
			ctx.run.notes.push('Waveform dumping was added automatically (testbench has no $dumpfile/$dumpvars).');
		}

		const compile = await this.step(ctx, tools.iverilog, ['-g2012', '-Wall', '-o', '../outputs/sim.vvp', ...tops, ...incs.map(d => `-I${d}`), ...defineArgs(config), ...files], ctx.inputsDir, 'iverilog.log', token);
		const messages = parseIverilogLog(compile.output);
		if (compile.exitCode !== 0) {
			if (!messages.some(m => m.severity === 'error')) {
				messages.push({ tool: 'iverilog', severity: 'error', message: `iverilog exited with code ${compile.exitCode}` });
			}
			ctx.run.status = 'failed';
			ctx.run.summary = `Compilation failed: ${messages.find(m => m.severity === 'error')!.message.split('\n')[0]}`;
			return messages;
		}

		const before = new Set(listFiles(ctx.inputsDir));
		const timeoutS = tb.timeoutSeconds ?? 120;
		const sim = await this.step(ctx, tools.vvp, ['-n', '../outputs/sim.vvp', ...(tb.plusargs ?? []).map(p => p.startsWith('+') ? p : `+${p}`)], ctx.inputsDir, 'vvp.log', token, timeoutS * 1000);
		// Files the simulation wrote (waveforms, $fopen logs) move out of the immutable input snapshot.
		for (const f of listFiles(ctx.inputsDir).filter(f => !before.has(f))) {
			const to = path.join(ctx.outputsDir, f);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.renameSync(path.join(ctx.inputsDir, f), to);
		}
		messages.push(...parseVvpLog(sim.output));

		const wave = listFiles(ctx.outputsDir).find(f => /\.(vcd|fst)$/i.test(f));
		const finish = /\$finish called at (\d+) \(([a-z]+)\)/.exec(sim.output);
		ctx.run.metrics = { waveform: wave ? `outputs/${wave}` : undefined, endTime: finish ? `${finish[1]} ${finish[2]}` : undefined, exitCode: sim.exitCode };

		const failLine = failureLine(sim.output);
		const runtimeError = messages.find(m => m.severity === 'error' && m.tool === 'vvp');
		if (sim.timedOut) {
			ctx.run.status = 'error';
			ctx.run.summary = `Timed out after ${timeoutS}s (testbench.timeoutSeconds) — missing $finish?`;
		} else if (sim.exitCode !== 0 || runtimeError || failLine) {
			ctx.run.status = 'failed';
			ctx.run.summary = `Testbench failed: ${(failLine ?? runtimeError?.message ?? `vvp exited with code ${sim.exitCode}`).trim()}`;
		} else if (/\bPASS(ED)?\b/i.test(sim.output)) {
			ctx.run.status = 'passed';
			ctx.run.summary = 'Testbench reported PASS (a passing simulation is not proof of full functional correctness)';
		} else {
			ctx.run.status = 'inconclusive';
			ctx.run.summary = 'Simulation finished without a PASS/FAIL verdict from the testbench';
		}
		if (!wave) {
			ctx.run.notes.push('No waveform file was produced.');
		}
		return messages;
	}

	private async synthesize(ctx: RunContext, tools: Record<ToolName, ToolInfo>, token: vscode.CancellationToken): Promise<ToolMessage[]> {
		const { config } = ctx.source;
		const rtl = rtlSources(ctx.inputsDir, config);
		const incs = includeDirs(config, rtl);
		const syn = config.synthesis ?? {};
		const lib = libPath(config, ctx.inputsDir);
		const flags = `${syn.flatten !== false ? ' -flatten' : ''}${syn.abc === false ? ' -noabc' : ''}`;
		const platform = config.physical?.platform ? this.snapshotPlatform(config.physical.platform) : undefined;
		const clock = sdcClock(ctx.inputsDir, config);
		if (platform && clock.hasClock && clock.periodPs === undefined) {
			ctx.run.notes.push('The clock period in the SDC could not be read (e.g. -period [expr ...]); ABC ran without a delay target.');
		}
		const script = platform ? [
			`# Synthesis for the ${platform.name} platform generated by Silicon Studio from silicon.json`,
			...physicalSynthScript({
				files: rtl.map(f => `inputs/${f}`),
				incs: incs.map(d => `inputs/${d}`),
				defines: defineArgs(config),
				params: config.parameters ?? {},
				top: config.top,
				platform,
				flatten: syn.flatten !== false,
				clockPeriodPs: clock.periodPs,
				outDir: 'outputs',
				cwd: ctx.dir,
			}),
		] : [
			'# Synthesis script generated by Silicon Studio from silicon.json',
			...yosysRead(config, rtl, incs),
			`hierarchy -check -top ${config.top}`,
			'proc',
			'opt_clean',
			'write_json outputs/rtl.json',
			'tee -q -o outputs/rtl_stat.json stat -json',
			// -nofsm: see physicalSynthScript (FSM re-encoding defeats equivalence's name matching).
			`synth -top ${config.top}${flags} -nofsm`,
			'opt_clean -purge',
			'tee -q -o outputs/generic_stat.json stat -json',
			...(lib ? [
				`read_liberty -lib ${quote(lib)}`,
				`dfflibmap -liberty ${quote(lib)}`,
				`abc -liberty ${quote(lib)}`,
				'opt_clean -purge',
				`tee -q -o outputs/mapped_stat.json stat -json -liberty ${quote(lib)}`,
			] : []),
			'check',
			...(syn.extraCommands ?? []),
			`tee -q -o outputs/stat.txt stat${lib ? ` -liberty ${quote(lib)}` : ''}`,
			'write_verilog -noattr outputs/netlist.v',
			'write_json outputs/netlist.json',
		];
		fs.writeFileSync(path.join(ctx.outputsDir, 'synth.ys'), script.join('\n') + '\n');
		const r = await this.step(ctx, tools.yosys, ['-s', 'outputs/synth.ys'], ctx.dir, 'yosys.log', token);
		const messages = parseYosysLog(r.output).filter(m => !/network is combinational/i.test(m.message));
		if (r.exitCode !== 0) {
			if (!messages.some(m => m.severity === 'error')) {
				messages.push({ tool: 'yosys', severity: 'error', message: `yosys exited with code ${r.exitCode}` });
			}
			ctx.run.status = 'failed';
			ctx.run.summary = `Synthesis failed: ${messages.find(m => m.severity === 'error')!.message.split('\n')[0]}`;
			return messages;
		}

		const generic = statTotals(readJson(path.join(ctx.outputsDir, 'generic_stat.json')));
		const mapped = lib ? statTotals(readJson(path.join(ctx.outputsDir, 'mapped_stat.json'))) : undefined;
		const rtlStat = statTotals(readJson(path.join(ctx.outputsDir, 'rtl_stat.json')));
		const libName = platform ? `${platform.name} ${path.basename(lib ?? '')}` : syn.liberty;
		ctx.run.metrics = { generic, mapped, rtl: rtlStat, liberty: libName, platform: platform?.name, pdk: platform ? { name: platform.name, source: 'OpenROAD-flow-scripts platform' } : config.pdk, flatten: syn.flatten !== false, abc: syn.abc !== false };
		ctx.run.status = 'passed';
		const { warnings } = counts(messages);
		ctx.run.summary = mapped
			? `${mapped.cells} cells, area ${mapped.area?.toFixed(2)} (${path.basename(libName ?? '')}), ${warnings} warning${warnings === 1 ? '' : 's'}`
			: `${generic?.cells ?? '?'} generic gates (no liberty: standard-cell area not computed), ${warnings} warning${warnings === 1 ? '' : 's'}`;
		return messages;
	}

	private async equivalence(ctx: RunContext, tools: Record<ToolName, ToolInfo>, token: vscode.CancellationToken): Promise<ToolMessage[]> {
		const { config } = ctx.source;
		const rtl = rtlSources(ctx.inputsDir, config);
		const incs = includeDirs(config, rtl);
		const lib = libPath(config, ctx.inputsDir);
		const top = config.top;
		const depth = 5;
		const bound = 20;
		// The bounded search starts from reset: registers may legally be mapped with inverted polarity, so the
		// power-up state is only comparable after reset. Reset port: silicon.json, else a conventional name.
		const ports: Record<string, { direction: string }> = readJson(path.join(ctx.inputsDir, RTL_JSON_INPUT))?.modules?.[top]?.ports ?? {};
		const reset = config.equivalence?.reset ?? Object.keys(ports).find(p => ports[p].direction === 'input' && RESET_PORT.test(p));
		const activeLow = config.equivalence?.resetActiveLow ?? (!!reset && /(_?n|_b)$|^n_?/i.test(reset));
		const fromReset = reset ? `-set-at 1 in_${reset} ${activeLow ? 0 : 1} -prove-skip 1 ` : '';
		// With a reset, registers start unknown (X) and outputs the RTL still leaves X are not compared: power-up
		// states are not comparable when the mapper stores a bit inverted. Without one, both sides start at zero.
		const init = reset ? '-set-init-undef -set-def-inputs -enable_undef' : '-set-init-zero';
		// RTL that instantiates the platform clock gate needs the same model synthesis read.
		const clkgate = config.physical?.platform ? this.snapshotPlatform(config.physical.platform).clkgateMap : undefined;
		const script = [
			'# Equivalence check generated by Silicon Studio: RTL (gold) vs synthesized netlist (gate)',
			...yosysRead(config, rtl, incs),
			...(clkgate && fs.existsSync(path.join(ctx.dir, clkgate)) ? [`read_verilog ${quote(clkgate)}`] : []),
			// splitnets: platform netlists name each register bit separately; match that so equiv_make pairs them.
			`hierarchy -check -top ${top}`, 'proc', 'flatten', 'opt_clean', 'splitnets',
			// async2sync models an async-reset latch wrongly (it stores D, not the reset value, while both are
			// active): lower it to a plain latch plus logic first, as synthesis does.
			'simplemap t:$adlatch t:$dlatchsr', 'dfflegalize -cell $_DLATCH_P_ x -cell $_DLATCH_N_ x t:$_DLATCH*',
			`rename ${top} gold`,
			// The SAT models below run every flop on one global clock, so clock wiring is compared structurally.
			'select gold', `write_json -selected -noscopeinfo outputs/${CLOCKS_GOLD}`, 'select -clear',
			'design -stash gold',
			...(lib ? [`read_liberty -ignore_miss_func ${quote(lib)}`] : []),
			`read_verilog inputs/${NETLIST_INPUT}`,
			`hierarchy -check -top ${top}`, 'flatten', 'opt_clean', `rename ${top} gate`,
			'select gate', `write_json -selected -noscopeinfo outputs/${CLOCKS_GATE}`, 'select -clear',
			'design -stash gate',
			// Bounded search for a counterexample (a miter that flags any output mismatch).
			'design -copy-from gold -as gold gold',
			'design -copy-from gate -as gate gate',
			'miter -equiv -flatten -make_outputs -ignore_gold_x gold gate miter',
			'hierarchy -top miter',
			'async2sync',
			`sat -seq ${bound} ${fromReset}-prove trigger 0 ${init} -timeout 300 -show-ports miter`,
			// Unbounded proof by induction over matched equivalence points.
			'design -reset',
			'design -copy-from gold -as gold gold',
			'design -copy-from gate -as gate gate',
			'equiv_make gold gate equiv',
			'hierarchy -top equiv',
			'async2sync',
			// -undef: RTL x values (e.g. `default: y = 'x`) are don't-cares the netlist may refine.
			`equiv_simple -undef -seq ${depth}`,
			`equiv_induct -undef -seq ${depth}`,
			'equiv_status',
		];
		fs.writeFileSync(path.join(ctx.outputsDir, 'equiv.ys'), script.join('\n') + '\n');
		const r = await this.step(ctx, tools.yosys, ['-s', 'outputs/equiv.ys'], ctx.dir, 'yosys.log', token);
		const messages = parseYosysLog(r.output);
		const found = /Found (\d+) \$equiv cells in equiv:\s*\n\s*Of those cells (\d+) are proven and (\d+) are unproven/.exec(r.output);
		const bounded = /SAT proof finished - model found: FAIL/.test(r.output) ? 'counterexample' : /SAT proof finished - no model found: SUCCESS/.test(r.output) ? 'no counterexample' : 'unknown';
		const clocks = clockMismatches(readJson(path.join(ctx.outputsDir, CLOCKS_GOLD))?.modules?.gold, readJson(path.join(ctx.outputsDir, CLOCKS_GATE))?.modules?.gate);
		const list = (items: string[]) => `${items.slice(0, 3).join('; ')}${items.length > 3 ? `; ${items.length - 3} more in the run notes` : ''}`;
		if (clocks.wrong.length + clocks.untraced.length > 3) {
			ctx.run.notes.push(...clocks.wrong.map(c => `Clock differs: ${c}`), ...clocks.untraced.map(c => `Clock not traced: ${c}`));
		}
		ctx.run.metrics = { ...(found ? { equivCells: +found[1], proven: +found[2], unproven: +found[3] } : {}), inductionDepth: depth, boundedCycles: bound, bounded, boundedFrom: reset ? `reset (${reset}=${activeLow ? 0 : 1})` : 'all-zero registers', clockMismatches: clocks.wrong.length, clocksUntraced: clocks.untraced.length };
		const start = reset ? `after asserting ${reset} (registers start unknown)` : 'from an all-zero register state (no reset port found; set equivalence.reset in silicon.json)';
		if (r.exitCode !== 0 || !found) {
			ctx.run.status = 'error';
			ctx.run.summary = `Equivalence check could not complete: ${messages.find(m => m.severity === 'error')?.message.split('\n')[0] ?? `yosys exited with code ${r.exitCode}`}`;
		} else if (clocks.wrong.length) {
			// The SAT models ignore clock wiring, so a structural clock difference overrides their verdict.
			ctx.run.status = 'failed';
			ctx.run.summary = `Not equivalent: ${clocks.wrong.length} flip-flop${clocks.wrong.length === 1 ? ' is' : 's are'} clocked differently from the RTL (${list(clocks.wrong)})`;
		} else if (+found[3] === 0 && clocks.untraced.length) {
			ctx.run.status = 'inconclusive';
			ctx.run.summary = `Logic proven (${found[1]} equivalence points), but the clock of ${clocks.untraced.length} flip-flop${clocks.untraced.length === 1 ? '' : 's'} could not be traced to the RTL clock (${list(clocks.untraced)})`;
		} else if (+found[3] === 0) {
			// The induction proof is sound; a bounded "counterexample" here only reflects the all-zero start state
			// (e.g. registers that reset to non-zero values or that the mapper stores inverted).
			ctx.run.status = 'passed';
			ctx.run.summary = `Proven equivalent: all ${found[1]} equivalence points proven by induction (depth ${depth})`;
		} else if (bounded === 'counterexample') {
			ctx.run.status = 'failed';
			ctx.run.summary = `Not equivalent: ${found[3]} of ${found[1]} equivalence points unproven and a counterexample exists within ${bound} cycles ${start} (see the SAT trace in the log)`;
		} else if (bounded === 'no counterexample') {
			ctx.run.status = 'inconclusive';
			ctx.run.summary = `Bounded only: no counterexample within ${bound} cycles ${start}, but ${found[3]} of ${found[1]} equivalence points are unproven by induction`;
		} else {
			ctx.run.status = 'inconclusive';
			ctx.run.summary = `Inconclusive: ${found[3]} of ${found[1]} equivalence points unproven and the bounded check timed out`;
		}
		return messages;
	}

	private platform(name: string): PlatformInfo {
		try {
			return loadPlatform(this.host.extensionPath, name);
		} catch (e) {
			throw new UserError(e.message);
		}
	}

	/** Platform files copied into a run snapshot so the run is self-contained (and readable by WebAssembly Yosys). */
	private platformFiles(platform: PlatformInfo, keys: (keyof PlatformInfo)[]): { from: string; to: string }[] {
		const files = keys.flatMap(k => {
			const v = platform[k];
			return (Array.isArray(v) ? v : [v]).filter((p): p is string => typeof p === 'string' && p.length > 0 && fs.existsSync(p));
		});
		return files.map(p => ({ from: p, to: `${PLATFORM_INPUT}/${platform.name}/${toPosix(path.relative(platform.dir, p))}` }));
	}

	/** The platform with its synthesis files pointing at the run snapshot copies (inputs/.silicon-platform/...). */
	private snapshotPlatform(name: string): PlatformInfo {
		const platform = this.platform(name);
		const local = (p: string) => p ? `inputs/${PLATFORM_INPUT}/${name}/${toPosix(path.relative(platform.dir, p))}` : p;
		return { ...platform, lib: platform.lib.map(local), latchMap: local(platform.latchMap), clkgateMap: local(platform.clkgateMap), adderMap: local(platform.adderMap) };
	}

	/** Place-and-route inputs: the synthesized netlist and its snapshot, with the CURRENT silicon.json (floorplan edits need no re-synthesis). */
	private pnrSource(store: RunStore, synth: RunRecord | undefined): RunSource {
		const config = store.project.config;
		if (!synth || synth.status !== 'passed') {
			throw new UserError('Synthesize the design first: place and route starts from the synthesized netlist.');
		}
		if (synth.metrics?.platform !== config.physical?.platform) {
			throw new UserError(`The latest synthesis targeted ${synth.metrics?.platform ? `the ${synth.metrics.platform} platform` : 'no platform'}, but physical.platform is "${config.physical?.platform}". Re-run synthesis.`);
		}
		const base = store.sourceOf(synth);
		const outputs = path.join(store.runDir(synth.id), 'outputs');
		return {
			root: base.root,
			config,
			files: base.files.filter(f => f !== CONFIG_FILE),
			extra: [...(base.extra ?? []), { from: path.join(outputs, 'netlist.v'), to: NETLIST_INPUT }, { from: store.project.configPath, to: CONFIG_FILE }],
		};
	}

	/** A resumed run reuses checkpoints, so they must come from this netlist and these physical settings. */
	private checkResume(store: RunStore, synth: RunRecord, o: PnrOptions): void {
		if (!o.fromStage || o.fromStage === PNR_STAGES[0]) {
			return;
		}
		const previous = PNR_STAGES[PNR_STAGES.indexOf(o.fromStage) - 1];
		if (!o.fromRun || !fs.existsSync(path.join(store.runDir(o.fromRun.id), PNR_DIR, PNR_CHECKPOINT[previous]))) {
			throw new UserError(`Resuming at ${o.fromStage} needs a run that completed ${previous}.`);
		}
		const config = store.project.config;
		const settings = physicalDigest(config, effectiveFloorplan(config, o.scenario).scenario ?? '');
		if (o.fromRun.basedOn !== synth.id || o.fromRun.metrics?.physicalDigest !== settings) {
			throw new UserError(`Run ${o.fromRun.id} was made from a different netlist or different physical settings; run place and route from the floorplan instead.`);
		}
	}

	private pnrOptionsOf(store: RunStore, run: RunRecord): PnrOptions {
		const o = (run.metrics?.pnr ?? {}) as { stopAfter?: PnrStage; fromStage?: PnrStage; fromRun?: string; scenario?: string };
		return { stopAfter: o.stopAfter, fromStage: o.fromStage, fromRun: o.fromRun ? store.get(o.fromRun) : undefined, scenario: o.scenario };
	}

	/** Netlist -> GDSII with OpenROAD (stage scripts in <extension>/flow) and a KLayout DEF + cell GDS merge. */
	private async placeAndRoute(store: RunStore, ctx: RunContext, tools: Record<ToolName, ToolInfo>, token: vscode.CancellationToken, o: PnrOptions): Promise<ToolMessage[]> {
		const { config } = ctx.source;
		const platform = this.platform(config.physical!.platform);
		const fp = effectiveFloorplan(config, o.scenario);
		const from = o.fromStage ? PNR_STAGES.indexOf(o.fromStage) : 0;
		const to = o.stopAfter ? PNR_STAGES.indexOf(o.stopAfter) : PNR_STAGES.length - 1;
		if (from > to) {
			throw new UserError(`Cannot start at ${o.fromStage} and stop after ${o.stopAfter}.`);
		}
		const outDir = path.join(ctx.dir, PNR_DIR);
		const reportDir = path.join(outDir, 'reports');
		const imageDir = path.join(outDir, 'images');
		for (const d of [outDir, reportDir, imageDir]) {
			fs.mkdirSync(d, { recursive: true });
		}
		const settings = physicalDigest(config, fp.scenario ?? '');
		// Resuming: earlier stages' checkpoints, reports and images come from the previous run, which must
		// have been made from the same netlist and physical settings (else the result would mix two designs).
		if (from > 0) {
			if (!o.fromRun) {
				throw new UserError(`Resuming at ${o.fromStage} needs a previous run.`);
			}
			const prev = path.join(store.runDir(o.fromRun.id), PNR_DIR);
			for (const st of PNR_STAGES.slice(0, from)) {
				const checkpoint = path.join(prev, PNR_CHECKPOINT[st]);
				if (fs.existsSync(checkpoint)) {
					fs.copyFileSync(checkpoint, path.join(outDir, PNR_CHECKPOINT[st]));
				}
			}
			for (const sub of ['reports', 'images']) {
				for (const file of fs.existsSync(path.join(prev, sub)) ? fs.readdirSync(path.join(prev, sub)) : []) {
					const st = stageOfFile(file);
					if (st && PNR_STAGES.indexOf(st) < from) {
						fs.copyFileSync(path.join(prev, sub, file), path.join(outDir, sub, file));
					}
				}
			}
		}
		const threads = vscode.workspace.getConfiguration('siliconStudio').get<number>('physical.threads', 0) || Math.max(1, os.cpus().length);
		const p = config.physical!;
		const cfg: [string, unknown][] = [
			['platform_tcl', path.join(platform.dir, 'platform.tcl')],
			['design', config.top],
			['netlist', path.join(ctx.inputsDir, NETLIST_INPUT)],
			['sdc', expandEntries(ctx.inputsDir, config.constraints).files.map(f => path.join(ctx.inputsDir, f))],
			['out_dir', outDir],
			['report_dir', reportDir],
			['image_dir', imageDir],
			['threads', threads],
			['utilization', fp.utilization ?? platform.coreUtilization ?? 40],
			['aspect_ratio', fp.aspectRatio ?? 1],
			['core_margin', fp.coreMargin ?? 2],
			['die_area', fp.dieArea ?? ''],
			['core_area', fp.coreArea ?? ''],
			['place_density', fp.placeDensity ?? ''],
			['pin_constraints', (fp.pinConstraints ?? []).map(c => [c.side, c.pins])],
			['blockages', fp.blockages ?? []],
			['cts_buf', p.ctsBuffer ?? ''],
			['min_routing_layer', p.minRoutingLayer ?? ''],
			['max_routing_layer', p.maxRoutingLayer ?? ''],
			['drt_iterations', ''],
		];
		const configTcl = path.join(outDir, 'config.tcl');
		fs.writeFileSync(configTcl, `# Generated by Silicon Studio for run ${ctx.run.id}\n${cfg.map(([k, v]) => `set ::cfg(${k}) ${tcl(v)}`).join('\n')}\n`);
		ctx.run.metrics = {
			platform: platform.name,
			platformDigest: sha256File(path.join(platform.dir, 'platform.json')),
			physicalDigest: settings,
			scenario: fp.scenario,
			floorplan: fp,
			pnr: { stopAfter: o.stopAfter, fromStage: o.fromStage, fromRun: o.fromRun?.id, scenario: o.scenario },
			stages: {} as Record<string, unknown>,
		};
		const stages = ctx.run.metrics.stages as Record<string, unknown>;
		for (let i = 0; i < from; i++) {
			stages[PNR_STAGES[i]] = { status: 'reused', from: o.fromRun?.id, ...readJson(path.join(reportDir, `${PNR_STAGES[i]}.metrics.json`)) };
		}

		const messages: ToolMessage[] = [];
		const timeout = vscode.workspace.getConfiguration('siliconStudio').get<number>('physical.stageTimeoutSeconds', 3600) * 1000;
		const env = { SILICON_CONFIG: configTcl, QT_QPA_PLATFORM: 'offscreen' };
		for (const stage of PNR_STAGES.slice(from, to + 1)) {
			const r = await this.step(ctx, tools.openroad, ['-no_init', '-no_splash', '-threads', String(threads), '-exit', path.join(this.host.extensionPath, 'flow', `${stage}.tcl`)], ctx.dir, `pnr-${stage}.log`, token, timeout, env);
			const stageMessages = parseOpenroadLog(r.output);
			messages.push(...stageMessages);
			stages[stage] = { status: r.exitCode === 0 ? 'passed' : 'failed', ...readJson(path.join(reportDir, `${stage}.metrics.json`)) };
			if (r.timedOut || r.exitCode !== 0) {
				ctx.run.status = r.timedOut ? 'error' : 'failed';
				const first = stageMessages.find(m => m.severity === 'error')?.message ?? (r.timedOut ? `timed out after ${timeout / 1000}s` : `openroad exited with code ${r.exitCode}`);
				ctx.run.summary = `${stage} failed: ${first.split('\n')[0]}`;
				return messages;
			}
		}

		const finished = to === PNR_STAGES.length - 1;
		if (finished) {
			if (tools.klayout.mode === 'unavailable') {
				ctx.run.notes.push(`GDSII not written: ${tools.klayout.detail} (${INSTALL_HINT.klayout}).`);
			} else {
				const r = await this.step(ctx, tools.klayout, [path.join(this.host.extensionPath, 'flow', 'def2gds.py'), '--platform-tcl-json', path.join(platform.dir, 'platform.json'), '--def', path.join(outDir, '6_final.def'), '--out', path.join(outDir, '6_final.gds'), '--top', config.top], ctx.dir, 'gds-merge.log', token, timeout);
				if (r.exitCode !== 0) {
					messages.push({ tool: 'klayout', severity: 'error', message: `GDS merge failed: ${r.output.trim().split('\n').slice(-1)[0] ?? ''}` });
				}
				stages.gds = { status: r.exitCode === 0 && fs.existsSync(path.join(outDir, '6_final.gds')) ? 'passed' : 'failed' };
			}
		}

		const route = stages.route as { drc_violations?: number } | undefined;
		const fin = stages.finish as { setup_ws_ns?: number | null; fmax_mhz?: number; power_total_mw?: number; setup_violations?: number; hold_violations?: number } | undefined;
		const gridOk = (stages.pdn as { power_grid_ok?: number } | undefined)?.power_grid_ok;
		const fpm = stages.floorplan as { die_area_um2?: number; utilization_pct?: number } | undefined;
		const drc = route?.drc_violations;
		const gdsOk = (stages.gds as { status?: string } | undefined)?.status === 'passed';
		const parts = [
			finished ? (gdsOk ? 'GDSII written (6_final.gds)' : 'finished without GDSII') : `stopped after ${PNR_STAGES[to]}`,
			fp.scenario ? `scenario ${fp.scenario}` : undefined,
			fpm?.utilization_pct !== undefined && fpm.utilization_pct !== null ? `util ${Number(fpm.utilization_pct).toFixed(1)}%` : undefined,
			typeof drc === 'number' ? `${drc} DRC` : undefined,
			typeof fin?.setup_ws_ns === 'number' ? `setup slack ${fin.setup_ws_ns.toFixed(3)} ns` : finished && fin ? 'timing unconstrained' : undefined,
			typeof fin?.fmax_mhz === 'number' ? `fmax ${fin.fmax_mhz.toFixed(0)} MHz` : undefined,
			typeof fin?.power_total_mw === 'number' ? `${fin.power_total_mw.toFixed(3)} mW` : undefined,
		].filter(Boolean);
		const setupViolations = fin?.setup_violations ?? 0;
		const holdViolations = fin?.hold_violations ?? 0;
		if (typeof drc === 'number' && drc > 0) {
			ctx.run.status = 'failed';
			ctx.run.summary = `Routing left ${drc} DRC violation${drc === 1 ? '' : 's'}: ${parts.join(' · ')}`;
		} else if (finished && (setupViolations > 0 || holdViolations > 0)) {
			ctx.run.status = 'failed';
			ctx.run.summary = `Timing not met (${setupViolations} setup, ${holdViolations} hold violating endpoints): ${parts.join(' · ')}`;
		} else if (finished && fin && typeof fin.setup_ws_ns !== 'number') {
			ctx.run.status = 'inconclusive';
			ctx.run.summary = `${parts.join(' · ')} — no clock constrains the design (add create_clock to the SDC)`;
		} else if (gridOk === 0) {
			ctx.run.status = 'inconclusive';
			ctx.run.summary = `${parts.join(' · ')} — the power grid check reported problems (see reports/pdn_*.rpt)`;
		} else if (finished && !gdsOk) {
			ctx.run.status = 'inconclusive';
			ctx.run.summary = parts.join(' · ');
		} else {
			ctx.run.status = 'passed';
			ctx.run.summary = parts.join(' · ');
		}
		ctx.run.notes.push('A generated GDSII is not manufacturing-ready: no foundry signoff (DRC/LVS/antenna/density) was performed.');
		return messages;
	}

	/** Exports a stage checkpoint to outputs/pnr/layout_<stage>.json for the layout viewer (cached until the checkpoint changes). */
	async exportLayout(store: RunStore, run: RunRecord, stage: PnrStage, token: vscode.CancellationToken): Promise<string> {
		const tools = await this.host.tools.resolve();
		if (tools.openroad.mode === 'unavailable') {
			throw new UserError(`openroad is unavailable: ${INSTALL_HINT.openroad}.`);
		}
		const dir = path.join(store.runDir(run.id), PNR_DIR);
		const odb = path.join(dir, PNR_CHECKPOINT[stage]);
		if (!fs.existsSync(odb)) {
			throw new UserError(`Run ${run.id} has no ${stage} checkpoint.`);
		}
		const out = path.join(dir, `layout_${stage}.json`);
		if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(odb).mtimeMs) {
			return out;
		}
		const r = await exec(tools.openroad, ['-no_init', '-no_splash', '-exit', path.join(this.host.extensionPath, 'flow', 'export_layout.tcl')], {
			cwd: dir, timeoutMs: 10 * 60 * 1000, token, env: { SILICON_ODB: odb, SILICON_LAYOUT_OUT: out },
		});
		if (r.cancelled) {
			throw new Cancelled();
		}
		if (r.exitCode !== 0 || !fs.existsSync(out)) {
			const error = parseOpenroadLog(r.output).find(m => m.severity === 'error')?.message ?? r.output.trim().split('\n').slice(-1)[0];
			throw new Error(`Layout export failed: ${error}`);
		}
		return out;
	}

	/** Records whether a reproduction produced byte-identical outputs (logs and VCD dates excluded). */
	private compareWith(store: RunStore, ctx: RunContext, original: RunRecord): void {
		const differences: string[] = [];
		if (original.status !== ctx.run.status) {
			differences.push(`status: ${original.status} → ${ctx.run.status}`);
		}
		const compared = original.outputs.filter(o => o.path.startsWith('outputs/') && !NOT_COMPARED.test(o.path));
		for (const o of compared) {
			const a = path.join(store.runDir(original.id), o.path);
			const b = path.join(ctx.dir, o.path);
			if (!fs.existsSync(b)) {
				differences.push(`${o.path}: missing`);
			} else if (!fs.existsSync(a) || comparableDigest(a) !== comparableDigest(b)) {
				differences.push(`${o.path}: differs`);
			}
		}
		ctx.run.reproduction = { identical: differences.length === 0, compared: compared.length, differences };
		ctx.run.notes.push(differences.length
			? `Reproduction of ${original.id} differs: ${differences.join('; ')}`
			: `Reproduced ${original.id}: all ${compared.length} outputs identical.`);
	}
}
