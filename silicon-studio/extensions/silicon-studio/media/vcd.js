// IEEE 1364 VCD parser (plus the common 's' string extension). Browser global SiliconVcd or CommonJS.
(function (root) {
  'use strict';

  // Keywords that only wrap value changes in the data section; their contents are parsed as changes.
  const DUMP_WRAPPERS = new Set(['$dumpvars', '$dumpall', '$dumpon', '$dumpoff', '$end']);

  // Left-extend a binary value to the declared width (IEEE: pad with 0, or with x/z when the MSB is x/z).
  function extend(v, w) {
    if (v.length >= w) return v;
    const p = v[0] === 'x' || v[0] === 'z' ? v[0] : '0';
    return p.repeat(w - v.length) + v;
  }

  function parseVcd(text) {
    if (typeof text !== 'string') throw new TypeError('parseVcd expects a string');
    const n = text.length;
    let pos = 0;

    // Whitespace-delimited tokenizer (any char <= ' ' is whitespace, which covers CR/LF/tab).
    function next() {
      while (pos < n && text.charCodeAt(pos) <= 32) pos++;
      if (pos >= n) return null;
      const s = pos;
      while (pos < n && text.charCodeAt(pos) > 32) pos++;
      return text.slice(s, pos);
    }
    function untilEnd() {
      const out = [];
      for (let t; (t = next()) !== null && t !== '$end';) out.push(t);
      return out;
    }

    const timescale = { magnitude: 1, unit: 'ns' };
    const scopes = { name: '', type: 'root', children: [], signals: [] };
    const stack = [scopes], prefixes = [''];
    const signals = new Map();
    const byCode = new Map(); // identifier code -> { ch: { times, values }, w, ev }  (shared by aliases)
    let time = 0, endTime = 0, sawDefs = false;

    function add(e, v) {
      const T = e.ch.times, V = e.ch.values;
      let k = T.length;
      if (k && T[k - 1] === time) { T.pop(); V.pop(); k--; } // last write at a timestep wins
      if (k && V[k - 1] === v && !e.ev) return;           // drop repeats ($dumpall/$dumpon re-emit values)
      T.push(time);
      V.push(v);
    }

    for (let t; (t = next()) !== null;) {
      const c = t.charCodeAt(0);
      if (c === 35) { // '#time'
        const v = +t.slice(1);
        if (v === v) { time = v; if (v > endTime) endTime = v; }
      } else if (c === 98 || c === 66) { // 'b'/'B' vector
        const e = byCode.get(next());
        if (e) add(e, extend(t.slice(1).toLowerCase(), e.w));
      } else if (c === 114 || c === 82 || c === 115) { // 'r'/'R' real, 's' string
        const e = byCode.get(next());
        if (e) add(e, t.slice(1));
      } else if (c === 36) { // '$keyword'
        if (DUMP_WRAPPERS.has(t)) continue;
        if (t === '$var') {
          const f = untilEnd();
          if (f.length < 4) continue;
          const kind = f[0], width = parseInt(f[1], 10) || 1, code = f[2];
          const name = f.slice(3).join('').replace(/\[\d+:\d+\]$/, ''); // "count [7:0]" -> count, "d [3]" -> d[3]
          const fullName = prefixes[prefixes.length - 1] + name;
          const id = signals.has(fullName) ? fullName + ' #' + code : fullName;
          let e = byCode.get(code);
          if (!e) byCode.set(code, e = { ch: { times: [], values: [] }, w: width, ev: kind === 'event' });
          signals.set(id, { id, name, fullName, width, kind, changes: e.ch });
          stack[stack.length - 1].signals.push(id);
        } else if (t === '$scope') {
          const f = untilEnd();
          const s = { name: f[1] || f[0] || '', type: f.length > 1 ? f[0] : 'module', children: [], signals: [] };
          stack[stack.length - 1].children.push(s);
          stack.push(s);
          prefixes.push(prefixes[prefixes.length - 1] + s.name + '.');
        } else if (t === '$upscope') {
          untilEnd();
          if (stack.length > 1) { stack.pop(); prefixes.pop(); }
        } else if (t === '$timescale') {
          const m = /^(\d+(?:\.\d+)?)(s|ms|us|ns|ps|fs)$/.exec(untilEnd().join(''));
          if (m) { timescale.magnitude = +m[1]; timescale.unit = m[2]; }
        } else {
          if (t === '$enddefinitions') sawDefs = true;
          untilEnd(); // $comment, $date, $version, $enddefinitions, unknown sections
        }
      } else { // scalar: value char followed by identifier code
        const e = byCode.get(t.length > 1 ? t.slice(1) : next());
        if (e) add(e, extend(c === 48 ? '0' : c === 49 ? '1' : t[0].toLowerCase(), e.w));
      }
    }

    if (!sawDefs && !signals.size && /\S/.test(text)) throw new Error('Not a VCD file (no $var or $enddefinitions found)');
    return { timescale, endTime, scopes, signals };
  }

  if (typeof module === 'object' && module.exports) module.exports = { parseVcd };
  else root.SiliconVcd = { parseVcd };
})(typeof self !== 'undefined' ? self : this);
