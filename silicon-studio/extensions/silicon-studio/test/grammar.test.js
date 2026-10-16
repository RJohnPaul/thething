// Run from the extension root: node test/grammar.test.js   (uses vscode-textmate + vscode-oniguruma from the VS Code repo; override with TM_NODE_MODULES=<dir>)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const NM = path.resolve(process.env.TM_NODE_MODULES || path.join(__dirname, '..', '..', '..', 'node_modules'));

const vsctm = require(path.join(NM, 'vscode-textmate'));
const onig = require(path.join(NM, 'vscode-oniguruma'));
const root = path.join(__dirname, '..');
const grammars = {
	'source.verilog': path.join(root, 'syntaxes/verilog.tmLanguage.json'),
	'source.systemverilog': path.join(root, 'syntaxes/systemverilog.tmLanguage.json'),
};

function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }

// Every regex in a grammar must compile under Oniguruma (not just the ones the samples hit).
function checkRegexes(node, where) {
	if (Array.isArray(node)) { return node.forEach(n => checkRegexes(n, where)); }
	if (!node || typeof node !== 'object') { return; }
	for (const [k, v] of Object.entries(node)) {
		if (['match', 'begin', 'end', 'while'].includes(k) && typeof v === 'string') {
			assert.doesNotThrow(() => new onig.OnigScanner([v]).dispose(), `${where}: bad regex ${v}`);
		} else {
			checkRegexes(v, where);
		}
	}
}

function tokenize(grammar, src) {
	const out = [];
	let stack = vsctm.INITIAL;
	for (const line of src.split('\n')) {
		const r = grammar.tokenizeLine(line, stack);
		for (const t of r.tokens) { out.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }); }
		stack = r.ruleStack;
	}
	return out;
}

function expectScope(tokens, text, scope) {
	const tok = tokens.find(t => t.text === text);
	assert.ok(tok, `no token "${text}"`);
	assert.ok(tok.scopes.some(s => s.startsWith(scope)), `"${text}" has [${tok.scopes.join(', ')}], expected ${scope}`);
}

const VERILOG = `\`timescale 1ns/1ps
\`define WIDTH 8
\`include "defs.vh"
// line comment
/* block
   comment */
(* keep = 1 *)
module counter #(parameter W = \`WIDTH) (
  input  wire         clk,
  output reg  [W-1:0] q
);
  wire [7:0] a = 8'hFF;
  wire [3:0] b = 4'b10_x1;
  wire [5:0] c = 'h3F;
  wire [5:0] z = '0;
  real r = 1.5e-3;
  always @(*) dummy = 1;
  always @(posedge clk) begin
    if (q == 32'sd5) q <= 0;
    else q <= q + 1;
  end
  function [7:0] add_one(input [7:0] v);
    add_one = v + 1;
  endfunction
  sub #(.W(8)) u_sub (.clk(clk));
  adder u_add (.a(a));
  initial begin
    #10ns;
    $display("q=%0d\\n", q);
    $finish;
  end
\`ifdef SIM
  wire \\bus[0] ;
\`endif
endmodule`;

const SYSTEMVERILOG = `package my_pkg;
  typedef enum logic [1:0] {IDLE, RUN} state_t;
endpackage
interface bus_if (input logic clk);
endinterface
class packet extends base_pkt;
  rand bit [7:0] data;
  function new();
    super.new();
  endfunction
  virtual task automatic run_it(int n);
  endtask
endclass
module top;
  logic [7:0] q = '1;
  always_ff @(posedge clk) q <= q + 1;
  always_comb begin
    unique case (q)
      default: ;
    endcase
  end
  fifo #(
    .DEPTH(16)
  ) u_fifo (
    .clk(clk)
  );
  mailbox #(int) mb;
  int after_mb;
endmodule`;

(async () => {
	const wasm = fs.readFileSync(path.join(NM, 'vscode-oniguruma/release/onig.wasm'));
	await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
	const registry = new vsctm.Registry({
		onigLib: Promise.resolve({ createOnigScanner: s => new onig.OnigScanner(s), createOnigString: s => new onig.OnigString(s) }),
		loadGrammar: async scope => grammars[scope] ? vsctm.parseRawGrammar(fs.readFileSync(grammars[scope], 'utf8'), grammars[scope]) : null,
	});

	// JSON validity of every contributed file
	for (const f of ['syntaxes/verilog.tmLanguage.json', 'syntaxes/systemverilog.tmLanguage.json']) { checkRegexes(readJson(f), f); }
	const snippets = readJson('snippets/verilog.code-snippets');
	const prefixes = Object.values(snippets).map(s => { assert.ok(s.prefix && Array.isArray(s.body)); return s.prefix; });
	for (const p of ['module', 'modparam', 'always', 'always_ff', 'always_comb', 'initial', 'case', 'genfor', 'testbench', 'fsm']) {
		assert.ok(prefixes.includes(p), `missing snippet ${p}`);
	}

	// language-configuration regexes (JS) + folding/indent behaviour on tricky lines
	const lc = readJson('language-configuration.json');
	new RegExp(lc.wordPattern);
	const start = new RegExp(lc.folding.markers.start), end = new RegExp(lc.folding.markers.end);
	const inc = new RegExp(lc.indentationRules.increaseIndentPattern), dec = new RegExp(lc.indentationRules.decreaseIndentPattern);
	for (const l of ['always @(posedge clk) begin', 'module m (', '  case (s)', '  unique case (s)', 'class c;', '`ifdef SIM', '// #region io', '  fork', '  if (a) begin : blk']) {
		assert.ok(start.test(l), `fold start: ${l}`);
	}
	for (const l of ['  end else begin', '  extern function void f();', '  pure virtual task t();', '  if (a) begin x = 1; end', 'virtual interface bus_if vif;']) {
		assert.ok(!start.test(l), `not fold start: ${l}`);
	}
	for (const l of ['  end', '  end : blk', 'endmodule', '  endcase', '  join_none', '`endif', '// #endregion']) { assert.ok(end.test(l), `fold end: ${l}`); }
	assert.ok(!end.test('  end else begin') && !end.test('  endcase_x'));
	assert.ok(inc.test('  end else begin') && dec.test('  end else begin') && dec.test('endmodule') && !inc.test('  x = 1;'));

	const v = tokenize(await registry.loadGrammar('source.verilog'), VERILOG);
	[
		['`timescale', 'keyword.other.preprocessor'], ['1ns', 'constant.numeric.time'],
		['`define', 'keyword.other.preprocessor'], ['WIDTH', 'entity.name.function.preprocessor'],
		['`WIDTH', 'entity.name.function.preprocessor'], ['`include', 'keyword.other.preprocessor'],
		['defs.vh', 'string.quoted.double'], [' line comment', 'comment.line.double-slash'],
		['   comment ', 'comment.block'], ['keep', 'entity.other.attribute-name'], ['(*', 'meta.attribute'],
		['module', 'storage.type.declaration'], ['counter', 'entity.name.type.module'],
		['parameter', 'storage.type.declaration'], ['input', 'storage.modifier'], ['wire', 'storage.type'],
		['8\'hFF', 'constant.numeric'], ['4\'b10_x1', 'constant.numeric'], ['\'h3F', 'constant.numeric'], ['\'0', 'constant.numeric'],
		['32\'sd5', 'constant.numeric'], ['1.5e-3', 'constant.numeric.real'], ['10ns', 'constant.numeric.time'],
		['always', 'keyword.other'], ['posedge', 'keyword.other'], ['begin', 'keyword.control'],
		['if', 'keyword.control'], ['else', 'keyword.control'], ['<=', 'keyword.operator'],
		['function', 'storage.type.declaration'], ['add_one', 'entity.name.function'],
		['sub', 'entity.name.type.module'], ['u_sub', 'entity.name.variable.instance'],
		['adder', 'entity.name.type.module'], ['u_add', 'entity.name.variable.instance'],
		['$display', 'support.function.system'], ['$finish', 'support.function.system'],
		['%0d', 'constant.other.placeholder'], ['\\n', 'constant.character.escape'],
		['`ifdef', 'keyword.other.preprocessor'], ['SIM', 'entity.name.function.preprocessor'],
		['`endif', 'keyword.other.preprocessor'], ['\\bus[0]', 'variable.other.escaped'], ['endmodule', 'storage.type.declaration'],
	].forEach(([text, scope]) => expectScope(v, text, scope));
	assert.ok(!v.some(t => t.text.includes('dummy') && t.scopes.some(s => s.startsWith('meta.attribute'))), '@(*) is not an attribute');
	assert.ok(!v.some(t => ['if', 'else'].includes(t.text) && t.scopes.some(s => s.startsWith('entity.name'))), 'keywords never become instance names');

	const sv = tokenize(await registry.loadGrammar('source.systemverilog'), SYSTEMVERILOG);
	[
		['package', 'storage.type.declaration'], ['my_pkg', 'entity.name.type'], ['typedef', 'storage.type.declaration'],
		['enum', 'storage.type'], ['logic', 'storage.type'], ['bus_if', 'entity.name.type'],
		['class', 'storage.type.declaration'], ['packet', 'entity.name.type.class'], ['extends', 'storage.modifier'],
		['base_pkt', 'entity.other.inherited-class'], ['rand', 'storage.modifier'], ['bit', 'storage.type'],
		['new', 'entity.name.function'], ['super', 'variable.language'], ['virtual', 'storage.modifier'],
		['automatic', 'storage.modifier'], ['run_it', 'entity.name.function'], ['\'1', 'constant.numeric'],
		['always_ff', 'keyword.other'], ['always_comb', 'keyword.other'], ['unique', 'keyword.control'], ['case', 'keyword.control'],
		['fifo', 'entity.name.type.module'], ['16', 'constant.numeric'], ['u_fifo', 'entity.name.variable.instance'],
		['int', 'storage.type'], ['top', 'entity.name.type.module'], ['endmodule', 'storage.type.declaration'],
	].forEach(([text, scope]) => expectScope(sv, text, scope));
	// `mailbox #(int) mb;` must close the instantiation region at ';' so the next line is plain code again
	const after = sv.find(t => t.text.includes('after_mb'));
	assert.ok(!after.scopes.some(s => s.startsWith('meta.instantiation')), 'region leaked past ;');

	console.log(`grammar.test.js: OK (${v.length} verilog tokens, ${sv.length} systemverilog tokens)`);
})().catch(e => { console.error(e); process.exit(1); });
