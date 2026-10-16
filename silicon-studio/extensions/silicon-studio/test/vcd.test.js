// Run from the extension root: node test/vcd.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { parseVcd } = require(path.join(__dirname, '..', 'media', 'vcd.js'));

const vals = (d, id) => d.signals.get(id).changes.values;
const times = (d, id) => d.signals.get(id).changes.times;

// 1) Head of a real Icarus Verilog 13 dump (counter + testbench, $dumpvars(0, tb), `timescale 1ns/100ps).
const IVERILOG = `$date
$end
$version
\tIcarus Verilog
$end
$timescale
\t100ps
$end
$scope module tb $end
$var wire 1 ! wrap $end
$var wire 8 " count [7:0] $end
$var reg 1 # clk $end
$var reg 1 $ en $end
$var reg 4 % nib [3:0] $end
$var reg 1 & rst $end
$var integer 32 ' cycles [31:0] $end
$var real 1 ( ratio $end
$scope module dut $end
$var wire 1 # clk $end
$var wire 1 $ en $end
$var wire 1 & rst $end
$var wire 1 ! wrap $end
$var reg 8 ) count [7:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
$comment Show the parameter values. $end
$dumpall
$end
#0
$dumpvars
bx )
r0 (
b0 '
x&
bx %
x$
0#
bx "
x!
$end
#50
r0.3333333333333333 (
b1 '
1#
#100
0#
#120
bz01x %
1&
#150
0!
b0 "
b0 )
r0.6666666666666666 (
b10 '
1#
#200
0#
#220
b101 %
1$
0&
#250
b1 "
b1 )
r1 (
b11 '
1#
`;
{
  const d = parseVcd(IVERILOG);
  assert.deepStrictEqual(d.timescale, { magnitude: 100, unit: 'ps' });
  assert.strictEqual(d.endTime, 250);
  assert.strictEqual(d.signals.size, 13);
  const tb = d.scopes.children[0];
  assert.deepStrictEqual([d.scopes.type, tb.name, tb.type, tb.children[0].name], ['root', 'tb', 'module', 'dut']);
  assert.deepStrictEqual(tb.signals.slice(0, 3), ['tb.wrap', 'tb.count', 'tb.clk']);
  assert.deepStrictEqual(tb.children[0].signals, ['tb.dut.clk', 'tb.dut.en', 'tb.dut.rst', 'tb.dut.wrap', 'tb.dut.count']);
  const count = d.signals.get('tb.dut.count');
  assert.deepStrictEqual([count.name, count.fullName, count.width, count.kind], ['count', 'tb.dut.count', 8, 'reg']);
  // aliases share one change list
  assert.strictEqual(d.signals.get('tb.clk').changes, d.signals.get('tb.dut.clk').changes);
  assert.notStrictEqual(d.signals.get('tb.count').changes, count.changes);
  assert.deepStrictEqual(times(d, 'tb.clk'), [0, 50, 100, 150, 200, 250]);
  assert.deepStrictEqual(vals(d, 'tb.clk'), ['0', '1', '0', '1', '0', '1']);
  assert.deepStrictEqual(vals(d, 'tb.count'), ['xxxxxxxx', '00000000', '00000001']); // x at start, then 0-padded
  assert.deepStrictEqual(vals(d, 'tb.nib'), ['xxxx', 'z01x', '0101']);
  assert.deepStrictEqual(vals(d, 'tb.cycles')[3], '0'.repeat(30) + '11'); // integer widened to 32
  assert.strictEqual(d.signals.get('tb.ratio').kind, 'real');
  assert.deepStrictEqual(vals(d, 'tb.ratio'), ['0', '0.3333333333333333', '0.6666666666666666', '1']);
  assert.deepStrictEqual(times(d, 'tb.rst'), [0, 120, 220]);
}

// 2) Hand-written edge cases, CRLF line endings throughout.
const EDGE = [
  '$comment multi', 'line $end',
  '$timescale', '   10', '  us', '$end',
  '$var wire 1 ? top_level $end', // var outside any scope
  '$scope module top $end',
  '$var wire 8 a bus [7:0] $end',
  '$var wire 4 b xv $end',
  '$var wire 4 c zv $end',
  '$var wire 1 d bit [3] $end',
  '$var string 1 e msg $end',
  '$scope begin blk $end',
  '$var wire 8 a bus_alias $end',
  '$upscope $end',
  '$var event 1 f ev $end',
  '$upscope $end',
  '$enddefinitions $end',
  '#0', '$dumpvars', 'b101 a', 'bx1 b', 'bZ0 c', 'X d', 'sHello e', '$end',
  '#5   B11110000    a   0d', '$comment noise 1d bxx a $end',
  '1f', '#7', '1f', '1f',
  '#10', '$dumpoff', 'bx a', 'xd', '$end',
  '#20', '$dumpon', 'b11110000 a', '1d', '$end', 'b1 b', '0 d',
  '#30', '$dumpall', 'b11110000 a', '$end', 'zd', 'z ?',
].join('\r\n');
{
  const d = parseVcd(EDGE);
  assert.deepStrictEqual(d.timescale, { magnitude: 10, unit: 'us' });
  assert.strictEqual(d.endTime, 30);
  assert.deepStrictEqual(d.scopes.signals, ['top_level']);
  const top = d.scopes.children[0];
  assert.deepStrictEqual(top.signals, ['top.bus', 'top.xv', 'top.zv', 'top.bit[3]', 'top.msg', 'top.ev']);
  assert.deepStrictEqual([top.children[0].name, top.children[0].type, top.children[0].signals], ['blk', 'begin', ['top.blk.bus_alias']]);
  assert.strictEqual(d.signals.get('top.blk.bus_alias').changes, d.signals.get('top.bus').changes);
  assert.deepStrictEqual(times(d, 'top.bus'), [0, 5, 10, 20]); // $dumpall repeat at #30 dropped
  assert.deepStrictEqual(vals(d, 'top.bus'), ['00000101', '11110000', 'xxxxxxxx', '11110000']);
  assert.deepStrictEqual(vals(d, 'top.xv'), ['xxx1', '0001']); // x MSB extends with x; 1 extends with 0
  assert.deepStrictEqual(vals(d, 'top.zv'), ['zzz0']);         // uppercase Z normalised, z MSB extends with z
  assert.deepStrictEqual(times(d, 'top.bit[3]'), [0, 5, 10, 20, 30]);
  assert.deepStrictEqual(vals(d, 'top.bit[3]'), ['x', '0', 'x', '0', 'z']); // "1d" then "0 d" at #20: last wins
  assert.deepStrictEqual(vals(d, 'top.msg'), ['Hello']);
  assert.deepStrictEqual(times(d, 'top.ev'), [5, 7]); // events keep repeats across timesteps
  assert.deepStrictEqual([times(d, 'top_level'), vals(d, 'top_level')], [[30], ['z']]);
}

// 3) Degenerate inputs must not throw; garbage must.
{
  const empty = parseVcd('');
  assert.deepStrictEqual([empty.endTime, empty.signals.size, empty.scopes.children.length], [0, 0, 0]);
  const noChanges = parseVcd('$timescale 1ps $end $scope module t $end $var wire 1 ! a $end $upscope $end $enddefinitions $end');
  assert.deepStrictEqual([noChanges.endTime, times(noChanges, 't.a')], [0, []]);
  assert.throws(() => parseVcd('hello world'), /Not a VCD/);
}

// 4) Throughput: ~20 MB synthetic dump parses in one pass.
{
  const parts = ['$timescale 1ns $end $scope module t $end $var reg 1 ! clk $end $var reg 32 " cnt $end $upscope $end $enddefinitions $end\n'];
  for (let i = 0; i < 400000; i++) parts.push(`#${i * 5}\n${i & 1}!\nb${i.toString(2)} "\n`);
  const big = parts.join('');
  const t0 = Date.now();
  const d = parseVcd(big);
  const ms = Date.now() - t0;
  assert.strictEqual(times(d, 't.clk').length, 400000);
  assert.strictEqual(vals(d, 't.cnt')[399999], (399999).toString(2).padStart(32, '0'));
  assert.ok(ms < 5000, `parse too slow: ${ms} ms`);
  console.log(`parsed ${(big.length / 1e6).toFixed(1)} MB in ${ms} ms`);
}

console.log('vcd.test.js: all assertions passed');
