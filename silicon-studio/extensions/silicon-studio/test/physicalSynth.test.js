// Run from the extension root: node --experimental-strip-types test/physicalSynth.test.js   (yosys on PATH; OpenROAD from $OPENROAD, else <repo>/../.tools/bin/openroad, else PATH)
// Self-check for src/physicalSynth.ts and platforms/: platform.json and platform.tcl agree, and the generated Yosys
// script maps the pwm template onto every platform with a netlist OpenROAD links and times.
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ext = fs.realpathSync(path.join(__dirname, '..'));
const { listPlatforms, loadPlatform, physicalSynthScript } = require(path.join(ext, 'src', 'physicalSynth.ts'));
const bundled = path.resolve(ext, '../../../.tools/bin/openroad');
const openroad = process.env.OPENROAD || (fs.existsSync(bundled) ? bundled : 'openroad');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'physynth-'));

function run(cmd, args, cwd) {
	const r = cp.spawnSync(cmd, args, { cwd, encoding: 'utf8' });
	assert.strictEqual(r.status, 0, `${cmd} ${args.join(' ')} failed (cwd ${cwd}):\n${(r.stdout + r.stderr).slice(-3000)}`);
	return r.stdout;
}

// --- loadPlatform rejects what the flow could not use ---------------------------------------------------
assert.deepStrictEqual(listPlatforms(ext), ['nangate45', 'sky130hd']);
assert.throws(() => loadPlatform(ext, 'nope'), /Unknown platform "nope" \(available: nangate45, sky130hd\)/);
const broken = path.join(tmp, 'ext');
fs.mkdirSync(path.join(broken, 'platforms', 'bad'), { recursive: true });
fs.writeFileSync(path.join(broken, 'platforms', 'bad', 'platform.json'), JSON.stringify({ name: 'bad', techLef: 'missing.lef', placeDensity: '0.5' }));
assert.throws(() => loadPlatform(broken, 'bad'), e => /"techLef": missing file .*missing\.lef/.test(e.message) && /"placeDensity" must be a number/.test(e.message) && /"site" must be a non-empty string/.test(e.message));

const rtl = path.join(ext, 'templates', 'pwm', 'rtl');
const sdc = path.join(ext, 'templates', 'pwm', 'constraints', 'pwm.sdc');
for (const name of listPlatforms(ext)) {
	const p = loadPlatform(ext, name);

	// --- platform.tcl sets the same values as platform.json (paths resolved against the platform dir) -----------
	const snake = k => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
	const lists = Object.keys(p).filter(k => Array.isArray(p[k])).map(snake);
	const dump = path.join(tmp, `${name}-dump.tcl`);
	fs.writeFileSync(dump, [
		`source {${path.join(p.dir, 'platform.tcl')}}`,
		`set lists {${lists.join(' ')}}`,
		'foreach k [lsort [array names ::plat]] {',
		'\tforeach v [expr {$k in $lists ? $::plat($k) : [list $::plat($k)]}] { puts "PLAT\\t$k\\t$v" }',
		'\tif {$k in $lists && [llength $::plat($k)] == 0} { puts "PLAT\\t$k" }',
		'}',
	].join('\n'));
	const num = v => v !== '' && !isNaN(v) ? Number(v) : v; // Tcl "0.30" == JSON 0.3
	const tcl = {};
	for (const line of run(openroad, ['-no_init', '-no_splash', '-exit', dump], tmp).split('\n').filter(l => l.startsWith('PLAT\t'))) {
		const [, k, v] = line.split('\t');
		tcl[k] = v === undefined ? [] : [...(tcl[k] ?? []), num(v)];
	}
	const json = Object.fromEntries(Object.entries(p).map(([k, v]) => [snake(k), [v].flat().map(num)]));
	assert.deepStrictEqual(tcl, json, `${name}: platform.tcl and platform.json disagree`);

	// --- the generated script synthesizes pwm onto the platform cells -------------------------------------------
	const dir = path.join(tmp, `pwm-${name}`);
	fs.mkdirSync(path.join(dir, 'inputs', 'rtl'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'outputs'));
	const files = fs.readdirSync(rtl).filter(f => f.endsWith('.v')).sort();
	files.forEach(f => fs.copyFileSync(path.join(rtl, f), path.join(dir, 'inputs', 'rtl', f)));
	const script = physicalSynthScript({
		files: files.map(f => `inputs/rtl/${f}`), incs: ['inputs/rtl'], defines: [], params: { WIDTH: 8 },
		top: 'pwm', platform: p, flatten: true, clockPeriodPs: 10000, outDir: 'outputs',
	});
	fs.writeFileSync(path.join(dir, 'outputs', 'synth.ys'), script.join('\n') + '\n');
	run(process.env.YOSYS || 'yosys', ['-q', '-l', 'outputs/yosys.log', '-s', 'outputs/synth.ys'], dir);
	for (const f of ['netlist.v', 'netlist.json', 'rtl.json', 'rtl_stat.json', 'generic_stat.json', 'mapped_stat.json', 'stat.txt']) {
		assert.ok(fs.statSync(path.join(dir, 'outputs', f)).size > 0, `${name}: outputs/${f} missing`);
	}
	const mapped = JSON.parse(fs.readFileSync(path.join(dir, 'outputs', 'mapped_stat.json'), 'utf8')).design;
	const cellTypes = Object.keys(mapped.num_cells_by_type);
	assert.ok(mapped.area > 0 && cellTypes.length > 3, `${name}: no standard-cell area`);
	assert.ok(cellTypes.every(c => !c.startsWith('$') && !p.dontUse.some(d => new RegExp(`^${d.replaceAll('*', '.*')}$`).test(c))), `${name}: unmapped or dont-use cells: ${cellTypes}`);

	// --- OpenROAD reads, links and times the netlist ------------------------------------------------------------
	fs.writeFileSync(path.join(dir, 'sta.tcl'), [
		`source {${path.join(p.dir, 'platform.tcl')}}`,
		'read_lef $::plat(tech_lef)',
		'foreach f $::plat(sc_lef) { read_lef $f }',
		'foreach f $::plat(lib) { read_liberty $f }',
		'read_verilog outputs/netlist.v',
		'link_design pwm',
		`read_sdc {${sdc}}`,
		'report_checks -path_delay max',
	].join('\n'));
	const sta = run(openroad, ['-no_init', '-no_splash', '-exit', 'sta.tcl'], dir);
	assert.ok(!/\[ERROR|\[WARNING/.test(sta), `${name}: OpenROAD reported problems:\n${sta}`);
	assert.match(sta, /slack \(MET\)/, `${name}: pwm should meet its 10 ns clock`);
	console.log(`ok ${name}: ${mapped.num_cells} cells, area ${mapped.area.toFixed(1)} um^2, ${sta.match(/(-?[\d.]+)\s+slack/)[1]} ns slack`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('physicalSynth: all checks passed');
