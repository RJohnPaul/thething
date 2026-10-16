/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — PDK platforms (platforms/<name>/platform.json) and the Yosys script that maps RTL
 *  onto a platform's standard cells for the OpenROAD physical flow.
 *  The script follows OpenROAD-flow-scripts flow/scripts/synth*.tcl (commit 9c43140, BSD-3-Clause).
 *  No 'vscode' import: usable from tests and other tools.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/** platform.json with every path made absolute; '' marks an optional file the platform does not have. */
export interface PlatformInfo {
	name: string;
	dir: string;
	techLef: string;
	scLef: string[];
	lib: string[];
	gds: string[];
	site: string;
	tracksTcl: string;
	tapcellTcl: string;
	pdnTcl: string;
	setrcTcl: string;
	rcxRules: string;
	klayoutLyt: string;
	klayoutLyp: string;
	drcDeck: string;
	lvsDeck: string;
	cdl: string;
	minRoutingLayer: string;
	maxRoutingLayer: string;
	ioHorLayer: string;
	ioVerLayer: string;
	ctsBuf: string;
	fillCells: string[];
	tieHiCell: string;
	tieHiPort: string;
	tieLoCell: string;
	tieLoPort: string;
	minBufCell: string;
	minBufIn: string;
	minBufOut: string;
	dontUse: string[];
	placeDensity: number;
	coreUtilization: number;
	powerNet: string;
	groundNet: string;
	latchMap: string;
	clkgateMap: string;
	adderMap: string;
	abcDriverCell: string;
	abcLoadInFf: number;
	routingLayerAdjustment: number;
	corner: string;
}

type Kind = 'file' | 'optionalFile' | 'files' | 'string' | 'strings' | 'number';
const FIELDS: Record<Exclude<keyof PlatformInfo, 'dir'>, Kind> = {
	name: 'string', techLef: 'file', scLef: 'files', lib: 'files', gds: 'files', site: 'string',
	tracksTcl: 'file', tapcellTcl: 'file', pdnTcl: 'file', setrcTcl: 'file', rcxRules: 'file',
	klayoutLyt: 'file', klayoutLyp: 'file', drcDeck: 'optionalFile', lvsDeck: 'optionalFile', cdl: 'optionalFile',
	minRoutingLayer: 'string', maxRoutingLayer: 'string', ioHorLayer: 'string', ioVerLayer: 'string',
	ctsBuf: 'string', fillCells: 'strings', tieHiCell: 'string', tieHiPort: 'string', tieLoCell: 'string',
	tieLoPort: 'string', minBufCell: 'string', minBufIn: 'string', minBufOut: 'string', dontUse: 'strings',
	placeDensity: 'number', coreUtilization: 'number', powerNet: 'string', groundNet: 'string',
	latchMap: 'optionalFile', clkgateMap: 'optionalFile', adderMap: 'optionalFile',
	abcDriverCell: 'string', abcLoadInFf: 'number', routingLayerAdjustment: 'number', corner: 'string',
};
const EXPECTED: Record<Kind, string> = {
	file: 'a relative file path', optionalFile: 'a relative file path or ""', files: 'a non-empty list of relative file paths',
	string: 'a non-empty string', strings: 'a list of strings', number: 'a number',
};

function valid(kind: Kind, v: unknown): boolean {
	switch (kind) {
		case 'number': return typeof v === 'number' && Number.isFinite(v);
		case 'files': return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s !== '');
		case 'strings': return Array.isArray(v) && v.every(s => typeof s === 'string' && s !== '');
		case 'optionalFile': return typeof v === 'string';
		default: return typeof v === 'string' && v !== '';
	}
}

/** Names of the platforms bundled with the extension (directories under platforms/ that hold a platform.json). */
export function listPlatforms(extensionPath: string): string[] {
	const root = path.join(extensionPath, 'platforms');
	if (!fs.existsSync(root)) {
		return [];
	}
	return fs.readdirSync(root).filter(n => fs.existsSync(path.join(root, n, 'platform.json'))).sort();
}

/** Reads and checks platforms/<name>/platform.json; throws an Error naming every problem found. */
export function loadPlatform(extensionPath: string, name: string): PlatformInfo {
	const available = listPlatforms(extensionPath);
	if (!available.includes(name)) {
		throw new Error(`Unknown platform "${name}" (available: ${available.join(', ') || 'none'}).`);
	}
	const dir = path.join(extensionPath, 'platforms', name);
	const file = path.join(dir, 'platform.json');
	let raw: Record<string, unknown> | null;
	try {
		raw = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`Platform "${name}": cannot read ${file}: ${e.message}`);
	}
	const info: Record<string, unknown> = { dir };
	const problems: string[] = [];
	for (const [key, kind] of Object.entries(FIELDS) as [keyof typeof FIELDS, Kind][]) {
		const v = raw?.[key];
		if (!valid(kind, v)) {
			problems.push(`"${key}" must be ${EXPECTED[kind]}`);
			continue;
		}
		if (kind === 'file' || kind === 'optionalFile' || kind === 'files') {
			const abs = ([] as string[]).concat(v as string | string[]).filter(p => p !== '').map(p => path.resolve(dir, p));
			problems.push(...abs.filter(p => !fs.existsSync(p)).map(p => `"${key}": missing file ${p}`));
			info[key] = kind === 'files' ? abs : abs[0] ?? '';
		} else {
			info[key] = v;
		}
	}
	if (raw?.name !== undefined && raw.name !== name) {
		problems.push(`"name" is "${raw.name}" but the directory is "${name}"`);
	}
	if (problems.length) {
		throw new Error(`Platform "${name}" is invalid (${file}):\n  ${problems.join('\n  ')}`);
	}
	return info as unknown as PlatformInfo;
}

function quote(arg: string): string {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Module names a Yosys techmap file defines (ORFS get_module_names), e.g. $_DLATCH_P_. */
function mapModules(file: string): string[] {
	return [...fs.readFileSync(file, 'utf8').matchAll(/^[ \t]*module[ \t]+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/gm)].map(m => m.groups!.name);
}

/**
 * Yosys script (one command per line, run with cwd = the run directory) that maps the RTL onto the platform's
 * standard cells, like ORFS synth: generic synthesis, adder/latch/flip-flop mapping, ABC with the platform's
 * driver/load constraints (and the clock period as delay target), tie cells, buffered feed-throughs.
 * Outputs use the names of the generic synthesis flow: netlist.v, netlist.json, rtl.json, rtl_stat.json,
 * generic_stat.json (before mapping), mapped_stat.json and stat.txt (with -liberty).
 */
export function physicalSynthScript(o: {
	files: string[]; incs: string[]; defines: string[]; params: Record<string, string | number>;
	top: string; platform: PlatformInfo; flatten: boolean; clockPeriodPs?: number; outDir: string;
	/** Directory relative platform paths are resolved against when the map files are read (the run directory). */
	cwd?: string;
}): string[] {
	const p = o.platform;
	const out = (file: string) => quote(`${o.outDir}/${file}`);
	const libs = p.lib.map(l => `-liberty ${quote(l)}`).join(' ');
	const dontUse = p.dontUse.map(c => ` -dont_use ${quote(c)}`).join('');
	const delay = o.clockPeriodPs ? ` -D ${Math.round(o.clockPeriodPs)}` : '';
	const read = ['read_verilog', '-sv', ...o.defines.map(d => `-D${d.replace(/^-D/, '')}`), ...o.incs.map(d => `-I${d}`), ...o.files];
	return [
		`# Physical synthesis onto ${p.name} (${p.corner}) generated by Silicon Studio,`,
		'# adapted from OpenROAD-flow-scripts flow/scripts/synth.tcl (BSD-3-Clause).',
		`read_liberty -lib ${p.lib.map(quote).join(' ')}`,
		read.map(quote).join(' '),
		// Defines OPENROAD_CLKGATE for RTL that instantiates the platform clock gate
		...(p.clkgateMap ? [`read_verilog ${quote(p.clkgateMap)}`] : []),
		...Object.entries(o.params).map(([k, v]) => `chparam -set ${k} ${v} ${o.top}`),
		`hierarchy -check -top ${o.top}`,
		'proc',
		'opt_clean',
		`write_json ${out('rtl.json')}`,
		`tee -q -o ${out('rtl_stat.json')} stat -json`,
		// ponytail: yosys's own adder/LCU techmap; ORFS adds -extra-map lcu_kogge_stone.v for faster adders
		// -nofsm: FSM re-encoding (e.g. to one-hot) keeps the state register's name, so equivalence would
		// pair binary RTL bits with one-hot netlist bits that only agree on reachable states.
		`synth -top ${o.top}${o.flatten ? ' -flatten' : ''} -noabc -nofsm`,
		'chformal -remove',
		'delete t:$print',
		'opt -purge',
		`tee -q -o ${out('generic_stat.json')} stat -json`,
		...(p.adderMap ? ['extract_fa', `techmap -map ${quote(p.adderMap)}`, 'techmap', 'opt -fast -purge'] : []),
		...(p.latchMap ? [
			`dfflegalize ${mapModules(path.resolve(o.cwd ?? '.', p.latchMap)).map(m => `-cell ${m} x`).join(' ')} t:$_DLATCH_*`,
			`techmap -map ${quote(p.latchMap)}`,
		] : []),
		`dfflibmap ${libs}${dontUse}`,
		'opt',
		'setundef -zero',
		`write_file ${out('abc.constr')} <<EOT`,
		`set_driving_cell ${p.abcDriverCell}`,
		`set_load ${p.abcLoadInFf}`,
		'EOT',
		// ponytail: yosys's built-in liberty ABC script (honours -D); ORFS's abc_speed.script maps harder
		`abc ${libs}${dontUse} -constr ${out('abc.constr')}${delay}`,
		'splitnets',
		'opt_clean -purge',
		`hilomap -singleton -hicell ${p.tieHiCell} ${p.tieHiPort} -locell ${p.tieLoCell} ${p.tieLoPort}`,
		`insbuf -buf ${p.minBufCell} ${p.minBufIn} ${p.minBufOut}`,
		'check',
		`tee -q -o ${out('mapped_stat.json')} stat -json ${libs}`,
		`tee -q -o ${out('stat.txt')} stat ${libs}`,
		// OpenROAD can only link standard cells: fail here rather than at floorplan
		'check -assert -mapped',
		`write_verilog -noattr -noexpr -nohex -nodec ${out('netlist.v')}`,
		`write_json ${out('netlist.json')}`,
	];
}
