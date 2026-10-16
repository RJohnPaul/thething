// Run: node --experimental-strip-types test/diagnostics.test.ts
// Fixtures are real output of yosys 0.70, iverilog/vvp 13 and verilator 5.052 on deliberately broken designs
// (one hand-written line: the legacy yosys "(file:line)" style, marked below).
import assert from 'node:assert/strict';
import {
  parseYosysLog, parseIverilogLog, parseVvpLog, parseVerilatorLog, applySeverityOverrides, parseYosysSrc,
} from '../src/diagnostics.ts';
import type { ToolMessage } from '../src/diagnostics.ts';

const YOSYS = [
  "syn.v:2: ERROR: syntax error, unexpected ';'",
  "undecl.v:2: Warning: Identifier `\\b' is implicitly declared.",
  "Warning: Wire t.\\b is used but has no driver.",
  "Warning: Latch inferred for signal `\\t.\\q' from process `\\t.$proc$warn.v:4$1': $auto$proc_dlatch.cc:559:proc_dlatch$17",
  "Warning: multiple conflicting drivers for t.\\r [0]:",
  "    port Q[0] of cell $procdff$18 ($dff)",
  "    port Q[1] of cell $procdff$18 ($dff)",
  "ERROR: Module `\\sub' referenced in module `\\t' in cell `\\u0' is not part of the design.",
  "implicit.v:3: ERROR:Identifier `\\foo' is implicitly declared and `default_nettype is set to none.",
  "y1.v:2: Warning: Yosys has only limited support for tri-state logic at the moment.",
  "Warning: wire '\\w' is assigned in a block at y2.v:3.13-3.18.",
  "y3.v:2: ERROR:Can't resolve function name `\\foo'.",
  "Warning: found logic loop in module t:",
  "    cell $and$y4.v:3$1 ($and) source: y4.v:3.14-3.19",
  "      A[0] --> Y[0]",
  "    wire \\x source: y4.v:2.8-2.9",
  "    cell $or$y4.v:4$2 ($or) source: y4.v:4.14-4.19",
  "      A[0] --> Y[0]",
  "    wire \\y source: y4.v:1.35-1.36",
  "ERROR: Module `sub' referenced in module `t' in cell `u0' does not have a port named 'nope'.",
  "z1.v:2: Warning: Range select out of bounds on signal `\\a': Setting result bit to undef.",
  "Warning: reg '\\q' is assigned in a continuous assignment at z5.v:7.10-7.18.",
  "ERROR: File `nofile.v' not found or is a directory",
  "3.8. Executing PROC_DLATCH pass (convert process syncs to latches).",
  "No latch inferred for signal `\\t.\\y' from process `\\t.$proc$warn.v:8$3'.",
  "Warning: Latch inferred for signal `\\t.\\q' from process `\\t.$proc$warn.v:4$1': $auto$proc_dlatch.cc:559:proc_dlatch$17",
  "",
  "3.9. Executing PROC_DFF pass (convert process syncs to FFs).",
  "Creating register for signal `\\t.\\r' using process `\\t.$proc$warn.v:7$2'.",
  "  created $dff cell `$procdff$18' with positive edge clock.",
  "Checking module t...",
  "Warning: multiple conflicting drivers for t.\\r [0]:",
  "    port Q[0] of cell $procdff$18 ($dff)",
  "    port Q[1] of cell $procdff$18 ($dff)",
  "Found and reported 1 problems.",
  "",
  "Warnings: 2 unique messages, 2 total",
  "End of script. Logfile hash: 370bcf0fd0, time: 0.00s, user: 0.01s, system: 0.00s, MEM: 12.05 MB peak",
  "ERROR: Unsupported construct (legacy/a.v:3).", // hand-written: legacy yosys style
].join('\n');

const IVERILOG = [
  "syn.v:2: syntax error",
  "syn.v:2: error: Syntax error in continuous assignment",
  "undecl.v:2: error: Unable to bind wire/reg/memory `b' in `t'",
  "undecl.v:2: error: Unable to elaborate r-value: (a)&(b)",
  "2 error(s) during elaboration.",
  "nomod.v:2: error: Unknown module type: sub",
  "2 error(s) during elaboration.",
  "*** These modules were missing:",
  "        sub referenced 1 times.",
  "***",
  "implicit.v:3: error: Net foo is not defined in this context.",
  "implicit.v:4: error: Unable to bind wire/reg/memory `foo' in `t'",
  "implicit.v:4: error: Unable to elaborate r-value: foo",
  "3 error(s) during elaboration.",
  "i_width.v:5: warning: Port 1 (a) of module sub expects 4 bit(s), given 8.",
  "i_width.v:5:        : Pruning 4 high bits of the expression.",
  "i_width.v:6: error: 'z' is not a valid l-value for a procedural assignment.",
  "i_width.v:1:      : 'z' is declared here as a wire.",
  "Elaboration failed",
  "y5.v:3: error: port ``nope'' is not a port of u0.",
  "y5.v:3: warning: Port 1 (a) of module sub expects 8 bit(s), given 4.",
  "y5.v:3:        : Padding 4 high bits of the port.",
  "y5.v:3: warning: Port 2 (y) of module sub expects 8 bit(s), given 4.",
  "y5.v:3:        : Padding 4 high bits of the port.",
  "1 error(s) during elaboration.",
  "i2.v:2: Include file missing.vh not found",
  "Preprocessor failed with 1 errors.",
  "eof.v:3: syntax error",
  "I give up.",
  "s1.v:5: sorry: concurrent_assertion_item not supported. Try -gno-assertions or -gsupported-assertions to turn this message off.",
  "warning: Some design elements have no explicit time unit and/or",
  "       : time precision. This may cause confusing timing results.",
  "       : Affected design elements are:",
  "       :   -- module u declared here: s2.v:1",
  "s3.sv:2: sorry: Unpacked structs not supported.",
  "s3.sv:7: syntax error",
  "s3.sv:7: error: Malformed statement",
  "nonexist.v: No such file or directory",
  "No top level modules, and no -s option.",
].join('\n');

const VVP = [
  "VCD info: dumpfile x.vcd opened for output.",
  "hello",
  "INFO: tb.v:9: info msg 0",
  "      Time: 1000  Scope: tb",
  "WARNING: tb.v:10: warn msg",
  "         Time: 2000  Scope: tb",
  "ERROR: tb.v:11: err msg",
  "       Time: 3000  Scope: tb",
  "ERROR: tb.v:12: assert failed a=0",
  "       Time: 4000  Scope: tb",
  "ERROR: tb.v:13: ",
  "       Time: 5000  Scope: tb",
  "ERROR: tb.v:14: $readmemh: Unable to open nofile.hex for reading.",
  "ERROR: custom check failed",
  "FATAL: tb.v:16: fatal msg",
  "       Time: 8000  Scope: tb",
  "VCD info: dumpfile x.vcd opened for output.",
  "VCD warning: tb2.v:7: $dumpfile called after $dumpvars started,",
  "                      using existing file (x.vcd).",
  "VCD warning: $dumpvars ignored, previously called at simtime 0",
  "WARNING: tb2.v:9: $readmemh(short.hex): Not enough words in the file for the requested range [0:3].",
  "tb2.v:10: $finish called at 2 (1s)",
  "VCD Error: tb.v:7: Unable to open /nonexistent_dir/x.vcd for output.",
].join('\n');

const VERILATOR = [
  "%Error: syn.v:2:17: syntax error, unexpected ';', expecting IDENTIFIER-for-type",
  "    2 |   assign y = a &;",
  "      |                 ^",
  "        ... See the manual at https://verilator.org/verilator_doc.html?v=5.052 for more assistance.",
  "%Error: Exiting due to 1 error(s)",
  "%Warning-DECLFILENAME: undecl.v:1:8: Filename 'undecl' does not match MODULE name: 't'",
  "    1 | module t(input a, output y);",
  "      |        ^",
  "                       ... For warning description see https://verilator.org/warn/DECLFILENAME?v=5.052",
  "                       ... Use \"/* verilator lint_off DECLFILENAME */\" and lint_on around source to disable this message.",
  "%Error: undecl.v:2:18: Can't find definition of variable: 'b'",
  "    2 |   assign y = a & b;",
  "      |                  ^",
  "        ... See the manual at https://verilator.org/verilator_doc.html?v=5.052 for more assistance.",
  "%Error: Exiting due to 1 error(s), 1 warning(s)",
  "%Warning-DECLFILENAME: warn.v:1:8: Filename 'warn' does not match MODULE name: 't'",
  "    1 | module t(input clk, input [7:0] a, input sel, output reg [3:0] y, output reg q, output z);",
  "      |        ^",
  "                       ... For warning description see https://verilator.org/warn/DECLFILENAME?v=5.052",
  "                       ... Use \"/* verilator lint_off DECLFILENAME */\" and lint_on around source to disable this message.",
  "%Warning-WIDTHTRUNC: warn.v:8:15: Operator ASSIGN expects 4 bits on the Assign RHS, but Assign RHS's VARREF 'a' generates 8 bits.",
  "                                : ... note: In instance 't'",
  "    8 |   always @* y = a;",
  "      |               ^",
  "                     ... For warning description see https://verilator.org/warn/WIDTHTRUNC?v=5.052",
  "                     ... Use \"/* verilator lint_off WIDTHTRUNC */\" and lint_on around source to disable this message.",
  "%Warning-UNUSEDSIGNAL: warn.v:3:13: Bits of signal are not used: 'r'[7:2]",
  "                                  : ... note: In instance 't'",
  "    3 |   reg [7:0] r;",
  "      |             ^",
  "                       ... For warning description see https://verilator.org/warn/UNUSEDSIGNAL?v=5.052",
  "                       ... Use \"/* verilator lint_off UNUSEDSIGNAL */\" and lint_on around source to disable this message.",
  "%Warning-LATCH: warn.v:4:3: Latch inferred for signal 'q' (not all control paths of combinational always assign a value)",
  "                          : ... Suggest use of always_latch for intentional latches",
  "    4 |   always @* begin",
  "      |   ^~~~~~",
  "                ... For warning description see https://verilator.org/warn/LATCH?v=5.052",
  "                ... Use \"/* verilator lint_off LATCH */\" and lint_on around source to disable this message.",
  "%Warning-MULTIDRIVEN: warn.v:1:88: Bit [0] of signal 'z' have multiple combinational drivers. This can cause performance degradation.",
  "                      warn.v:9:12: ... Location of offending driver",
  "    9 |   assign z = r[0];",
  "      |            ^",
  "                      warn.v:10:12: ... Location of offending driver",
  "   10 |   assign z = r[1];",
  "      |            ^",
  "                      ... For warning description see https://verilator.org/warn/MULTIDRIVEN?v=5.052",
  "                      ... Use \"/* verilator lint_off MULTIDRIVEN */\" and lint_on around source to disable this message.",
  "%Error: Exiting due to 5 warning(s)",
  "%Warning-DECLFILENAME: nomod.v:1:8: Filename 'nomod' does not match MODULE name: 't'",
  "    1 | module t(input a, output y);",
  "      |        ^",
  "                       ... For warning description see https://verilator.org/warn/DECLFILENAME?v=5.052",
  "                       ... Use \"/* verilator lint_off DECLFILENAME */\" and lint_on around source to disable this message.",
  "%Error-MODMISSING: nomod.v:2:3: Cannot find file containing module: 'sub'",
  "    2 |   sub u0(.a(a), .y(y));",
  "      |   ^~~",
  "                   ... For error description see https://verilator.org/warn/MODMISSING?v=5.052",
  "                   ... This may be because there's no search path specified with -I<dir>.",
  "                   ... Looked in:",
  "                        sub",
  "                        sub.v",
  "                        sub.sv",
  "                        obj_dir/sub",
  "                        obj_dir/sub.v",
  "                        obj_dir/sub.sv",
  "                   ... With current working directory '/work'",
  "%Error: Exiting due to 1 error(s), 1 warning(s)",
  "%Warning-DECLFILENAME: implicit.v:2:8: Filename 'implicit' does not match MODULE name: 't'",
  "    2 | module t(input wire a, output wire y);",
  "      |        ^",
  "                       ... For warning description see https://verilator.org/warn/DECLFILENAME?v=5.052",
  "                       ... Use \"/* verilator lint_off DECLFILENAME */\" and lint_on around source to disable this message.",
  "%Error: implicit.v:3:10: Signal definition not found, and implicit disabled with `default_nettype: 'foo'",
  "    3 |   assign foo = a;",
  "      |          ^~~",
  "        ... See the manual at https://verilator.org/verilator_doc.html?v=5.052 for more assistance.",
  "%Error: Exiting due to 1 error(s), 1 warning(s)",
  "%Warning-DECLFILENAME: i_width.v:1:8: Filename 'i_width' does not match MODULE name: 't'",
  "    1 | module t(input [7:0] a, output [3:0] y, output z);",
  "      |        ^",
  "                       ... For warning description see https://verilator.org/warn/DECLFILENAME?v=5.052",
  "                       ... Use \"/* verilator lint_off DECLFILENAME */\" and lint_on around source to disable this message.",
  "%Warning-WIDTHTRUNC: i_width.v:3:12: Operator ASSIGNW expects 4 bits on the Assign RHS, but Assign RHS's VARREF 'a' generates 8 bits.",
  "                                   : ... note: In instance 't'",
  "    3 |   assign w = a;",
  "      |            ^",
  "                     ... For warning description see https://verilator.org/warn/WIDTHTRUNC?v=5.052",
  "                     ... Use \"/* verilator lint_off WIDTHTRUNC */\" and lint_on around source to disable this message.",
  "%Warning-WIDTHTRUNC: i_width.v:5:11: Input port connection 'a' expects 4 bits on the pin connection, but pin connection's VARREF 'a' generates 8 bits.",
  "                                   : ... note: In instance 't'",
  "    5 |   sub u0(.a(a));",
  "      |           ^",
  "%Error-PROCASSWIRE: i_width.v:6:15: Procedural assignment to wire, perhaps intended var (IEEE 1800-2023 6.5): 'z'",
  "                                  : ... note: In instance 't'",
  "    6 |   always @(a) z = a[0];",
  "      |               ^",
  "                    ... For error description see https://verilator.org/warn/PROCASSWIRE?v=5.052",
  "%Warning-UNUSEDSIGNAL: i_width.v:8:24: Signal is not used: 'a'",
  "                                     : ... note: In instance 't.u0'",
  "    8 | module sub(input [3:0] a); endmodule",
  "      |                        ^",
  "                       ... For warning description see https://verilator.org/warn/UNUSEDSIGNAL?v=5.052",
  "                       ... Use \"/* verilator lint_off UNUSEDSIGNAL */\" and lint_on around source to disable this message.",
  "%Error: Exiting due to 1 error(s), 4 warning(s)",
  "%Error: eof.v:2:15: syntax error, unexpected $end",
  "    2 |   assign y = a;",
  "      |               ^",
  "        ... See the manual at https://verilator.org/verilator_doc.html?v=5.052 for more assistance.",
  "%Error: Cannot continue",
  "        ... This fatal error may be caused by the earlier error(s); resolve those first.",
].join('\n');

function has(msgs: ToolMessage[], text: string, want: Partial<ToolMessage>): void {
  const m = msgs.find((x) => x.message.includes(text));
  assert.ok(m, `no message containing ${JSON.stringify(text)}`);
  for (const [k, v] of Object.entries(want)) assert.deepEqual(m[k as keyof ToolMessage], v, `${k} of ${JSON.stringify(m)}`);
}
const none = (msgs: ToolMessage[], re: RegExp) => assert.ok(!msgs.some((m) => re.test(m.message)), `unexpected ${re}`);

// yosys
const y = parseYosysLog(YOSYS);
assert.equal(y.length, 18);
assert.ok(y.every((m) => m.tool === 'yosys'));
has(y, 'syntax error, unexpected', { severity: 'error', file: 'syn.v', line: 2, column: undefined });
has(y, "Identifier `\\b' is implicitly declared", { severity: 'warning', file: 'undecl.v', line: 2 });
has(y, 'is used but has no driver', { severity: 'warning', file: undefined });
has(y, 'Latch inferred', { severity: 'warning', file: 'warn.v', line: 4 });
has(y, 'multiple conflicting drivers', { severity: 'warning', file: undefined });
assert.match(y.find((m) => m.message.startsWith('multiple'))!.message, /:\nport Q\[0\] of cell \$procdff\$18 \(\$dff\)\nport Q\[1\]/);
has(y, 'is not part of the design', { severity: 'error', file: undefined });
has(y, 'default_nettype is set to none', { severity: 'error', file: 'implicit.v', line: 3 });
has(y, 'assigned in a block', { file: 'y2.v', line: 3, column: 13, endLine: 3, endColumn: 18 });
has(y, 'found logic loop', { file: 'y4.v', line: 3, column: 14, endLine: 3, endColumn: 19 });
has(y, 'not found or is a directory', { severity: 'error', file: undefined });
has(y, 'Unsupported construct', { severity: 'error', file: 'legacy/a.v', line: 3 });
none(y, /unique messages|Found and reported|Executing|No latch inferred/);

assert.deepEqual(parseYosysSrc('rtl/a.v:12.5-12.20'), { file: 'rtl/a.v', line: 12, column: 5, endLine: 12, endColumn: 20 });
assert.deepEqual(parseYosysSrc('a.v:3.1-9.10|b.v:4.2-4.9'), { file: 'a.v', line: 3, column: 1, endLine: 9, endColumn: 10 });
assert.deepEqual(parseYosysSrc('a.v:7'), { file: 'a.v', line: 7 });
assert.equal(parseYosysSrc('no location'), undefined);

// iverilog
const iv = parseIverilogLog(IVERILOG);
assert.equal(iv.length, 22);
assert.deepEqual(iv[0], { tool: 'iverilog', severity: 'error', message: 'syntax error', file: 'syn.v', line: 2 });
has(iv, 'Unknown module type: sub', { severity: 'error', file: 'nomod.v', line: 2 });
has(iv, 'Net foo is not defined', { severity: 'error', file: 'implicit.v', line: 3 });
has(iv, 'expects 4 bit(s), given 8', { severity: 'warning', file: 'i_width.v', line: 5,
  message: 'Port 1 (a) of module sub expects 4 bit(s), given 8.\nPruning 4 high bits of the expression.' });
has(iv, 'not a valid l-value', { severity: 'error', line: 6,
  message: "'z' is not a valid l-value for a procedural assignment.\ni_width.v:1: 'z' is declared here as a wire." });
has(iv, 'concurrent_assertion_item not supported', { severity: 'error', file: 's1.v', line: 5 });
has(iv, 'Unpacked structs', { severity: 'error', file: 's3.sv', line: 2 });
has(iv, 'Include file missing.vh', { severity: 'error', file: 'i2.v', line: 2 });
has(iv, 'Some design elements', { severity: 'warning', file: undefined });
assert.match(iv.find((m) => m.message.startsWith('Some design'))!.message, /\nAffected design elements are:\n-- module u declared here: s2.v:1$/);
has(iv, 'No such file or directory', { severity: 'error', file: undefined });
none(iv, /during elaboration|I give up|Elaboration failed|modules were missing|referenced 1 times|Preprocessor failed|^\*\*\*/);

// vvp
const v = parseVvpLog(VVP);
assert.equal(v.length, 12);
has(v, 'info msg 0', { severity: 'info', file: 'tb.v', line: 9, message: 'info msg 0\nTime: 1000  Scope: tb' });
has(v, 'warn msg', { severity: 'warning', file: 'tb.v', line: 10 });
has(v, 'err msg', { severity: 'error', file: 'tb.v', line: 11 });
has(v, 'Time: 5000', { severity: 'error', file: 'tb.v', line: 13 }); // assert with no message
has(v, 'fatal msg', { severity: 'error', file: 'tb.v', line: 16 });
has(v, 'custom check failed', { severity: 'error', file: undefined });
has(v, '$dumpfile called after', { severity: 'warning', file: 'tb2.v', line: 7,
  message: '$dumpfile called after $dumpvars started,\nusing existing file (x.vcd).' });
has(v, '$dumpvars ignored', { severity: 'warning', file: undefined });
has(v, 'nonexistent_dir', { severity: 'error', file: 'tb.v', line: 7 });
none(v, /opened for output|^hello|\$finish/);

// verilator
const vl = parseVerilatorLog(VERILATOR);
assert.equal(vl.length, 19);
none(vl, /Exiting due to|description see|lint_off|See the manual|\|/);
has(vl, "unexpected ';'", { severity: 'error', code: undefined, file: 'syn.v', line: 2, column: 17, endLine: 2, endColumn: 18 });
has(vl, 'Operator ASSIGN expects', { severity: 'warning', code: 'WIDTHTRUNC', file: 'warn.v', line: 8, column: 15,
  message: "Operator ASSIGN expects 4 bits on the Assign RHS, but Assign RHS's VARREF 'a' generates 8 bits.\nnote: In instance 't'" });
has(vl, "'r'[7:2]", { code: 'UNUSEDSIGNAL', file: 'warn.v', line: 3, column: 13 });
has(vl, "Latch inferred for signal 'q'", { code: 'LATCH', line: 4, column: 3, endColumn: 9 });
has(vl, 'multiple combinational drivers', { code: 'MULTIDRIVEN', line: 1, column: 88, endColumn: undefined });
has(vl, 'warn.v:10:12: ... Location of offending driver', { code: 'MULTIDRIVEN' });
has(vl, "Cannot find file containing module: 'sub'", { severity: 'error', code: 'MODMISSING', file: 'nomod.v', line: 2, column: 3 });
has(vl, 'implicit disabled', { severity: 'error', file: 'implicit.v', line: 3, column: 10, endColumn: 13 });
has(vl, 'Procedural assignment to wire', { severity: 'error', code: 'PROCASSWIRE', file: 'i_width.v', line: 6, column: 15 });
has(vl, 'Cannot continue', { severity: 'error', file: undefined });

// severity overrides
const o = applySeverityOverrides(vl, { widthtrunc: 'error', DeclFileName: 'off', latch: 'info' });
assert.equal(o.length, vl.length - vl.filter((m) => m.code === 'DECLFILENAME').length);
assert.ok(o.filter((m) => m.code === 'WIDTHTRUNC').every((m) => m.severity === 'error'));
assert.equal(o.find((m) => m.code === 'LATCH')!.severity, 'info');
assert.equal(vl.find((m) => m.code === 'LATCH')!.severity, 'warning'); // input untouched

console.log('diagnostics: all checks passed');
