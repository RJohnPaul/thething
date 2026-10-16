/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — execution engine: tool discovery (native vs WebAssembly), process execution
 *  with timeouts/cancellation, and the run store (input snapshots, manifests, provenance).
 *--------------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_FILE, Project, ProjectConfig, RunKind, toPosix } from './project';

export type ToolName = 'yosys' | 'iverilog' | 'vvp' | 'verilator' | 'openroad' | 'klayout';

export interface ToolInfo {
	name: ToolName;
	/** native = installed executable, wasm = bundled WebAssembly build running in a local Node worker. */
	mode: 'native' | 'wasm' | 'unavailable';
	command: string;
	prefixArgs: string[];
	version: string;
	detail: string;
}

const VERSION_ARGS: Record<Exclude<ToolName, 'klayout'>, string> = { yosys: '-V', iverilog: '-V', vvp: '-V', verilator: '--version', openroad: '-version' };
/** Per-user tool installs (see the "Set Up GDSII Export" command); bundled tools live in <extension>/tools. */
export const USER_TOOLS = path.join(os.homedir(), '.silicon-studio', 'tools');
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), 'oss-cad-suite', 'bin')];

function findExecutable(name: string, extraDirs: string[] = []): string | undefined {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
	if (name.includes('/') || name.includes('\\')) {
		return fs.existsSync(name) ? name : undefined;
	}
	const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs, ...EXTRA_PATHS];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				if (fs.statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// not here
			}
		}
	}
	return undefined;
}

function probeVersion(command: string, ...args: string[]): Promise<string | undefined> {
	return new Promise(resolve => {
		childProcess.execFile(command, args, { timeout: 15000 }, (err, stdout, stderr) => {
			const first = `${stdout}\n${stderr}`.split('\n').map(l => l.trim()).find(l => l.length > 0);
			// Any failure (missing binary, broken install, crash) means unavailable, so the WebAssembly fallback can apply.
			resolve(err ? undefined : first);
		});
	});
}

export class Tools {
	private cache: Promise<Record<ToolName, ToolInfo>> | undefined;

	constructor(private readonly extensionPath: string) { }

	invalidate(): void {
		this.cache = undefined;
	}

	resolve(): Promise<Record<ToolName, ToolInfo>> {
		this.cache ??= this.detect();
		return this.cache;
	}

	private async detect(): Promise<Record<ToolName, ToolInfo>> {
		const config = vscode.workspace.getConfiguration('siliconStudio');
		const names: Exclude<ToolName, 'klayout'>[] = ['yosys', 'iverilog', 'vvp', 'verilator', 'openroad'];
		const result = {} as Record<ToolName, ToolInfo>;
		// Tools bundled with the app live in <extension>/tools/bin (see scripts/silicon-studio.sh dmg).
		const bundled = [path.join(this.extensionPath, 'tools', 'bin'), path.join(USER_TOOLS, 'bin')];
		await Promise.all(names.map(async name => {
			const configured = config.get<string>(`tools.${name}Path`) || name;
			const exe = findExecutable(configured, bundled);
			const version = exe ? await probeVersion(exe, VERSION_ARGS[name]) : undefined;
			result[name] = exe && version
				? { name, mode: 'native', command: exe, prefixArgs: [], version, detail: exe }
				: { name, mode: 'unavailable', command: configured, prefixArgs: [], version: '', detail: `${configured} not found on PATH` };
		}));

		result.klayout = await this.klayoutPython(config.get<string>('tools.klayoutPython') || '');

		const engine = config.get<'auto' | 'native' | 'wasm'>('yosys.engine', 'auto');
		const wasm = this.wasmYosys();
		if (wasm && (engine === 'wasm' || (engine === 'auto' && result.yosys.mode !== 'native'))) {
			result.yosys = wasm;
		} else if (engine === 'native' && result.yosys.mode !== 'native') {
			result.yosys.detail += ' (siliconStudio.yosys.engine is "native")';
		}
		return result;
	}

	/** KLayout's layout engine as a Python module (used for the DEF + cell GDS merge); the desktop app is not needed. */
	private async klayoutPython(configured: string): Promise<ToolInfo> {
		const candidates = [configured, path.join(this.extensionPath, 'tools', 'pyenv', 'bin', 'python3'), path.join(USER_TOOLS, 'pyenv', 'bin', 'python3'), 'python3', '/opt/homebrew/bin/python3', '/usr/bin/python3']
			.filter(Boolean)
			.map(c => findExecutable(c))
			.filter((c): c is string => !!c);
		for (const python of [...new Set(candidates)]) {
			const version = await probeVersion(python, '-c', 'import klayout.db as db; print("KLayout DB " + db.__version__)');
			if (version?.startsWith('KLayout DB')) {
				return { name: 'klayout', mode: 'native', command: python, prefixArgs: [], version, detail: python };
			}
		}
		return { name: 'klayout', mode: 'unavailable', command: configured || 'python3', prefixArgs: [], version: '', detail: 'no Python with the klayout module (pip install klayout)' };
	}

	private wasmYosys(): ToolInfo | undefined {
		const pkg = path.join(this.extensionPath, 'node_modules', '@yowasp', 'yosys', 'package.json');
		const runner = path.join(this.extensionPath, 'resources', 'yowasp-runner.mjs');
		if (!fs.existsSync(pkg) || !fs.existsSync(runner)) {
			return undefined;
		}
		const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version as string;
		return {
			name: 'yosys',
			mode: 'wasm',
			command: process.execPath,
			prefixArgs: [runner],
			version: `Yosys ${version.split('.').slice(0, 2).join('.')} (YoWASP WebAssembly ${version})`,
			detail: 'Bundled WebAssembly build, runs locally without a native installation',
		};
	}
}

export interface ExecResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
	durationMs: number;
	spawnError?: string;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Runs a tool without a shell (arguments are never interpreted), with timeout and cancellation. */
export function exec(tool: ToolInfo, args: string[], opts: { cwd: string; timeoutMs: number; token?: vscode.CancellationToken; onData?: (text: string) => void; env?: Record<string, string> }): Promise<ExecResult> {
	const started = Date.now();
	return new Promise(resolve => {
		const env = { ...process.env, ...opts.env };
		if (tool.mode === 'wasm') {
			env.ELECTRON_RUN_AS_NODE = '1';
		}
		let output = '';
		let timedOut = false;
		let cancelled = false;
		let child: childProcess.ChildProcess;
		try {
			child = childProcess.spawn(tool.command, [...tool.prefixArgs, ...args], { cwd: opts.cwd, env, windowsHide: true });
		} catch (e) {
			resolve({ exitCode: null, output: '', timedOut, cancelled, durationMs: 0, spawnError: e.message });
			return;
		}
		const kill = () => {
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 2000).unref();
		};
		const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
		const sub = opts.token?.onCancellationRequested(() => { cancelled = true; kill(); });
		const onData = (buf: Buffer) => {
			const text = buf.toString('utf8').replace(ANSI, '');
			output += text;
			opts.onData?.(text);
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		let spawnError: string | undefined;
		child.on('error', err => { spawnError = err.message; });
		child.on('close', code => {
			clearTimeout(timer);
			sub?.dispose();
			resolve({ exitCode: code, output, timedOut, cancelled, durationMs: Date.now() - started, spawnError });
		});
	});
}

// ---------------------------------------------------------------------------------------------
// Runs

export type RunStatus = 'running' | 'passed' | 'failed' | 'inconclusive' | 'error' | 'cancelled';

export interface FileEntry {
	path: string;
	sha256: string;
	bytes: number;
}

export interface RunStep {
	tool: ToolName;
	mode: ToolInfo['mode'];
	version: string;
	args: string[];
	cwd: string;
	exitCode: number | null;
	durationMs: number;
	timedOut: boolean;
	log: string;
}

export interface RunRecord {
	schema: 1;
	id: string;
	kind: RunKind;
	status: RunStatus;
	/** One-line engineering result, distinct from tool exit status (PRD 13: process exit != validation). */
	summary: string;
	project: { id: string; name: string; top: string };
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	inputDigest: string;
	configDigest: string;
	inputs: FileEntry[];
	outputs: FileEntry[];
	steps: RunStep[];
	executionTarget: string;
	environment: { platform: string; arch: string; node: string; app: string; appVersion: string; extensionVersion: string; remote: string };
	diagnostics: { errors: number; warnings: number };
	metrics?: Record<string, unknown>;
	notes: string[];
	basedOn?: string;
	reproducedFrom?: string;
	reproduction?: { identical: boolean; compared: number; differences: string[] };
}

/** Where a run's inputs come from: the live project, or a previous run's snapshot (reproduction). */
export interface RunSource {
	root: string;
	config: ProjectConfig;
	files: string[];
	extra?: { from: string; to: string }[];
}

export interface RunContext {
	run: RunRecord;
	dir: string;
	inputsDir: string;
	outputsDir: string;
	logsDir: string;
	source: RunSource;
}

export function sha256File(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export function configDigest(config: ProjectConfig): string {
	return valueDigest(config);
}

/** SHA-256 of a JSON-like value with sorted keys (stable across key order). */
export function valueDigest(value: unknown): string {
	return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

export function digestEntries(entries: readonly FileEntry[]): string {
	const h = crypto.createHash('sha256');
	for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
		h.update(`${e.path}\0${e.sha256}\n`);
	}
	return h.digest('hex');
}

export function hashFiles(root: string, files: readonly string[]): FileEntry[] {
	return files.map(f => {
		const abs = path.join(root, f);
		return { path: f, sha256: sha256File(abs), bytes: fs.statSync(abs).size };
	});
}

function listFiles(dir: string, base = dir): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		const full = path.join(dir, e.name);
		return e.isDirectory() ? listFiles(full, base) : e.isFile() ? [toPosix(path.relative(base, full))] : [];
	});
}

function newRunId(kind: RunKind): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
	return `${stamp}-${kind}-${crypto.randomBytes(2).toString('hex')}`;
}

export class RunStore implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(readonly project: Project, private readonly extensionVersion: string) { }

	dispose(): void {
		this.changed.dispose();
	}

	get runsDir(): string {
		return path.join(this.project.stateDir, 'runs');
	}

	runDir(id: string): string {
		return path.join(this.runsDir, id);
	}

	list(): RunRecord[] {
		if (!fs.existsSync(this.runsDir)) {
			return [];
		}
		const runs: RunRecord[] = [];
		for (const id of fs.readdirSync(this.runsDir)) {
			try {
				runs.push(JSON.parse(fs.readFileSync(path.join(this.runsDir, id, 'run.json'), 'utf8')));
			} catch {
				// incomplete or foreign directory
			}
		}
		return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
	}

	/** Runs still marked 'running' when no job can be active were interrupted (reload, crash). */
	markInterrupted(): void {
		for (const run of this.list().filter(r => r.status === 'running')) {
			run.status = 'error';
			run.summary = 'Interrupted: Silicon Studio stopped before this run finished';
			fs.writeFileSync(path.join(this.runDir(run.id), 'run.json'), JSON.stringify(run, undefined, '\t') + '\n');
		}
	}

	get(id: string): RunRecord | undefined {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.runDir(id), 'run.json'), 'utf8'));
		} catch {
			return undefined;
		}
	}

	latest(kind: RunKind, predicate: (r: RunRecord) => boolean = () => true): RunRecord | undefined {
		return this.list().find(r => r.kind === kind && r.status !== 'running' && predicate(r));
	}

	/** Snapshot of the project's current inputs for `kind` (used for stale detection). */
	currentDigest(files: readonly string[]): string {
		return digestEntries(hashFiles(this.project.root, files));
	}

	/** Creates the run directory and copies every input into an immutable snapshot (PRD 5.2, 13). */
	create(kind: RunKind, source: RunSource, opts: { scratch?: boolean; basedOn?: string; reproducedFrom?: string; executionTarget: string }): RunContext {
		const id = opts.scratch ? `scratch-${kind}` : newRunId(kind);
		const dir = opts.scratch ? path.join(this.project.stateDir, 'scratch', kind) : this.runDir(id);
		fs.rmSync(dir, { recursive: true, force: true });
		const inputsDir = path.join(dir, 'inputs');
		const outputsDir = path.join(dir, 'outputs');
		const logsDir = path.join(dir, 'logs');
		for (const d of [inputsDir, outputsDir, logsDir]) {
			fs.mkdirSync(d, { recursive: true });
		}
		for (const f of source.files) {
			const to = path.join(inputsDir, f);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(path.join(source.root, f), to);
		}
		const inputs = hashFiles(inputsDir, source.files);
		for (const x of source.extra ?? []) {
			const to = path.join(inputsDir, x.to);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(x.from, to);
		}
		const extraEntries = hashFiles(inputsDir, (source.extra ?? []).map(x => x.to));
		const { config } = source;
		const run: RunRecord = {
			schema: 1,
			id,
			kind,
			status: 'running',
			summary: 'Running…',
			project: { id: this.project.config.id, name: this.project.config.name, top: config.top },
			startedAt: new Date().toISOString(),
			inputDigest: digestEntries(inputs),
			configDigest: configDigest(config),
			inputs: [...inputs, ...extraEntries],
			outputs: [],
			steps: [],
			executionTarget: opts.executionTarget,
			environment: {
				platform: process.platform,
				arch: process.arch,
				node: process.version,
				app: vscode.env.appName,
				appVersion: vscode.version,
				extensionVersion: this.extensionVersion,
				remote: vscode.env.remoteName ?? 'local',
			},
			diagnostics: { errors: 0, warnings: 0 },
			notes: [],
			basedOn: opts.basedOn,
			reproducedFrom: opts.reproducedFrom,
		};
		const ctx: RunContext = { run, dir, inputsDir, outputsDir, logsDir, source };
		this.save(ctx);
		return ctx;
	}

	save(ctx: RunContext): void {
		fs.writeFileSync(path.join(ctx.dir, 'run.json'), JSON.stringify(ctx.run, undefined, '\t') + '\n');
		this.changed.fire();
	}

	finish(ctx: RunContext): void {
		const { run } = ctx;
		run.finishedAt = new Date().toISOString();
		run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
		run.outputs = [
			...hashFiles(ctx.outputsDir, listFiles(ctx.outputsDir)).map(e => ({ ...e, path: `outputs/${e.path}` })),
			...hashFiles(ctx.logsDir, listFiles(ctx.logsDir)).map(e => ({ ...e, path: `logs/${e.path}` })),
		];
		this.save(ctx);
	}

	/** Recreates the input source of a finished run from its snapshot. */
	sourceOf(run: RunRecord): RunSource {
		const root = path.join(this.runDir(run.id), 'inputs');
		const config = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')) as ProjectConfig;
		const files = run.inputs.map(i => i.path).filter(p => !p.startsWith('.silicon-'));
		const extra = run.inputs.filter(i => i.path.startsWith('.silicon-')).map(i => ({ from: path.join(root, i.path), to: i.path }));
		return { root, config, files, extra };
	}

	fire(): void {
		this.changed.fire();
	}
}

/** Content hash used to compare outputs across runs; VCD $date headers are ignored. */
export function comparableDigest(file: string): string {
	let data = fs.readFileSync(file);
	// Strip what legitimately changes between identical runs: dump dates, SPEF dates, stage runtimes.
	if (file.endsWith('.vcd')) {
		data = Buffer.from(data.toString('utf8').replace(/\$date[\s\S]*?\$end/, '$date $end'));
	} else if (file.endsWith('.spef')) {
		data = Buffer.from(data.toString('utf8').replace(/^\*DATE .*$/m, '*DATE'));
	} else if (file.endsWith('.metrics.json')) {
		data = Buffer.from(data.toString('utf8').replace(/"runtime_s":\s*[^,\n}]*/, '"runtime_s": 0'));
	}
	return crypto.createHash('sha256').update(data).digest('hex');
}
