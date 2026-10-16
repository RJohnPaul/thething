// Run from the extension root after compiling (npm run compile): node test/pnr.test.js   [PLATFORM=sky130hd]
// End-to-end netlist -> GDSII through the real Flows code with OpenROAD and KLayout (skips if openroad is missing).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

class EventEmitter {
	constructor() { this.listeners = []; this.event = cb => { this.listeners.push(cb); return { dispose() { } }; }; }
	fire(v) { this.listeners.forEach(f => f(v)); }
	dispose() { }
}
const toolsDir = path.join(__dirname, '..', '..', '..', '..', '.tools');
const settings = {
	'tools.openroadPath': process.env.OPENROAD ?? path.join(toolsDir, 'bin', 'openroad'),
	'tools.klayoutPython': process.env.KLAYOUT_PYTHON ?? path.join(toolsDir, 'pyenv', 'bin', 'python'),
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) };
const vscodeStub = {
	EventEmitter,
	workspace: { getConfiguration: () => ({ get: (k, d) => k in settings ? settings[k] : d }) },
	env: { appName: 'test', remoteName: undefined },
	version: '0.0.0',
	TreeItem: class { }, TreeItemCollapsibleState: {}, ThemeIcon: class { }, ThemeColor: class { }, MarkdownString: class { },
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === 'vscode' ? 'vscode-stub' : resolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

const ext = path.join(__dirname, '..');
const { Flows, PNR_DIR, UserError } = require(path.join(ext, 'out', 'flows'));
const { Staleness, stageHeadline } = require(path.join(ext, 'out', 'views'));
const { Tools, RunStore } = require(path.join(ext, 'out', 'engine'));
const { loadProject } = require(path.join(ext, 'out', 'project'));

const log = process.env.VERBOSE ? (t => process.stdout.write(t)) : () => { };
const flows = new Flows({ extensionPath: ext, tools: new Tools(ext), output: { append: log, appendLine: t => log(t + '\n') }, publish() { } });
const run = (store, kind, opts) => flows.run(store, kind, token, opts);
const pnrFile = (store, r, f) => path.join(store.runDir(r.id), PNR_DIR, f);

(async () => {
	if (!fs.existsSync(settings['tools.openroadPath'])) {
		console.log('pnr.test.js: skipped (openroad not found; set OPENROAD=/path/to/openroad)');
		return;
	}
	// A space in the project path (common on macOS) must survive every OpenROAD writer.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss pnr-'));
	fs.cpSync(path.join(ext, 'templates', 'pwm'), dir, { recursive: true });
	const platform = process.env.PLATFORM ?? 'nangate45';
	if (platform !== 'nangate45') {
		const c = JSON.parse(fs.readFileSync(path.join(dir, 'silicon.json'), 'utf8'));
		c.physical.platform = platform;
		fs.writeFileSync(path.join(dir, 'silicon.json'), JSON.stringify(c));
	}
	const store = new RunStore(loadProject(dir), 'test');
	const t0 = Date.now();

	// Synthesis maps to the platform library; equivalence holds against the platform cells.
	const synth = await run(store, 'synth');
	assert.strictEqual(synth.status, 'passed', synth.summary);
	assert.strictEqual(synth.metrics.platform, platform);
	const equiv = await run(store, 'equiv', { basedOn: synth });
	assert.strictEqual(equiv.status, 'passed', equiv.summary);

	// Full flow: every stage, a clean route, timing/power numbers and a GDSII with the placed cells.
	const full = await run(store, 'pnr', { basedOn: synth, pnr: {} });
	assert.strictEqual(full.status, 'passed', full.summary);
	const st = full.metrics.stages;
	for (const stage of ['floorplan', 'pdn', 'place', 'cts', 'route', 'finish', 'gds']) {
		assert.strictEqual(st[stage]?.status, 'passed', `${stage}: ${JSON.stringify(st[stage])}`);
	}
	assert.strictEqual(st.route.drc_violations, 0);
	assert.ok(st.finish.power_total_mw > 0 && typeof st.finish.setup_ws_ns === 'number');
	for (const f of ['6_final.gds', '6_final.def', '6_final.v', '6_final.spef', 'images/floorplan.png', 'images/route.png']) {
		assert.ok(fs.existsSync(pnrFile(store, full, f)), `missing ${f}`);
	}
	const layout = JSON.parse(fs.readFileSync(await flows.exportLayout(store, full, 'route', token), 'utf8'));
	assert.ok(layout && typeof layout === 'object');

	// Resume: only routing and signoff run again, from the full run's CTS checkpoint.
	const resumed = await run(store, 'pnr', { basedOn: synth, pnr: { fromStage: 'route', fromRun: full } });
	assert.strictEqual(resumed.status, 'passed', resumed.summary);
	assert.strictEqual(resumed.metrics.stages.cts.status, 'reused');
	assert.strictEqual(resumed.steps.filter(s => s.tool === 'openroad').length, 2);
	for (const f of ['2_floorplan.odb', '3_pdn.odb', '4_place.odb', '5_cts.odb']) {
		assert.ok(fs.existsSync(pnrFile(store, resumed, f)), `resumed run lacks reused checkpoint ${f}`);
	}
	const atFinish = await run(store, 'pnr', { basedOn: synth, pnr: { fromStage: 'finish', fromRun: full } });
	assert.ok(fs.existsSync(pnrFile(store, atFinish, 'reports/6_route_drc.rpt')), 'resume at finish lost the DRC report');
	assert.match(stageHeadline('pdn', st.pdn), /grid connected/);

	// Reproducing the full flow gives identical outputs (GDS without timestamps, SPEF dates ignored).
	const again = await run(store, 'pnr', { basedOn: synth, reproduce: full });
	assert.strictEqual(again.reproduction.identical, true, JSON.stringify(again.reproduction));

	// Floorplan scenarios: higher utilization -> smaller die; a fixed die is honoured exactly.
	const dense = await run(store, 'pnr', { basedOn: synth, pnr: { scenario: 'util55-square', stopAfter: 'place' } });
	assert.strictEqual(dense.status, 'passed', dense.summary);
	assert.ok(dense.metrics.stages.floorplan.die_area_um2 < st.floorplan.die_area_um2, 'util55 die should be smaller than util30');
	const config = JSON.parse(fs.readFileSync(path.join(dir, 'silicon.json'), 'utf8'));
	config.physical.scenarios.push({ name: 'fixed-die', dieArea: [0, 0, 40, 40], coreArea: [4, 4, 36, 36] });
	fs.writeFileSync(path.join(dir, 'silicon.json'), JSON.stringify(config));
	const fixedStore = new RunStore(loadProject(dir), 'test');
	const fixed = await run(fixedStore, 'pnr', { basedOn: synth, pnr: { scenario: 'fixed-die', stopAfter: 'floorplan' } });
	assert.strictEqual(fixed.status, 'passed', fixed.summary);
	assert.ok(Math.abs(fixed.metrics.stages.floorplan.die_width_um - 40) < 0.01, `die width ${fixed.metrics.stages.floorplan.die_width_um}`);

	// A floorplan edit keeps the netlist current, makes earlier place-and-route stale, and blocks resuming from it.
	const staleness = () => new Staleness(fixedStore);
	assert.strictEqual(staleness().isStale(synth), false, 'floorplan edits must not make synthesis stale');
	const edited = JSON.parse(fs.readFileSync(path.join(dir, 'silicon.json'), 'utf8'));
	edited.physical.utilization = 45;
	fs.writeFileSync(path.join(dir, 'silicon.json'), JSON.stringify(edited));
	const editedStore = new RunStore(loadProject(dir), 'test');
	assert.strictEqual(new Staleness(editedStore).isStale(synth), false);
	assert.strictEqual(new Staleness(editedStore).isStale(full), true);
	await assert.rejects(run(editedStore, 'pnr', { basedOn: synth, pnr: { fromStage: 'route', fromRun: full } }), UserError);

	// Every SDC file reaches OpenROAD (the clock lives in the second file), and an unclocked design is not "passed".
	const sdcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-pnr-sdc-'));
	fs.cpSync(path.join(ext, 'templates', 'pwm'), sdcDir, { recursive: true });
	fs.writeFileSync(path.join(sdcDir, 'constraints', 'load.sdc'), 'set_load 0.005 [all_outputs]\n');
	const sdcConfig = JSON.parse(fs.readFileSync(path.join(sdcDir, 'silicon.json'), 'utf8'));
	sdcConfig.constraints = ['constraints/load.sdc', 'constraints/pwm.sdc'];
	fs.writeFileSync(path.join(sdcDir, 'silicon.json'), JSON.stringify(sdcConfig));
	const twoSdc = new RunStore(loadProject(sdcDir), 'test');
	const twoSynth = await run(twoSdc, 'synth');
	const twoCts = await run(twoSdc, 'pnr', { basedOn: twoSynth, pnr: { stopAfter: 'cts' } });
	assert.ok(twoCts.metrics.stages.cts.clock_sinks > 0, 'the clock from the second SDC file was lost');
	sdcConfig.constraints = ['constraints/load.sdc'];
	fs.writeFileSync(path.join(sdcDir, 'silicon.json'), JSON.stringify(sdcConfig));
	const unclockedStore = new RunStore(loadProject(sdcDir), 'test');
	const unclockedSynth = await run(unclockedStore, 'synth');
	const unclocked = await run(unclockedStore, 'pnr', { basedOn: unclockedSynth, pnr: {} });
	assert.strictEqual(unclocked.status, 'inconclusive', unclocked.summary);

	// Equivalence on the constructs that used to give false verdicts: an FSM (one-hot re-encoding), an x don't-care,
	// a negedge flop, an async-reset latch and the platform clock gate are proven; a flop moved to another clock is not.
	const eqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-pnr-eq-'));
	fs.cpSync(path.join(ext, 'templates', 'pwm'), eqDir, { recursive: true });
	fs.rmSync(path.join(eqDir, 'rtl'), { recursive: true });
	fs.mkdirSync(path.join(eqDir, 'rtl'));
	fs.writeFileSync(path.join(eqDir, 'rtl', 'eqx.v'), `module eqx(input clk, input clk2, input rst, input rst_n, input en, input [1:0] sel,
	input [3:0] d, output reg [3:0] q, output reg [3:0] n, output reg [3:0] l, output reg [3:0] g, output busy);
  reg [1:0] state;
  always @(posedge clk) if (rst) state <= 0; else case (state) 0: if (en) state <= 1; 1: if (d[0]) state <= 2; default: state <= 0; endcase
  assign busy = state != 0;
  always @(posedge clk) case (sel) 0: q <= d; 1: q <= ~d; 2: q <= {d[1:0], d[3:2]}; default: q <= 4'bx; endcase
  always @(negedge clk) n <= d ^ q;
  always @* if (!rst_n) l = 4'b0101; else if (en) l = d;
  wire gclk;
  OPENROAD_CLKGATE icg (.CK(clk2), .E(en), .GCK(gclk));
  always @(posedge gclk) g <= l;
endmodule
`);
	const eqConfig = JSON.parse(fs.readFileSync(path.join(eqDir, 'silicon.json'), 'utf8'));
	Object.assign(eqConfig, { top: 'eqx', parameters: {} });
	delete eqConfig.testbench;
	fs.writeFileSync(path.join(eqDir, 'silicon.json'), JSON.stringify(eqConfig));
	const eqStore = new RunStore(loadProject(eqDir), 'test');
	const eqSynth = await run(eqStore, 'synth');
	assert.strictEqual(eqSynth.status, 'passed', eqSynth.summary);
	const eqGood = await run(eqStore, 'equiv', { basedOn: eqSynth });
	assert.strictEqual(eqGood.status, 'passed', eqGood.summary);
	const eqNetlist = path.join(eqStore.runDir(eqSynth.id), 'outputs', 'netlist.v');
	const rightClock = fs.readFileSync(eqNetlist, 'utf8');
	const wrongClock = rightClock.replace(/\.(CK|CLK)\(clk\),(\n\s+\.D\([^)]*\),\n\s+\.Q\(q\[0\]\))/, '.$1(clk2),$2');
	assert.notStrictEqual(wrongClock, rightClock, 'no q[0] flop found to move to clk2');
	fs.writeFileSync(eqNetlist, wrongClock);
	const eqBad = await run(eqStore, 'equiv', { basedOn: eqSynth });
	assert.deepStrictEqual([eqBad.status, /clocked differently/.test(eqBad.summary)], ['failed', true], eqBad.summary);

	console.log(`pnr.test.js: all checks passed (${((Date.now() - t0) / 1000).toFixed(0)} s) — ${full.summary}`);
})().catch(e => { console.error(e); process.exit(1); });
