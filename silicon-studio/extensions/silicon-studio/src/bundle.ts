/*---------------------------------------------------------------------------------------------
 *  Silicon Studio — handoff bundle export (PRD 5.16): sources, netlist, reports, run manifests,
 *  checksums, timestamps, tool versions and configuration identifiers in one zip.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as yazl from 'yazl';
import { RunRecord, RunStore, sha256File } from './engine';
import { inputFiles, RunKind } from './project';
import { latestPnr, Staleness } from './views';

interface BundleFile {
	path: string;
	sha256: string;
	bytes: number;
}

export interface BundleResult {
	file: string;
	files: number;
	runs: RunRecord[];
	warnings: string[];
}

/** Writes exports/<name>-<timestamp>.zip from the latest passing synthesis and the latest other runs. */
export async function exportBundle(store: RunStore, extensionVersion: string): Promise<BundleResult> {
	const { project } = store;
	const synth = store.latest('synth', r => r.status === 'passed');
	const staleness = new Staleness(store);
	const warnings: string[] = [];
	if (!synth) {
		warnings.push('No successful synthesis run: the bundle has the current sources and reports but no netlist.');
	}
	const runs: RunRecord[] = synth ? [synth] : [];
	for (const kind of ['lint', 'sim', 'equiv'] as RunKind[]) {
		if (kind === 'equiv' && !synth) {
			continue;
		}
		const run = store.latest(kind, r => kind !== 'equiv' || r.basedOn === synth?.id);
		if (run) {
			runs.push(run);
		} else {
			warnings.push(kind === 'equiv' ? 'No equivalence check of this netlist is included.' : `No ${kind} run is included.`);
		}
	}
	// Physical implementation of this netlist: prefer a complete flow (with GDSII) over a partial one.
	// Prefer the active floorplan scenario's run (latestPnr), then any run of this netlist with a GDSII.
	const physical = synth && project.config.physical
		? latestPnr(store, r => r.basedOn === synth.id && fs.existsSync(path.join(store.runDir(r.id), 'outputs', 'pnr', '6_final.gds'))) ?? latestPnr(store, r => r.basedOn === synth.id)
		: undefined;
	if (physical && physical.metrics?.scenario !== project.config.physical?.activeScenario) {
		warnings.push(`The place-and-route results come from scenario "${physical.metrics?.scenario ?? 'default'}", not the active one.`);
	}
	if (physical) {
		runs.push(physical);
	} else if (project.config.physical) {
		warnings.push('No place-and-route run of this netlist is included (no GDSII).');
	}
	for (const run of runs) {
		if (staleness.isStale(run)) {
			warnings.push(`${run.kind} run ${run.id} is stale: sources changed after it ran.`);
		}
		if (run.status !== 'passed') {
			warnings.push(`${run.kind} run ${run.id} ended with status "${run.status}".`);
		}
	}

	const zip = new yazl.ZipFile();
	const entries: BundleFile[] = [];
	const add = (abs: string, rel: string) => {
		if (fs.existsSync(abs) && !entries.some(e => e.path === rel)) {
			zip.addFile(abs, rel);
			entries.push({ path: rel, sha256: sha256File(abs), bytes: fs.statSync(abs).size });
		}
	};

	const sim = runs.find(r => r.kind === 'sim');
	if (synth) {
		// Exactly the sources the netlist was synthesized from (the run snapshot), not the live files,
		// plus the testbench files from the simulation snapshot.
		const synthDir = store.runDir(synth.id);
		for (const input of [...synth.inputs, ...(sim?.inputs ?? [])]) {
			const from = synth.inputs.includes(input) ? synthDir : store.runDir(sim!.id);
			add(path.join(from, 'inputs', input.path), `source/${input.path}`);
		}
		add(path.join(synthDir, 'outputs', 'netlist.v'), 'netlist/netlist.v');
		add(path.join(synthDir, 'outputs', 'netlist.json'), 'netlist/netlist.json');
		add(path.join(synthDir, 'outputs', 'synth.ys'), 'netlist/synth.ys');
		for (const f of ['stat.txt', 'generic_stat.json', 'mapped_stat.json', 'rtl_stat.json']) {
			add(path.join(synthDir, 'outputs', f), `reports/synthesis/${f}`);
		}
	} else {
		for (const f of new Set([...inputFiles(project.root, project.config, 'sim'), ...inputFiles(project.root, project.config, 'synth')])) {
			add(project.abs(f), `source/${f}`);
		}
	}
	for (const run of runs) {
		const dir = store.runDir(run.id);
		for (const out of run.outputs) {
			if (out.path.startsWith('logs/')) {
				add(path.join(dir, out.path), `reports/${run.kind}/${path.posix.basename(out.path)}`);
			} else if (run.kind === 'sim' && /\.(vcd|fst)$/.test(out.path)) {
				add(path.join(dir, out.path), `simulation/${path.posix.basename(out.path)}`);
			} else if (run.kind === 'equiv' && out.path.endsWith('.ys')) {
				add(path.join(dir, out.path), 'reports/equiv/equiv.ys');
			} else if (run.kind === 'pnr' && /^outputs\/pnr\/(6_final\.(gds|def|v|sdc|spef)|reports\/.*|images\/.*\.png)$/.test(out.path)) {
				const rel = out.path.slice('outputs/pnr/'.length);
				add(path.join(dir, out.path), `physical/${rel}`);
			}
		}
		add(path.join(dir, 'run.json'), `runs/${run.id}.json`);
	}

	const generatedAt = new Date().toISOString();
	const summary = [
		`# Handoff bundle — ${project.config.name}`,
		'',
		`Generated ${generatedAt} by Silicon Studio ${extensionVersion}. Top module: \`${project.config.top}\`.`,
		'',
		'| Stage | Run | Status | Result |',
		'| --- | --- | --- | --- |',
		...runs.map(r => `| ${r.kind} | ${r.id} | ${r.status}${staleness.isStale(r) ? ' (stale)' : ''} | ${r.summary.replace(/\|/g, '\\|')} |`),
		'',
		...(warnings.length ? ['## Warnings', '', ...warnings.map(w => `- ${w}`), ''] : []),
		'## Limitations',
		'',
		physical
			? '- physical/ holds the OpenROAD place-and-route results (GDSII, DEF, final netlist, SPEF, reports, layout images). Routing DRC comes from the detailed router; no foundry DRC/LVS signoff was performed.'
			: '- This bundle stops at a synthesized gate-level netlist. No placement, routing, timing signoff, DRC or LVS was performed.',
		'- A passing simulation is not proof of full functional correctness.',
		'- Cell areas come from the configured liberty library; the bundled silicon_demo library is fictional and not foundry data.',
		'- Nothing in this bundle is manufacturing-ready.',
		'',
		'`manifest.json` lists every file with its SHA-256 checksum, the tool versions and the configuration digests.',
		'',
	].join('\n');
	zip.addBuffer(Buffer.from(summary), 'README.md');

	const manifest = {
		schema: 1,
		generator: `Silicon Studio ${extensionVersion}`,
		generatedAt,
		project: { id: project.config.id, name: project.config.name, top: synth?.project.top ?? project.config.top },
		configDigest: synth?.configDigest,
		inputDigest: synth?.inputDigest,
		pdk: project.config.pdk,
		runs: runs.map(r => ({ id: r.id, kind: r.kind, status: r.status, summary: r.summary, stale: staleness.isStale(r), startedAt: r.startedAt, inputDigest: r.inputDigest, configDigest: r.configDigest, executionTarget: r.executionTarget })),
		tools: [...new Map(runs.flatMap(r => r.steps).map(s => [`${s.tool}|${s.version}|${s.mode}`, { tool: s.tool, version: s.version, mode: s.mode }])).values()],
		warnings,
		files: entries,
		disclaimer: 'Synthesized netlist only; not a signed-off or manufacturing-ready design.',
	};
	zip.addBuffer(Buffer.from(JSON.stringify(manifest, undefined, '\t') + '\n'), 'manifest.json');

	const outDir = path.join(project.root, 'exports');
	fs.mkdirSync(outDir, { recursive: true });
	const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
	const file = path.join(outDir, `${project.config.name.replace(/[^\w.-]+/g, '_')}-${stamp}.zip`);
	await new Promise<void>((resolve, reject) => {
		const stream = fs.createWriteStream(file);
		stream.on('close', () => resolve());
		stream.on('error', reject);
		zip.outputStream.on('error', reject).pipe(stream);
		zip.end();
	});
	return { file, files: entries.length + 2, runs, warnings };
}
