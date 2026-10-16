// Runs Yosys compiled to WebAssembly (YoWASP) as if it were the native binary:
//   node yowasp-runner.mjs <yosys args...>
// The current directory is mirrored into the WASI virtual filesystem and every file Yosys
// creates or changes is written back, so callers can treat it exactly like `yosys`.
// ponytail: whole-directory mirror, fine for run snapshots (KBs-MBs); stream if inputs grow large.
import { runYosys, Exit } from '@yowasp/yosys';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readTree(dir) {
	const tree = {};
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			tree[entry.name] = readTree(full);
		} else if (entry.isFile()) {
			tree[entry.name] = new Uint8Array(fs.readFileSync(full));
		}
	}
	return tree;
}

function writeTree(dir, tree, before) {
	for (const [name, value] of Object.entries(tree ?? {})) {
		if (name.includes('/') || name === '..' || name === '.') {
			continue;
		}
		const full = path.join(dir, name);
		const old = before?.[name];
		if (value instanceof Uint8Array || typeof value === 'string') {
			const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
			if (!(old instanceof Uint8Array) || Buffer.compare(Buffer.from(old), bytes) !== 0) {
				fs.writeFileSync(full, bytes);
			}
		} else {
			fs.mkdirSync(full, { recursive: true });
			writeTree(full, value, old instanceof Uint8Array ? undefined : old);
		}
	}
}

const cwd = process.cwd();
const before = readTree(cwd);
const out = stream => bytes => { if (bytes) { stream.write(bytes); } };
const quiet = () => { };
let files;
let code = 0;
try {
	files = await runYosys(process.argv.slice(2), readTree(cwd), { stdout: out(process.stdout), stderr: out(process.stderr), fetchProgress: quiet });
} catch (e) {
	if (!(e instanceof Exit)) {
		throw e;
	}
	files = e.files;
	code = e.code;
}
writeTree(cwd, files, before);
process.exitCode = code;
