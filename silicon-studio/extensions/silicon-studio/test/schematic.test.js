// Run from the extension root after compiling (npm run compile): node test/schematic.test.js
// Self-check for src/schematic.ts: needs yosys on PATH; netlistsvg resolves from this extension's node_modules.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderSchematicSvg } = require(process.env.SCHEMATIC_JS || path.join(__dirname, '../out/schematic.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-test-'));
fs.writeFileSync(path.join(dir, 'counter.v'), `
module counter #(parameter WIDTH = 8) (input clk, input rst, input en, output reg [WIDTH-1:0] q);
  always @(posedge clk)
    if (rst) q <= {WIDTH{1'b0}};
    else if (en) q <= q + 1'b1;
endmodule`);
fs.writeFileSync(path.join(dir, 'hier.v'), `
module inc #(parameter W = 8) (input [W-1:0] a, output [W-1:0] y);
  assign y = a + 1'b1;
endmodule
module dff_en #(parameter W = 8) (input clk, input rst, input en, input [W-1:0] d, output reg [W-1:0] q);
  always @(posedge clk) if (rst) q <= 0; else if (en) q <= d;
endmodule
module top (input clk, input rst, input en, output [7:0] q);
  wire [7:0] nxt;
  inc    #(.W(8)) u_inc (.a(q), .y(nxt));
  dff_en #(.W(8)) u_reg (.clk(clk), .rst(rst), .en(en), .d(nxt), .q(q));
endmodule`);
const yosys = (file, script) => {
	execFileSync('yosys', ['-q', '-p', `read_verilog ${file}; ${script}; write_json out.json`], { cwd: dir });
	return JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
};
const gate = yosys('counter.v', 'synth -top counter; abc; opt_clean');
const rtl = yosys('counter.v', 'hierarchy -top counter; proc; opt');
const hier = yosys('hier.v', 'hierarchy -top top; proc; opt');

const hasCells = (svg, names) => names.forEach(n => assert(svg.includes(`id="cell_${n}"`), `missing cell ${n}`));
const themed = svg => {
	assert.match(svg, /^<svg[^>]*\sviewBox="0 0 [\d.]+ [\d.]+"/);
	assert(!/#000|black/.test(svg), 'hard-coded black left in SVG');
};

(async () => {
	// (b) coarse RTL: $add + $sdffe, ports typed, nets named
	const r = await renderSchematicSvg(rtl);
	themed(r.svg);
	assert.strictEqual(r.module, 'counter');
	assert.strictEqual(r.cellCount, 2);
	hasCells(r.svg, [...Object.keys(rtl.modules.counter.cells), 'clk', 'rst', 'en', 'q']);
	assert(r.svg.includes('data-type="$sdffe"') && r.svg.includes('data-type="$add"'));
	assert(r.svg.includes('id="cell_clk" data-type="input"') && r.svg.includes('id="cell_q" data-type="output"'));
	assert.match(r.svg, /class="net_[\d,]+" data-net="q"/);
	assert(!Object.values(rtl.modules.counter.cells).some(c => 'ref' in c.attributes), 'caller netlist was mutated');

	// (a) gate level + (c) hierarchy rendered concurrently (renders must be serialized internally)
	const [g, h] = await Promise.all([renderSchematicSvg(gate), renderSchematicSvg(hier)]);
	themed(g.svg);
	assert.strictEqual(g.cellCount, Object.keys(gate.modules.counter.cells).length);
	hasCells(g.svg, Object.keys(gate.modules.counter.cells));
	themed(h.svg);
	assert.strictEqual(h.module, 'top', 'top attribute must win over module order');
	hasCells(h.svg, ['u_inc', 'u_reg']);
	assert(h.svg.includes('id="cell_u_reg" data-type="dff_en"') && />dff_en</.test(h.svg), 'paramod box should show hdlname');

	// explicit submodule, unknown module, overflow
	const sub = Object.keys(hier.modules).find(n => n.includes('dff_en'));
	assert.strictEqual((await renderSchematicSvg(hier, { module: sub })).cellCount, 1);
	await assert.rejects(renderSchematicSvg(hier, { module: 'nope' }), /"nope" is not in the netlist/);
	await assert.rejects(renderSchematicSvg(gate, { maxCells: 10 }), new RegExp(`has ${g.cellCount} cells, more than the schematic limit of 10`));

	// names are XML-escaped (netlistsvg does not escape them)
	const odd = JSON.parse(JSON.stringify(rtl));
	const cells = odd.modules.counter.cells;
	const [first] = Object.keys(cells);
	cells['x<&"y'] = cells[first];
	delete cells[first];
	const e = await renderSchematicSvg(odd);
	assert(e.svg.includes('id="cell_x&lt;&amp;&quot;y"') && !e.svg.includes('x<&'));

	fs.rmSync(dir, { recursive: true, force: true });
	console.log('schematic.test.js: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
