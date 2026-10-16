/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — project model (silicon.json): loading, validation, file expansion, scaffolding.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Severity } from './diagnostics';

export const CONFIG_FILE = 'silicon.json';
export const STATE_DIR = '.silicon';
const HDL_FILE = /\.(v|sv)$/i;
const HEADER_FILE = /\.(vh|svh|vinc|inc)$/i;
const SKIP_DIRS = new Set([STATE_DIR, 'exports', 'node_modules', '.git']);

export type RunKind = 'lint' | 'sim' | 'synth' | 'equiv' | 'pnr';

/** Floorplan knobs (PRD 5.7). A scenario overrides any of them; areas are [x0, y0, x1, y1] in microns. */
export interface FloorplanSettings {
	utilization?: number;
	aspectRatio?: number;
	coreMargin?: number;
	dieArea?: number[];
	coreArea?: number[];
	placeDensity?: number;
	pinConstraints?: { side: 'left' | 'right' | 'top' | 'bottom'; pins: string[] }[];
	blockages?: number[][];
}

export interface PhysicalConfig extends FloorplanSettings {
	platform: string;
	scenarios?: (FloorplanSettings & { name: string })[];
	activeScenario?: string;
	minRoutingLayer?: string;
	maxRoutingLayer?: string;
	ctsBuffer?: string;
}

export interface ProjectConfig {
	id: string;
	name: string;
	top: string;
	sources: string[];
	includeDirs?: string[];
	defines?: Record<string, string | number | boolean>;
	parameters?: Record<string, string | number>;
	testbench?: { sources: string[]; top: string; timeoutSeconds?: number; plusargs?: string[] };
	lint?: { engine?: 'auto' | 'verilator' | 'iverilog' | 'yosys'; severity?: Record<string, Severity | 'off'> };
	synthesis?: { flatten?: boolean; abc?: boolean; liberty?: string; extraCommands?: string[] };
	equivalence?: { reset?: string; resetActiveLow?: boolean };
	physical?: PhysicalConfig;
	constraints?: string[];
	pdk?: { name: string; version?: string; source?: string };
}

export interface Issue {
	severity: 'error' | 'warning';
	message: string;
}

export class Project {
	constructor(readonly root: string, readonly config: ProjectConfig) { }

	get configPath(): string {
		return path.join(this.root, CONFIG_FILE);
	}

	get stateDir(): string {
		return path.join(this.root, STATE_DIR);
	}

	abs(rel: string): string {
		return path.resolve(this.root, rel);
	}
}

/** Reads silicon.json. A missing project id is generated and written back once (PRD 5.1: unique identifier). */
export function loadProject(root: string): Project {
	const file = path.join(root, CONFIG_FILE);
	const text = fs.readFileSync(file, 'utf8');
	let config: ProjectConfig;
	try {
		config = JSON.parse(text);
	} catch (e) {
		throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
	}
	if (!config || typeof config !== 'object') {
		throw new Error(`${CONFIG_FILE} must contain a JSON object`);
	}
	if (!config.id) {
		config.id = crypto.randomUUID();
		fs.writeFileSync(file, JSON.stringify(config, undefined, '\t') + '\n');
	}
	config.name ??= path.basename(root);
	config.sources ??= [];
	return new Project(root, config);
}

function globToRegExp(glob: string): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += glob[i + 2] === '/' ? 2 : 1;
		} else if (c === '*') {
			re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${re}$`);
}

function walk(root: string, dir: string, out: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) {
				walk(root, full, out);
			}
		} else if (entry.isFile()) {
			out.push(toPosix(path.relative(root, full)));
		}
	}
}

export function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

/**
 * Expands silicon.json file entries (files, directories or globs, relative to `root`) into a sorted,
 * de-duplicated list of root-relative POSIX paths. Directories contribute their .v/.sv files.
 * Entries that match nothing are returned in `missing`.
 */
export function expandEntries(root: string, entries: readonly string[] | undefined): { files: string[]; missing: string[] } {
	const files = new Set<string>();
	const missing: string[] = [];
	let all: string[] | undefined;
	for (const entry of entries ?? []) {
		const abs = path.resolve(root, entry);
		if (!isInside(root, abs) || (fs.existsSync(abs) && !isInside(fs.realpathSync(root), fs.realpathSync(abs)))) {
			missing.push(`${entry} (outside the project folder)`);
			continue;
		}
		if (/[*?]/.test(entry)) {
			if (!all) {
				all = [];
				walk(root, root, all);
			}
			const re = globToRegExp(toPosix(path.normalize(entry)));
			const matched = all.filter(f => re.test(f));
			matched.forEach(f => files.add(f));
			if (!matched.length) {
				missing.push(entry);
			}
		} else if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
			const inDir: string[] = [];
			walk(root, abs, inDir);
			inDir.filter(f => HDL_FILE.test(f)).forEach(f => files.add(f));
		} else if (fs.existsSync(abs)) {
			files.add(toPosix(path.relative(root, abs)));
		} else {
			missing.push(entry);
		}
	}
	return { files: [...files].sort(), missing };
}

export function isInside(root: string, abs: string): boolean {
	const rel = path.relative(root, abs);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** HDL sources passed to the compiler (headers are only reachable through `include). */
export function rtlSources(root: string, config: ProjectConfig): string[] {
	return expandEntries(root, config.sources).files.filter(f => !HEADER_FILE.test(f));
}

export function testbenchSources(root: string, config: ProjectConfig): string[] {
	return expandEntries(root, config.testbench?.sources).files.filter(f => !HEADER_FILE.test(f));
}

/** Include search path: configured include dirs plus every directory that holds a source file. */
export function includeDirs(config: ProjectConfig, sources: readonly string[]): string[] {
	const dirs = new Set<string>((config.includeDirs ?? []).map(d => toPosix(path.normalize(d))));
	for (const f of sources) {
		dirs.add(path.posix.dirname(f));
	}
	return [...dirs];
}

/** Every file a run of `kind` reads; these are copied into the run snapshot and hashed. */
export function inputFiles(root: string, config: ProjectConfig, kind: RunKind): string[] {
	const files = new Set<string>([CONFIG_FILE]);
	const rtl = rtlSources(root, config);
	rtl.forEach(f => files.add(f));
	const tb = kind === 'sim' ? testbenchSources(root, config) : [];
	tb.forEach(f => files.add(f));
	expandEntries(root, config.constraints).files.forEach(f => files.add(f));
	if (config.synthesis?.liberty && kind !== 'sim') {
		expandEntries(root, [config.synthesis.liberty]).files.forEach(f => files.add(f));
	}
	// Included files must exist inside the snapshot: everything under the configured include
	// directories (any HDL or header file, recursively) plus headers next to the sources.
	const configured = new Set((config.includeDirs ?? []).map(d => toPosix(path.normalize(d))));
	for (const dir of includeDirs(config, [...rtl, ...tb])) {
		const abs = path.resolve(root, dir);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory() || !isInside(fs.realpathSync(root), fs.realpathSync(abs))) {
			continue;
		}
		if (configured.has(dir)) {
			const inDir: string[] = [];
			walk(root, abs, inDir);
			inDir.filter(f => HDL_FILE.test(f) || HEADER_FILE.test(f)).forEach(f => files.add(f));
		} else {
			for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
				if (entry.isFile() && HEADER_FILE.test(entry.name)) {
					files.add(toPosix(path.join(dir, entry.name)));
				}
			}
		}
	}
	return [...files].sort();
}

/** Characters that could end or comment out a line of a generated Yosys script. */
const UNSAFE_PATH = /[\r\n"#;`]/;

/**
 * Yosys passes allowed in synthesis.extraCommands: optimization, mapping and reporting only. Anything that
 * can run programs or touch files (!, exec, shell, tcl, script, tee, write_*, abc -exe, select -write…) is refused.
 */
const SAFE_YOSYS_PASSES = new Set([
	'abc', 'abc9', 'alumacc', 'autoname', 'booth', 'check', 'clean', 'deminout', 'dfflegalize', 'extract_fa', 'flatten',
	'freduce', 'fsm', 'hilomap', 'insbuf', 'iopadmap', 'memory', 'memory_map', 'muxcover', 'muxpack', 'opt', 'opt_clean',
	'opt_dff', 'opt_expr', 'opt_lut', 'opt_merge', 'opt_reduce', 'opt_share', 'peepopt', 'pmuxtree', 'proc', 'rename',
	'select', 'setundef', 'share', 'splitnets', 'stat', 'tribuf', 'wreduce',
]);

export function unsafeYosysCommand(cmd: string): string | undefined {
	if (/[\r\n;#`]/.test(cmd)) {
		return 'must be a single command (no newlines, ";", "#" or backticks)';
	}
	const tokens = cmd.trim().split(/\s+/);
	if (!SAFE_YOSYS_PASSES.has(tokens[0])) {
		return `uses "${tokens[0]}", which is not an allowed optimization/mapping pass`;
	}
	// Yosys strips quotes from arguments, so check the unquoted form ("/etc/x" is an absolute path).
	const bad = tokens.map(t => t.replace(/['"]/g, '')).find(t => /^-(exe|script|write|o|file)$/.test(t) || t.startsWith('/') || t.startsWith('~') || t.includes('..') || t.startsWith('!'));
	return bad ? `uses "${bad}" (running programs or accessing files outside the project is not allowed)` : undefined;
}

/** Checks configuration before launching a job (PRD 5.6: report missing data before expensive jobs). */
export function validateProject(project: Project, kind: RunKind): Issue[] {
	const { root, config } = project;
	const issues: Issue[] = [];
	const error = (message: string) => issues.push({ severity: 'error', message });
	const warn = (message: string) => issues.push({ severity: 'warning', message });

	if (!config.top) {
		error('"top" is not set. Run "Silicon Studio: Select Top Module…" or set it in silicon.json.');
	}
	const sources = expandEntries(root, config.sources);
	sources.missing.forEach(m => error(`Source not found: ${m}`));
	if (!rtlSources(root, config).length) {
		error('No Verilog/SystemVerilog sources: add files or folders to "sources".');
	}
	for (const dir of config.includeDirs ?? []) {
		if (!fs.existsSync(path.resolve(root, dir))) {
			warn(`Include directory not found: ${dir}`);
		}
	}
	expandEntries(root, config.constraints).missing.forEach(m => warn(`Constraint file not found: ${m}`));
	if (kind === 'sim') {
		if (!config.testbench) {
			error('No "testbench" section: add { "sources": [...], "top": "<testbench module>" } to silicon.json.');
		} else {
			if (!config.testbench.top) {
				error('"testbench.top" is not set.');
			}
			const tb = expandEntries(root, config.testbench.sources);
			tb.missing.forEach(m => error(`Testbench source not found: ${m}`));
			if (!tb.files.length) {
				error('"testbench.sources" is empty.');
			}
		}
	}
	if (kind !== 'sim' && config.synthesis?.liberty) {
		const lib = expandEntries(root, [config.synthesis.liberty]);
		lib.missing.forEach(m => error(`Liberty library not found: ${m}`));
	}
	for (const [name, value] of Object.entries(config.parameters ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) || !/^[\w'".+-]+$/.test(String(value))) {
			error(`Invalid parameter override ${name}=${value}`);
		}
	}
	for (const [name, value] of Object.entries(config.defines ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\s;"#`]/.test(String(value))) {
			error(`Invalid define ${name}=${value}`);
		}
	}
	for (const f of inputFiles(root, config, kind)) {
		if (UNSAFE_PATH.test(f)) {
			error(`Unsupported characters in file name "${f.replace(/[\r\n]/g, '\\n')}" (newline, quote, #, ; or backtick).`);
		}
	}
	for (const cmd of config.synthesis?.extraCommands ?? []) {
		const problem = unsafeYosysCommand(cmd);
		if (problem) {
			error(`synthesis.extraCommands: "${cmd.replace(/[\r\n]/g, '\\n')}" ${problem}`);
		}
	}
	if (config.physical) {
		validatePhysical(config.physical, kind, config, root, error, warn);
	} else if (kind === 'pnr') {
		error('No "physical" section: add { "platform": "nangate45" } (or "sky130hd") to silicon.json to run place and route.');
	}
	if (config.equivalence?.reset && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(config.equivalence.reset)) {
		error(`Invalid equivalence.reset port name: ${config.equivalence.reset}`);
	}
	if (config.top && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(config.top)) {
		error(`Invalid top module name: ${config.top}`);
	}
	if (kind === 'sim' && config.testbench?.top && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(config.testbench.top)) {
		error(`Invalid testbench top module name: ${config.testbench.top}`);
	}
	return issues;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function isRect(r: unknown): r is number[] {
	return Array.isArray(r) && r.length === 4 && r.every(v => typeof v === 'number' && isFinite(v)) && r[2] > r[0] && r[3] > r[1];
}

function validateFloorplan(fp: FloorplanSettings, where: string, error: (m: string) => void): void {
	if (fp.utilization !== undefined && !(fp.utilization > 0 && fp.utilization <= 95)) {
		error(`${where}.utilization must be a percentage between 1 and 95`);
	}
	if (fp.aspectRatio !== undefined && !(fp.aspectRatio > 0 && fp.aspectRatio <= 20)) {
		error(`${where}.aspectRatio must be greater than 0 (height / width)`);
	}
	if (fp.coreMargin !== undefined && !(fp.coreMargin >= 0)) {
		error(`${where}.coreMargin must be >= 0 microns`);
	}
	if (fp.placeDensity !== undefined && !(fp.placeDensity > 0 && fp.placeDensity <= 1)) {
		error(`${where}.placeDensity must be between 0 and 1`);
	}
	if (fp.dieArea !== undefined && !isRect(fp.dieArea)) {
		error(`${where}.dieArea must be [x0, y0, x1, y1] in microns`);
	}
	if (fp.coreArea !== undefined) {
		if (!isRect(fp.coreArea)) {
			error(`${where}.coreArea must be [x0, y0, x1, y1] in microns`);
		} else if (!fp.dieArea) {
			error(`${where}.coreArea needs dieArea`);
		} else if (fp.coreArea[0] < fp.dieArea[0] || fp.coreArea[1] < fp.dieArea[1] || fp.coreArea[2] > fp.dieArea[2] || fp.coreArea[3] > fp.dieArea[3]) {
			error(`${where}.coreArea must lie inside dieArea`);
		}
	}
	for (const c of fp.pinConstraints ?? []) {
		if (!['left', 'right', 'top', 'bottom'].includes(c.side) || !Array.isArray(c.pins) || !c.pins.every(p => /^[A-Za-z_][A-Za-z0-9_$\[\]*]*$/.test(p))) {
			error(`${where}.pinConstraints entries need a side (left/right/top/bottom) and pin names`);
		}
	}
	for (const b of fp.blockages ?? []) {
		if (!isRect(b)) {
			error(`${where}.blockages entries must be [x0, y0, x1, y1] in microns`);
		}
	}
}

function validatePhysical(p: PhysicalConfig, kind: RunKind, config: ProjectConfig, root: string, error: (m: string) => void, warn: (m: string) => void): void {
	if (!p.platform || !IDENT.test(p.platform)) {
		error('physical.platform must name a platform (nangate45 or sky130hd)');
	}
	validateFloorplan(p, 'physical', error);
	const names = new Set<string>();
	for (const s of p.scenarios ?? []) {
		if (!s.name || !/^[\w.-]+$/.test(s.name)) {
			error('physical.scenarios entries need a name made of letters, digits, ".", "_" or "-"');
		} else if (names.has(s.name)) {
			error(`physical.scenarios has two scenarios named "${s.name}"`);
		}
		names.add(s.name);
		validateFloorplan(s, `physical.scenarios["${s.name}"]`, error);
	}
	if (p.activeScenario && !names.has(p.activeScenario)) {
		error(`physical.activeScenario "${p.activeScenario}" is not one of physical.scenarios`);
	}
	for (const layer of [p.minRoutingLayer, p.maxRoutingLayer, p.ctsBuffer]) {
		if (layer !== undefined && !IDENT.test(layer)) {
			error(`Invalid layer or cell name "${layer}" in physical`);
		}
	}
	if (kind === 'pnr' && !(config.constraints ?? []).length) {
		error('Place and route needs an SDC file with create_clock in "constraints".');
	}
	if (kind === 'pnr' && root && !expandEntries(root, config.constraints).files.some(f => /^[^#\n]*\bcreate_clock\b/m.test(fs.readFileSync(path.join(root, f), 'utf8')))) {
		warn('No create_clock in the SDC files: timing will be unconstrained and no clock tree is built.');
	}
	if (config.synthesis?.liberty && kind === 'synth') {
		warn('synthesis.liberty is ignored because physical.platform selects the cell library.');
	}
}

/** Lists module names declared in the project sources (comment-stripped regex scan). */
export function declaredModules(project: Project): string[] {
	const names = new Set<string>();
	for (const f of rtlSources(project.root, project.config)) {
		const text = fs.readFileSync(project.abs(f), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');
		for (const m of text.matchAll(/\bmodule\s+(?:automatic\s+|static\s+)?([A-Za-z_][A-Za-z0-9_$]*)/g)) {
			names.add(m[1]);
		}
	}
	return [...names].sort();
}

/** Copies the template project into `dir` and gives it a fresh id and the chosen name. */
export function scaffoldProject(templateDir: string, dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.cpSync(templateDir, dir, { recursive: true, errorOnExist: false, force: false });
	const file = path.join(dir, CONFIG_FILE);
	const config = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectConfig;
	config.id = crypto.randomUUID();
	config.name = name;
	fs.writeFileSync(file, JSON.stringify(config, undefined, '\t') + '\n');
}
