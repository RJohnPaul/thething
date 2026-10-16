// Turn EDA tool logs (yosys, iverilog, vvp, verilator) into structured diagnostics.
// Pure TS, no dependencies. line/column are 1-based; endColumn is exclusive (yosys "src" convention).
// Formats were taken from real output of yosys 0.70, iverilog 13 and verilator 5.052.

export type Severity = 'error' | 'warning' | 'info';

export interface ToolMessage {
	tool: 'yosys' | 'iverilog' | 'vvp' | 'verilator' | 'openroad' | 'klayout';
	severity: Severity;
	message: string;
	file?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	code?: string;
}

interface Loc { file: string; line: number; column?: number; endLine?: number; endColumn?: number }

function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

function addLine(msg: ToolMessage, text: string): void {
	msg.message = msg.message ? msg.message + '\n' + text : text;
}

/** "a.v:12.5-12.20", "a.v:3.1-9.10|b.v:4.2-4.9" (first wins) or "a.v:7". */
export function parseYosysSrc(src: string): Loc | undefined {
	const m = /^(.+):(\d+)(?:\.(\d+))?(?:-(\d+)(?:\.(\d+))?)?$/.exec(src.split('|')[0].trim());
	if (!m) return undefined;
	const loc: Loc = { file: m[1], line: +m[2] };
	if (m[3]) loc.column = +m[3];
	if (m[4]) loc.endLine = +m[4];
	if (m[5]) loc.endColumn = +m[5];
	return loc;
}

// Locations yosys embeds in message text: "... at f.v:3.13-3.18.", "... (f.v:3)", "$proc$f.v:4$1", "source: f.v:3.14-3.19".
const YOSYS_EMBEDDED = [/ at (\S+?)\.?$/, /\((\S+?)\)\.?$/, /\$proc\$(.+?:\d+)\$/, /source: (\S+)/];

function yosysLocIn(text: string): Loc | undefined {
	for (const re of YOSYS_EMBEDDED) {
		const m = re.exec(text);
		const loc = m && parseYosysSrc(m[1]);
		if (loc) return loc;
	}
	return undefined;
}

export function parseYosysLog(text: string): ToolMessage[] {
	const out: ToolMessage[] = [];
	let cur: ToolMessage | undefined;
	for (const l of splitLines(text)) {
		const m = /^(?:(.+?:\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?): )?(Warning|ERROR):\s*(.*)$/.exec(l);
		if (m) {
			cur = { tool: 'yosys', severity: m[2] === 'ERROR' ? 'error' : 'warning', message: m[3] };
			Object.assign(cur, (m[1] ? parseYosysSrc(m[1]) : undefined) ?? yosysLocIn(m[3]));
			out.push(cur);
		} else if (cur && /^\s+\S/.test(l)) {
			addLine(cur, l.trim()); // e.g. driver list / logic-loop cells
			if (cur.file === undefined) Object.assign(cur, yosysLocIn(l));
		} else {
			cur = undefined;
		}
	}
	return out;
}

const IVERILOG_NOISE = /^(\d+ error\(s\) during elaboration\.|Elaboration failed|I give up\.|Preprocessor failed with \d+ errors?\.|\*\*\*.*|\s.*|)$/;

export function parseIverilogLog(text: string): ToolMessage[] {
	const out: ToolMessage[] = [];
	let cur: ToolMessage | undefined;
	for (const l of splitLines(text)) {
		// continuation: "f.v:5:        : Pruning ..." or "       : time precision ..."
		const c = /^(?:(.+?):(\d+):)?\s+: (.*)$/.exec(l);
		if (c) {
			if (!cur) continue;
			const other = c[1] !== undefined && (c[1] !== cur.file || +c[2] !== cur.line);
			addLine(cur, other ? `${c[1]}:${c[2]}: ${c[3].trim()}` : c[3].trim());
			continue;
		}
		if (IVERILOG_NOISE.test(l)) {
			cur = undefined;
			continue;
		}
		// "f.v:2: error: ...", "f.v:5: sorry: ...", "f.v:2: syntax error", "warning: ...", "No top level modules ..."
		const m = /^(?:(.+?):(\d+): )?(?:(error|warning|sorry): )?(.*)$/.exec(l)!;
		cur = { tool: 'iverilog', severity: m[3] === 'warning' ? 'warning' : 'error', message: m[4] };
		if (m[1] !== undefined) {
			cur.file = m[1];
			cur.line = +m[2];
		}
		out.push(cur);
	}
	return out;
}

export function parseVvpLog(text: string): ToolMessage[] {
	const out: ToolMessage[] = [];
	let cur: ToolMessage | undefined;
	for (const l of splitLines(text)) {
		// "ERROR: tb.v:11: msg", "FATAL: ...", "INFO: ...", "WARNING: ...", "VCD warning: tb.v:7: ...", plain "ERROR: msg"
		const m = /^(?:(VCD|FST|LXT2?) )?(info|warning|error|fatal):\s*(?:(.*?\.[A-Za-z]\w*):(\d+):\s?)?(.*)$/i.exec(l);
		if (m && !(m[1] && /^info$/i.test(m[2]))) {
			const kind = m[2].toLowerCase();
			cur = { tool: 'vvp', severity: kind === 'info' ? 'info' : kind === 'warning' ? 'warning' : 'error', message: m[5] };
			if (m[3] !== undefined) {
				cur.file = m[3];
				cur.line = +m[4];
			}
			out.push(cur);
		} else if (cur && !m && /^\s+\S/.test(l)) {
			addLine(cur, l.trim()); // "Time: 3000  Scope: tb", wrapped VCD text
		} else {
			cur = undefined;
		}
	}
	return out;
}

const VERILATOR_BOILERPLATE = /^(See the manual|For (warning|error) description see|Use "\/\* verilator lint_off)/;

export function parseVerilatorLog(text: string): ToolMessage[] {
	const out: ToolMessage[] = [];
	let cur: ToolMessage | undefined;
	let excerptLine = 0;
	for (const l of splitLines(text)) {
		const m = /^%(Error|Warning)(?:-(\w+))?: (?:(.+?):(\d+):(?:(\d+):)? )?(.*)$/.exec(l);
		if (m) {
			excerptLine = 0;
			cur = undefined;
			if (!m[2] && /^Exiting due to /.test(m[6])) continue;
			cur = { tool: 'verilator', severity: m[1] === 'Error' ? 'error' : 'warning', message: m[6] };
			if (m[2]) cur.code = m[2];
			if (m[3] !== undefined) {
				cur.file = m[3];
				cur.line = +m[4];
				if (m[5]) cur.column = +m[5];
			}
			out.push(cur);
			continue;
		}
		if (!cur || !/^\s+\S/.test(l)) {
			cur = undefined;
			continue;
		}
		const excerpt = /^\s*(\d+) \|/.exec(l);
		const caret = /^\s*\|\s*(\^~*)/.exec(l);
		if (excerpt) {
			excerptLine = +excerpt[1];
		} else if (caret) {
			// "^~~~~~" under the header's own line gives the token span
			if (excerptLine === cur.line && cur.column && cur.endColumn === undefined) {
				cur.endLine = cur.line;
				cur.endColumn = cur.column + caret[1].length;
			}
		} else {
			const t = l.trim().replace(/^: /, '').replace(/^\.\.\. /, '');
			if (!VERILATOR_BOILERPLATE.test(t)) addLine(cur, t);
		}
	}
	return out;
}

/** Keys match msg.code case-insensitively; 'off' drops the message. */
export function applySeverityOverrides(msgs: ToolMessage[], overrides: Record<string, Severity | 'off'>): ToolMessage[] {
	const byCode = new Map(Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v]));
	const out: ToolMessage[] = [];
	for (const msg of msgs) {
		const s = msg.code ? byCode.get(msg.code.toLowerCase()) : undefined;
		if (s === 'off') continue;
		out.push(s ? { ...msg, severity: s } : msg);
	}
	return out;
}

/**
 * OpenROAD: "[ERROR GPL-0302] message", "[WARNING DRT-0349] message" (code = tool-number), plus Tcl errors
 * printed as "Error: file.tcl, 12 <message>". Informational lines are dropped.
 */
export function parseOpenroadLog(text: string): ToolMessage[] {
	const out: ToolMessage[] = [];
	for (const line of splitLines(text)) {
		const m = /^\[(ERROR|WARNING|CRITICAL)\s+([A-Z]+-\d+)\]\s*(.*)$/.exec(line.trim());
		if (m) {
			out.push({ tool: 'openroad', severity: m[1] === 'WARNING' ? 'warning' : 'error', code: m[2], message: m[3] });
			continue;
		}
		const e = /^Error:\s*(.*)$/.exec(line.trim());
		if (e) {
			out.push({ tool: 'openroad', severity: 'error', message: e[1] });
		}
	}
	return out;
}
