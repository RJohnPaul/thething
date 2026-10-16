// Run from the extension root: node --test test/layoutExport.test.js   (OpenROAD from $OPENROAD, else <repo>/../.tools/bin/openroad, else PATH)
// Self-check for flow/export_layout.tcl: a small counter is placed and routed on nangate45 with the real stage scripts,
// the floorplan and routed checkpoints are exported, and the JSON is checked against the format media/layout.js reads.
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ext = fs.realpathSync(path.join(__dirname, '..'));
const bundled = path.resolve(ext, '../../../.tools/bin/openroad');
const openroad = process.env.OPENROAD || (fs.existsSync(bundled) ? bundled : 'openroad');
const hasOpenroad = cp.spawnSync(openroad, ['-version'], { encoding: 'utf8' }).status === 0;

// Escaped identifiers exercise the JSON string escaping (OpenDB names them q_reg\[0\], with backslashes).
const NETLIST = `module counter (clk, en, q);
  input clk;
  input en;
  output [2:0] q;
  wire c0, c1, d0, d1, d2;
  XOR2_X1 x0 (.A(q[0]), .B(en), .Z(d0));
  AND2_X1 a0 (.A1(q[0]), .A2(en), .ZN(c0));
  XOR2_X1 x1 (.A(q[1]), .B(c0), .Z(d1));
  AND2_X1 a1 (.A1(q[1]), .A2(c0), .ZN(c1));
  XOR2_X1 x2 (.A(q[2]), .B(c1), .Z(d2));
  DFF_X1 \\q_reg[0]  (.D(d0), .CK(clk), .Q(q[0]));
  DFF_X1 \\q_reg[1]  (.D(d1), .CK(clk), .Q(q[1]));
  DFF_X1 \\q_reg[2]  (.D(d2), .CK(clk), .Q(q[2]));
endmodule
`;

function run(args, env, cwd) {
	const r = cp.spawnSync(openroad, ['-no_init', '-no_splash', '-exit', ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
	assert.strictEqual(r.status, 0, `openroad ${args.join(' ')} failed:\n${(r.stdout + r.stderr).slice(-3000)}`);
	return r.stdout;
}

// Every invariant the viewer relies on, as one comparable object.
function summarize(d) {
	const flat = (a, n) => Array.isArray(a) && a.length % n === 0 && a.every(Number.isInteger);
	const records = (a, n) => Array.from({ length: a.length / n }, (_, k) => a.slice(k * n, k * n + n));
	const inDie = r => r[0] < r[2] && r[1] < r[3] && r[0] >= d.die[0] && r[1] >= d.die[1] && r[2] <= d.die[2] && r[3] <= d.die[3];
	const nNets = d.nets.names.length, nLayers = d.layers.length, nInsts = d.insts.names.length;
	const viaOk = v => v[1] < d.viaDefs.length && v[0] >= 0 && v[0] < nNets;
	const shapeOk = s => s[0] >= 0 && s[0] < nNets && s[1] >= 0 && s[1] < nLayers && inDie(s.slice(2));
	const wires = records(d.wires, 6), swires = records(d.swires, 6);
	return {
		header: [d.version, d.design, d.dbu, d.die.length, d.core === null || d.core.length === 4],
		layers: d.layers.slice(0, 3).map(l => `${l.name}:${l.type}:${l.dir}:${l.level}`),
		flatArrays: [flat(d.rows, 4), flat(d.insts.data, 7), flat(d.pins.data, 6), flat(d.wires, 6), flat(d.vias, 4), flat(d.swires, 6), flat(d.svias, 4), flat(d.blockages, 4), flat(d.obstructions, 5)],
		tables: [d.insts.data.length === nInsts * 7, d.nets.start.length === nNets + 1, d.pins.dirs.length === d.pins.names.length, d.pins.nets.length === d.pins.names.length,
			d.viaDefs.every(v => typeof v.name === 'string' && flat(v.rects, 5) && records(v.rects, 5).every(r => r[0] < nLayers))],
		insts: records(d.insts.data, 7).every(i => i[0] < d.masters.length && i[1] < d.kinds.length && inDie(i.slice(3))),
		stdCells: d.insts.names.filter((_, i) => d.kinds[d.insts.data[i * 7 + 1]] !== 'tap' && d.kinds[d.insts.data[i * 7 + 1]] !== 'fill').sort(),
		connectivity: d.nets.start.every((s, i) => i === 0 || s >= d.nets.start[i - 1]) && d.nets.insts.every(i => i >= 0 && i < nInsts),
		pins: d.pins.names.slice().sort(),
		pinNets: d.pins.names.map((n, i) => d.pins.nets[i] >= 0 && d.nets.names[d.pins.nets[i]] === n).every(Boolean),
		pinShapes: records(d.pins.data, 6).every(p => p[0] < d.pins.names.length && p[1] < nLayers && inDie(p.slice(2))),
		signalShapes: wires.every(shapeOk) && records(d.vias, 4).every(viaOk),
		routedLayers: [...new Set(wires.map(w => d.layers[w[1]].name))].length >= 2,
		routedNets: d.nets.names.filter((_, n) => wires.some(w => w[0] === n)).filter(n => /^(q\[\d\]|en|clk)$/.test(n)).sort(),
		powerNets: [...new Set(swires.map(s => d.nets.names[s[0]]))].sort(),
		powerShapes: swires.every(shapeOk) && records(d.svias, 4).every(viaOk),
		unplaced: d.unplaced,
	};
}

test('export_layout.tcl writes the layout viewer JSON for floorplan and routed checkpoints', { skip: hasOpenroad ? false : `openroad not found (${openroad}); set OPENROAD to run this test` }, () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-export-'));
	fs.writeFileSync(path.join(tmp, 'counter.v'), NETLIST);
	fs.writeFileSync(path.join(tmp, 'counter.sdc'), 'create_clock -name clk -period 2.0 [get_ports clk]\nset_input_delay 0.2 -clock clk [get_ports en]\nset_output_delay 0.2 -clock clk [get_ports q*]\n');
	fs.writeFileSync(path.join(tmp, 'config.tcl'), [
		`set ::cfg(platform_tcl) {${path.join(ext, 'platforms', 'nangate45', 'platform.tcl')}}`,
		'set ::cfg(design) counter',
		`set ::cfg(netlist) {${path.join(tmp, 'counter.v')}}`,
		`set ::cfg(sdc) {${path.join(tmp, 'counter.sdc')}}`,
		...['out_dir', 'report_dir', 'image_dir'].map(k => `set ::cfg(${k}) {${path.join(tmp, 'results')}}`),
		'set ::cfg(die_area) {0 0 30 30}',
	].join('\n'));
	for (const stage of ['floorplan', 'pdn', 'place', 'cts', 'route']) {
		run([path.join(ext, 'flow', `${stage}.tcl`)], { SILICON_CONFIG: path.join(tmp, 'config.tcl') }, tmp);
	}
	const exportLayout = checkpoint => {
		const out = path.join(tmp, `${checkpoint}.json`);
		run([path.join(ext, 'flow', 'export_layout.tcl')], { SILICON_ODB: path.join(tmp, 'results', `${checkpoint}.odb`), SILICON_LAYOUT_OUT: out }, tmp);
		return JSON.parse(fs.readFileSync(out, 'utf8'));
	};

	const layers = ['metal1:routing:H:1', 'via1:cut::0', 'metal2:routing:V:2'];
	const flatArrays = Array(9).fill(true);
	const tables = Array(5).fill(true);
	const cells = ['q_reg\\[0\\]', 'q_reg\\[1\\]', 'q_reg\\[2\\]', 'a0', 'a1', 'x0', 'x1', 'x2'];
	const floorplan = summarize(exportLayout('2_floorplan'));
	assert.deepStrictEqual(floorplan, {
		header: [1, 'counter', 2000, 4, true], layers, flatArrays, tables, insts: true, stdCells: [], connectivity: true,
		pins: ['clk', 'en', 'q[0]', 'q[1]', 'q[2]'], pinNets: true, pinShapes: true, signalShapes: true, routedLayers: false, routedNets: [],
		powerNets: [], powerShapes: true, unplaced: { insts: 8, pins: 0 },
	});
	const routed = summarize(exportLayout('6_route'));
	assert.deepStrictEqual({ ...routed, stdCells: routed.stdCells.filter(n => cells.includes(n)) }, {
		header: [1, 'counter', 2000, 4, true], layers, flatArrays, tables, insts: true, stdCells: cells.slice().sort(), connectivity: true,
		pins: ['VDD', 'VSS', 'clk', 'en', 'q[0]', 'q[1]', 'q[2]'], pinNets: true, pinShapes: true, signalShapes: true, routedLayers: true,
		routedNets: ['clk', 'en', 'q[0]', 'q[1]', 'q[2]'], powerNets: ['VDD', 'VSS'], powerShapes: true, unplaced: { insts: 0, pins: 0 },
	});
	fs.rmSync(tmp, { recursive: true, force: true });
});

test('media/layout.js parses', () => {
	const r = cp.spawnSync(process.execPath, ['--check', path.join(ext, 'media', 'layout.js')], { encoding: 'utf8' });
	assert.strictEqual(r.status, 0, r.stderr);
});
