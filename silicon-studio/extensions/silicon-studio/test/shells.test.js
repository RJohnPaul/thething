// Run from the extension root: node test/shells.test.js   (yosys on PATH or $YOSYS; OpenROAD from $OPENROAD, else
// <repo>/../.tools/bin/openroad, else PATH; KLayout Python from $KLAYOUT_PYTHON, else <repo>/../.tools/pyenv/bin/python)
// The Synopsys-style shells run the pwm template end to end on nangate45, launched as the extension launches them:
// dc_shell (synthesis) -> icc2_shell (floorplan .. route, DEF/Verilog/SPEF/GDS) -> pt_shell (STA with the SPEF).
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ext = fs.realpathSync(path.join(__dirname, '..'));
const tools = path.resolve(ext, '../../../.tools');
const pick = (env, bundled, fallback) => process.env[env] || (fs.existsSync(bundled) ? bundled : fallback);
const yosys = process.env.YOSYS || 'yosys';
const openroad = pick('OPENROAD', path.join(tools, 'bin', 'openroad'), 'openroad');
const python = pick('KLAYOUT_PYTHON', path.join(tools, 'pyenv', 'bin', 'python'), '');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shells-'));
const shell = name => path.join(ext, 'shells', `${name}_shell.tcl`);
const env = {
	...process.env,
	SILICON_PLATFORM_TCL: path.join(ext, 'platforms', 'nangate45', 'platform.tcl'),
	SILICON_OPENROAD: openroad,
	SILICON_PYTHON: python,
	SILICON_FLOW_DIR: path.join(ext, 'flow'),
	SILICON_INTERACTIVE: '',
};

// Run a shell on a script (batch) or on stdin lines (interactive); returns {status, out}.
function run(kind, lines, { interactive = false } = {}) {
	const script = path.join(tmp, `${kind}.tcl`);
	fs.writeFileSync(script, lines.join('\n') + '\n');
	const [cmd, args] = kind === 'dc' ? [yosys, ['-q', '-c', shell('dc')]] : [openroad, ['-no_init', '-no_splash', shell(kind)]];
	const r = cp.spawnSync(cmd, args, {
		cwd: tmp, encoding: 'utf8', timeout: 90_000, input: interactive ? lines.join('\n') + '\n' : '',
		env: { ...env, SILICON_SCRIPT: interactive ? '' : script, SILICON_INTERACTIVE: interactive ? '1' : '' },
	});
	return { status: r.status, out: r.stdout + r.stderr };
}

function expect(kind, result, patterns) {
	assert.strictEqual(result.status, 0, `${kind} failed:\n${result.out.slice(-3000)}`);
	for (const p of patterns) {
		assert.match(result.out, p, `${kind}: no ${p} in output:\n${result.out.slice(-3000)}`);
	}
}

const rtl = path.join(ext, 'templates', 'pwm', 'rtl');

// --- dc_shell: analyze/elaborate, constraints, compile_ultra, reports, netlist + SDC -------------------------
expect('dc', run('dc', [
	`set_app_var search_path {. ${rtl}}`,
	'analyze -format verilog {pwm.v counter.v comparator.v}',
	'elaborate pwm -parameters "WIDTH=8"',
	'create_clock -name clk -period 10 [get_ports clk]',
	'set_input_delay 2.0 -clock clk [remove_from_collection [all_inputs] [get_ports clk]]',
	'set_output_delay 2.0 -clock clk [all_outputs]',
	'compile_ultra',
	'report_area',
	'report_timing -delay_type max -max_paths 1',
	'report_constraint -all_violators',
	'report_power',
	'write -format verilog -hierarchy -output pwm_dc.v',
	'write_sdc pwm_dc.sdc',
]), [/Elaborated design 'pwm'/, /Number of sequential cells:\s+9\b/, /Total cell area:\s+\d+\.\d+/, /slack \(MET\)/,
	/No constraint violations\./, /^Total\s+[\d.e+-]+/m, /Wrote constraints to 'pwm_dc.sdc'/]);
assert.match(fs.readFileSync(path.join(tmp, 'pwm_dc.v'), 'utf8'), /DFF_X1/);
assert.match(fs.readFileSync(path.join(tmp, 'pwm_dc.sdc'), 'utf8'), /set_input_delay 2\.0 -clock \[get_clocks clk\]/);

// Batch errors stop the run with exit code 1; at the prompt they are printed and the session goes on.
const failed = run('dc', ['compile_ultra']);
assert.deepStrictEqual([failed.status, /Error: no design loaded.*\(dc\.tcl line 1\)/.test(failed.out)], [1, true], failed.out);
expect('dc interactive', run('dc', ['not_a_command', 'if {1} {', '  puts multi-line', '}', 'exit'], { interactive: true }),
	[/dc_shell> Error: invalid command name "not_a_command"/, /multi-line/]);

// --- icc2_shell: the DC netlist through floorplan, power grid, placement, CTS and routing -------------------
const icc2 = run('icc2', [
	'create_lib pwm.nlib',
	'read_verilog -top pwm pwm_dc.v',
	'link_block',
	'read_sdc pwm_dc.sdc',
	'initialize_floorplan -core_utilization 0.3 -side_ratio {1 1} -core_offset 2',
	'place_pins -self',
	'compile_pg',
	'place_opt',
	'clock_opt',
	'route_auto',
	'route_opt',
	'check_routes',
	'create_stdcell_fillers',
	'report_qor',
	'write_def pwm.def',
	'write_verilog pwm_routed.v',
	'write_parasitics -output pwm.spef',
	'save_block',
	...python ? ['write_gds pwm.gds'] : [],
]);
expect('icc2', icc2, [/compile_pg finished: \d+ power\/ground shapes/, /place_opt finished/, /clock_opt finished/,
	/route_auto finished: 0 DRC violations/, /All nets routed:\s+yes/, /Setup \(max delay\)\s+\d+\.\d+/, /saved block 'pwm'/]);
for (const file of ['pwm.def', 'pwm_routed.v', 'pwm.spef', 'pwm.nlib/pwm.odb', ...python ? ['pwm.gds'] : []]) {
	assert.ok(fs.statSync(path.join(tmp, file)).size > 0, file);
}
assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'pwm_routed.v'), 'utf8'), /FILLCELL|TAPCELL/);

// --- pt_shell: the routed netlist with its SPEF; then the saved block with estimated parasitics -------------
expect('pt', run('pt', [
	'read_verilog pwm_routed.v',
	'link_design pwm',
	'read_sdc pwm_dc.sdc',
	'set_propagated_clock [all_clocks]',
	'read_parasitics -format spef pwm.spef',
	'update_timing',
	'report_timing -delay_type max -max_paths 2',
	'report_timing -delay_type min',
	'report_global_timing',
	'report_constraint -all_violators',
	'report_clock',
	'report_power',
]), [/annotated parasitics from 'pwm.spef'/, /Path Type: max/, /Path Type: min/, /clock network delay \(propagated\)/,
	/slack \(MET\)/, /Hold \(min delay\)\s+\d+\.\d+/, /No constraint violations\./, /^clk\s+10\.00/m, /^Total\s+[\d.e+-]+/m]);
expect('pt interactive', run('pt', ['read_db pwm.nlib/pwm.odb', 'read_sdc pwm.nlib/pwm.sdc', 'report_global_timing', 'quit'], { interactive: true }),
	[/pt_shell> /, /read design 'pwm' from pwm.odb/, /using estimates from the placement/, /Setup \(max delay\)\s+\d+\.\d+/]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('shells: ok');
