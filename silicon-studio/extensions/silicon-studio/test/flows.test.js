// Run from the extension root after compiling (npm run compile): node test/flows.test.js
// End-to-end check of the run lifecycle against the real tools (yosys, iverilog/vvp, verilator) with a stub 'vscode'.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- minimal 'vscode' stub: only what the flows and run store touch -----------------------------
class EventEmitter {
	constructor() { this.listeners = []; this.event = cb => { this.listeners.push(cb); return { dispose() { } }; }; }
	fire(v) { this.listeners.forEach(f => f(v)); }
	dispose() { }
}
const settings = {};
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

const ext = process.env.SILICON_EXT || path.join(__dirname, '..');
const { Flows, UserError, failureLine } = require(path.join(ext, 'out', 'flows'));
const { Tools, RunStore } = require(path.join(ext, 'out', 'engine'));
const { loadProject, expandEntries, unsafeYosysCommand } = require(path.join(ext, 'out', 'project'));
const { Staleness } = require(path.join(ext, 'out', 'views'));
const { exportBundle } = require(path.join(ext, 'out', 'bundle'));

const flows = new Flows({ extensionPath: ext, tools: new Tools(ext), output: { append() { }, appendLine() { } }, publish() { } });

function newProject(name, edit) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
	fs.cpSync(path.join(ext, 'templates', 'pwm'), dir, { recursive: true });
	edit?.(dir);
	return new RunStore(loadProject(dir), 'test');
}

function editConfig(dir, change) {
	const file = path.join(dir, 'silicon.json');
	const config = JSON.parse(fs.readFileSync(file, 'utf8'));
	change(config);
	fs.writeFileSync(file, JSON.stringify(config));
}

const run = (store, kind, opts) => flows.run(store, kind, token, opts);

(async () => {
	// 1. The whole template flow passes, and reproductions of synthesis and simulation are identical.
	const store = newProject('flow');
	const lint = await run(store, 'lint');
	const sim = await run(store, 'sim');
	const synth = await run(store, 'synth');
	const equiv = await run(store, 'equiv', { basedOn: synth });
	assert.deepStrictEqual([lint.status, sim.status, synth.status, equiv.status], ['passed', 'passed', 'passed', 'passed'], equiv.summary);
	assert.ok(synth.metrics.mapped.area > 0 && synth.metrics.generic.cells > 0);
	for (const original of [synth, sim]) {
		const again = await run(store, original.kind, { reproduce: original });
		assert.strictEqual(again.reproduction.identical, true, `${original.kind}: ${again.reproduction.differences}`);
	}

	// 2. Staleness: an edited source marks results stale; a newer synthesis supersedes the equivalence result.
	fs.appendFileSync(path.join(store.project.root, 'rtl', 'pwm.v'), '\n// edited\n');
	assert.strictEqual(new Staleness(store).isStale(lint), true);
	fs.writeFileSync(path.join(store.project.root, 'rtl', 'pwm.v'), fs.readFileSync(path.join(ext, 'templates', 'pwm', 'rtl', 'pwm.v')));
	assert.strictEqual(new Staleness(store).isStale(lint), false);
	await run(store, 'synth');
	assert.strictEqual(new Staleness(store).isStale(equiv), true);

	// 3. Export includes the netlist, the testbench and a checksum manifest.
	const bundle = await exportBundle(store, 'test');
	assert.ok(fs.statSync(bundle.file).size > 0);
	const listing = require('child_process').execFileSync('unzip', ['-Z1', bundle.file], { encoding: 'utf8' });
	for (const entry of ['netlist/netlist.v', 'source/tb/pwm_tb.v', 'source/rtl/pwm.v', 'manifest.json', 'README.md']) {
		assert.ok(listing.includes(entry), `bundle is missing ${entry}`);
	}

	// 4. A corrupted netlist is reported as NOT equivalent (bounded counterexample), not as inconclusive.
	const synthDir = store.runDir(synth.id);
	const netlist = path.join(synthDir, 'outputs', 'netlist.v');
	const good = fs.readFileSync(netlist, 'utf8');
	// Rewire the flip-flop that drives "out" to another flip-flop's D input (any cell library, any pin order).
	const statements = good.split(";");
	const outIndex = statements.findIndex(st => /\.Q\(out\)/.test(st) && /\.D\(/.test(st));
	const outD = /\.D\(([^)]+)\)/.exec(statements[outIndex])[1];
	const otherD = statements.map(st => /\.D\(([^)]+)\)/.exec(st)?.[1]).find(d => d && d !== outD);
	statements[outIndex] = statements[outIndex].replace(`.D(${outD})`, `.D(${otherD})`);
	fs.writeFileSync(netlist, statements.join(";"));
	const broken = await run(store, 'equiv', { basedOn: synth });
	assert.strictEqual(broken.status, 'failed', broken.summary);
	fs.writeFileSync(netlist, good);

	// 5. A testbench that reports "0 failed" passes.
	const zero = newProject('zero', dir => {
		const tb = path.join(dir, 'tb', 'pwm_tb.v');
		fs.writeFileSync(tb, fs.readFileSync(tb, 'utf8').replace('"PASS: all duty-cycle checks passed"', '"PASS: 4 checks, 0 failed"'));
	});
	assert.strictEqual((await run(zero, 'sim')).status, 'passed');

	// 6. synthesis.extraCommands cannot smuggle shell commands or write outside the run.
	for (const bad of ['opt_clean\n! touch /tmp/pwned', 'tee -o ../../x stat', 'opt; exec -- ls', 'abc -exe /bin/sh']) {
		const s = newProject('inject', dir => editConfig(dir, c => { c.synthesis.extraCommands = [bad]; }));
		await assert.rejects(run(s, 'synth'), UserError, bad);
	}
	assert.strictEqual((await run(newProject('safe', dir => editConfig(dir, c => { c.synthesis.extraCommands = ['opt -full', 'stat']; })), 'synth')).status, 'passed');

	// 7. `include files with a .v extension in includeDirs reach the snapshot.
	const inc = newProject('include', dir => {
		fs.mkdirSync(path.join(dir, 'include'));
		fs.writeFileSync(path.join(dir, 'include', 'pwm_defs.v'), '`define PWM_RESET_VALUE 1\'b0\n');
		const pwm = path.join(dir, 'rtl', 'pwm.v');
		fs.writeFileSync(pwm, '`include "pwm_defs.v"\n' + fs.readFileSync(pwm, 'utf8').replace("out <= 1'b0;", 'out <= `PWM_RESET_VALUE;'));
		editConfig(dir, c => { c.includeDirs = ['include']; });
	});
	assert.strictEqual((await run(inc, 'lint')).status, 'passed');
	assert.strictEqual((await run(inc, 'synth')).status, 'passed');

	// 8. Symlinks cannot pull files from outside the project into snapshots.
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-outside-'));
	fs.writeFileSync(path.join(outside, 'secret.key'), 'secret');
	const link = newProject('link', dir => fs.symlinkSync(outside, path.join(dir, 'vendor')));
	const expanded = expandEntries(link.project.root, ['vendor/secret.key']);
	assert.deepStrictEqual(expanded.files, []);
	assert.match(expanded.missing[0], /outside the project/);

	// 10. Simulation verdict wording and quoted paths in extraCommands.
	for (const line of ['FAIL: 0 != 1', 'vector 0 MISMATCH', 'TEST FAILED', 'ERROR: 2 failures']) {
		assert.ok(failureLine(`ok\n${line}\n`), line);
	}
	for (const line of ['PASS: 4 checks, 0 failed', '0 failures', 'failures: 0', 'mismatches = 0', 'errors: 0', 'PASS']) {
		assert.strictEqual(failureLine(line), undefined, line);
	}
	for (const cmd of ['abc -liberty "/etc/hosts"', "abc -liberty '/etc/hosts'", 'abc -liberty "/et"c/hosts']) {
		assert.ok(unsafeYosysCommand(cmd), cmd);
	}
	assert.strictEqual(unsafeYosysCommand('abc -liberty lib/silicon_demo.lib'), undefined);

	// 11. A correct design whose registers reset to a non-zero value is proven equivalent (not a false counterexample).
	const preset = newProject('preset', dir => {
		fs.writeFileSync(path.join(dir, 'rtl', 'counter.v'), `module counter #(parameter WIDTH = 8) (input wire clk, input wire rst, input wire en, output reg [WIDTH-1:0] count);
	always @(posedge clk or posedge rst)
		if (rst) count <= 9;
		else if (en) count <= count + 1'b1;
endmodule
`);
	});
	const presetSynth = await run(preset, 'synth');
	const presetEquiv = await run(preset, 'equiv', { basedOn: presetSynth });
	assert.notStrictEqual(presetEquiv.status, 'failed', presetEquiv.summary);

	// 12. A run left 'running' by a crash or reload is marked interrupted when the project loads.
	const crashed = JSON.parse(fs.readFileSync(path.join(store.runDir(lint.id), 'run.json'), 'utf8'));
	crashed.id = '20000101T000000-synth-dead';
	crashed.status = 'running';
	fs.mkdirSync(store.runDir(crashed.id));
	fs.writeFileSync(path.join(store.runDir(crashed.id), 'run.json'), JSON.stringify(crashed));
	store.markInterrupted();
	assert.strictEqual(store.get(crashed.id).status, 'error');

	// 9. Without native Yosys the bundled WebAssembly build synthesizes the same design (PRD: no native install needed).
	settings['yosys.engine'] = 'wasm';
	const wasmFlows = new Flows({ extensionPath: ext, tools: new Tools(ext), output: { append() { }, appendLine() { } }, publish() { } });
	const wasm = await wasmFlows.run(newProject('wasm'), 'synth', token);
	assert.strictEqual(wasm.status, 'passed', wasm.summary);
	assert.strictEqual(wasm.steps[0].mode, 'wasm');
	assert.ok(wasm.metrics.mapped.cells > 0);

	console.log('flows.test.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
