# Silicon Studio

Silicon Studio is a fork of VS Code 1.141.1 customized into a digital chip design environment. You write
Verilog/SystemVerilog, lint and simulate it, and **synthesize it with Yosys + ABC**. **OpenROAD** then takes the netlist
through floorplanning, power planning, placement, clock-tree synthesis, routing and signoff-style timing/power to a
**GDSII layout**. Synopsys-style shells (DC, ICC2, PrimeTime) sit on top of the open tools. Every result is reproducible
and can be exported as a handoff bundle.

It runs as a desktop app (Electron) and in the browser (`web` mode, served by this machine).

## Run it

Step-by-step setup on a Mac (prerequisites, toolchain, first project, troubleshooting): **[STARTUP.md](STARTUP.md)**.


```bash
./scripts/silicon-studio.sh setup      # once: npm install + compile (needs Node 24 and python3)
./scripts/silicon-studio.sh desktop    # desktop app
./scripts/silicon-studio.sh web        # browser build at http://localhost:9888
./scripts/silicon-studio.sh test       # extension self-checks (real tools)
./scripts/silicon-studio.sh dmg        # macOS app + ../dist/Silicon-Studio-<version>-<arch>.dmg (ad-hoc signed, bundles OpenROAD)
```

### Engines

| Tool | Used for | How to get it |
| --- | --- | --- |
| Yosys + ABC | elaboration, synthesis, equivalence, DC Shell | `brew install yosys`. Without it, the bundled WebAssembly build ([YoWASP](https://yowasp.org)) runs synthesis and equivalence |
| Verilator / Icarus Verilog | lint, simulation | `brew install verilator icarus-verilog` |
| OpenROAD | floorplan → PDN → place → CTS → route → RCX/STA/power, ICC2 and PrimeTime shells | bundled in the DMG, or `siliconStudio.tools.openroadPath`. Built from the official sources with Bazel (see below) |
| KLayout DB (Python) | merging the routed DEF with cell GDS into GDSII | **Silicon Studio: Set Up GDSII Export (KLayout)** installs `pip install klayout` into `~/.silicon-studio/tools/pyenv` |

**Silicon Studio: Show Engine Status** lists what each job will use.

**Building OpenROAD.** Clone `The-OpenROAD-Project/OpenROAD` and run `bazelisk build --//:platform=gui //:openroad`. The
repo's default `.bazelrc` uses the project's anonymous build cache, so a CI-built commit downloads instead of compiling
(about 4 minutes on Apple Silicon). The result is one statically linked `openroad` binary that includes the Qt GUI.

## The flow

The **Silicon Studio** activity bar has three views:

- **Flow** is the stage navigator (PRD §6.2). It covers ten stages:
  1. RTL & verification
  2. Synthesis
  3. Floorplanning
  4. Power planning
  5. Placement
  6. Clock-tree synthesis
  7. Routing
  8. Extraction & timing
  9. Physical verification
  10. Final export

  Each physical stage shows its status and one headline number, and has **Run through this stage** and **Open layout**.
- **Design Hierarchy** shows the elaborated module tree.
- **Run History** lists every run with its inputs, outputs, logs and manifest. Runs can be reproduced, compared and opened.

| Step | Engine | What you get |
| --- | --- | --- |
| Lint | Verilator `--lint-only -Wall` (else Icarus), then a Yosys elaboration | Problems with file/line/column; severity overrides; lint on save |
| Simulate | `iverilog -g2012` + `vvp` | PASS / FAIL / inconclusive verdict; VCD waveform viewer |
| Synthesize | Yosys + ABC mapped to the platform cells (ORFS-style: adder/latch maps, `dfflibmap`, `abc -D <clock>`, tie cells, buffers) | `netlist.v`, generic vs. mapped area, schematics, report |
| Equivalence | Yosys `equiv_*` induction + a bounded miter `sat -seq 20` from reset | *proven*, *not equivalent* (counterexample), *bounded only*, *inconclusive* |
| Floorplan | `initialize_floorplan` (utilization/aspect ratio or fixed die/core), tracks, IO placement (side constraints), blockages, tap cells | `2_floorplan.odb`, die/core/utilization metrics, image |
| Power planning | platform PDN (`pdngen`), `check_power_grid` | `3_pdn.odb`, grid check |
| Placement | `global_placement` (timing/routability driven), `repair_design`, `detailed_placement` | `4_place.odb`, HPWL, slack, density and congestion images |
| CTS | `clock_tree_synthesis`, propagated clocks, `repair_timing -setup -hold` | `5_cts.odb`, skew, buffers, clock-tree image |
| Routing | `global_route`, antenna repair, `detailed_route` (TritonRoute), fillers | `6_route.odb`, wirelength, vias, overflow, **DRC count** |
| Signoff | OpenRCX extraction → SPEF, STA on extracted parasitics, power, fmax | `6_final.{odb,def,v,sdc,spef}`, timing/power/area reports, HTML timing report |
| GDSII | KLayout DB merges the DEF with the cell GDS | `6_final.gds` |
| Export | built-in | zip with sources, netlist, `physical/` (GDS, DEF, SPEF, reports, images), run manifests and SHA-256 `manifest.json` |

- **Run Place & Route** runs every stage. **Run Through Stage…** stops early. **Re-run From Stage…** starts from a previous
  run's checkpoint, so only the changed stages run again.
- **Explore Floorplan Scenarios** runs several floorplans and compares them in one table:
  - die area
  - utilization
  - HPWL
  - skew
  - wirelength
  - DRC count
  - slack
  - power

  Floorplan and placement images appear side by side, with the best value in each row highlighted.
- **Layout Viewer** is the in-app layout window. It offers layers, zoom and pan, selection, net highlighting and search,
  and jumps from a selection to the netlist. **Open in OpenROAD GUI** opens the full Qt layout browser.

Each run snapshots its inputs into `.silicon/runs/<id>/inputs/` before the tools start, and records tool versions, command
lines and digests. When sources or physical settings change, results are marked **stale**. Any run can be reproduced from
its snapshot.

### Measured on this Mac (Apple M2 Max)

| Design / platform | Result | Wall time |
| --- | --- | --- |
| PWM template, nangate45 | 24 × 24 µm, 34.5 % utilization, 0 DRC, +7.74 ns slack (fmax 443 MHz), 0.018 mW, equivalence proven | ~10 s |
| PWM template, sky130hd | 0 DRC, +6.35 ns slack (fmax 274 MHz), 0.079 mW | ~12 s |
| ORFS `gcd`, nangate45 | 36.6 × 36.6 µm, 842 instances, 2,839 µm wire, 0 DRC, −0.58 ns at ORFS's 0.25 ns clock | ~20 s P&R |

## Synopsys-style shells

Open them from the terminal **+** menu (**DC Shell / ICC2 Shell / PrimeTime Shell (Silicon Studio)**), from the Flow view
menu, or with **Run Tcl Script in Shell…** on a `.tcl` file. Tcl/SDC files get syntax highlighting.

- **DC Shell** (`dc_shell>`, on Yosys) accepts:
  - `set_app_var`
  - `analyze` / `elaborate`
  - SDC (`create_clock`, `set_input_delay`…)
  - `compile` / `compile_ultra`
  - `report_area` / `report_qor` / `report_cell` / `report_reference`
  - `report_timing` / `report_power` (through OpenSTA)
  - `write -format verilog`, `write_sdc`
- **ICC2 Shell** (`icc2_shell>`, on OpenROAD) accepts:
  - `create_lib` / `open_lib`, `read_verilog`, `link_block`
  - `initialize_floorplan -core_utilization -side_ratio -core_offset`
  - `compile_pg`
  - `place_opt` / `clock_opt` / `route_auto` / `route_opt`
  - `check_routes`, `create_stdcell_fillers`
  - `report_qor` / `report_timing`
  - `write_def` / `write_gds` / `save_block`, `gui_start`
- **PrimeTime Shell** (`pt_shell>`, on OpenSTA) accepts:
  - `read_parasitics`, `update_timing`
  - `report_timing -delay_type`, `report_global_timing`
  - `report_constraint -all_violators`
  - `report_clock` / `report_power`

These are command-compatible front ends that print reports in the same spirit. They are not Synopsys tools, and results
come from the open engines.

## Project file (`silicon.json`)

The template ("New Project…") is a PWM generator with a self-checking testbench and SDC, set up for nangate45 with three
floorplan scenarios:

```json
{
	"name": "pwm", "top": "pwm", "sources": ["rtl"], "parameters": { "WIDTH": 8 },
	"testbench": { "sources": ["tb/pwm_tb.v"], "top": "pwm_tb" },
	"constraints": ["constraints/pwm.sdc"],
	"physical": {
		"platform": "nangate45",
		"utilization": 30, "aspectRatio": 1, "coreMargin": 2,
		"scenarios": [
			{ "name": "util30-square", "utilization": 30, "aspectRatio": 1 },
			{ "name": "util55-square", "utilization": 55, "aspectRatio": 1 },
			{ "name": "util40-wide", "utilization": 40, "aspectRatio": 0.5,
			  "pinConstraints": [{ "side": "left", "pins": ["clk", "rst", "en"] }, { "side": "right", "pins": ["out"] }] }
		]
	}
}
```

A fixed die is another scenario, e.g. `{ "name": "fixed-die", "dieArea": [0, 0, 60, 60], "coreArea": [5, 5, 55, 55] }`
(microns). Other physical knobs:

- `placeDensity`
- `blockages`
- `activeScenario`
- `minRoutingLayer` / `maxRoutingLayer`
- `ctsBuffer`

Without `physical`, synthesis maps to `synthesis.liberty` (or generic gates) and stops at the netlist.

### Platforms (`extensions/silicon-studio/platforms`)

| Platform | Process | Cells | Notes |
| --- | --- | --- | --- |
| `nangate45` | FreePDK45 (45 nm, predictive) | Nangate Open Cell Library | fast, small; good for learning and exploration |
| `sky130hd` | SkyWater SKY130 (130 nm, real open PDK) | `sky130_fd_sc_hd` | KLayout DRC/LVS decks included (need the KLayout app) |

Both platforms are vendored from OpenROAD-flow-scripts (commit 9c43140). Each platform's README lists its local patches;
licenses are in each directory.

## What changed relative to VS Code

- `extensions/silicon-studio/` is the new built-in extension:
  - `src/`: flows, views, webviews, export.
  - `flow/`: OpenROAD stage scripts, adapted from ORFS (BSD-3), plus the GDS merge and the layout export.
  - `shells/`: the DC, ICC2 and PrimeTime front ends.
  - `platforms/`: the two PDK platforms.
  - `media/`: the waveform, schematic and layout viewers.
  - `test/`: the self-checks.
- `build/gulpfile.extensions.ts`, `build/npm/dirs.ts`: register the extension.
- `build/lib/copilot.ts`: packaging skips a Copilot SDK step that does not apply to the pinned package version.
- `product.json`: rebranded; webview CDN template removed. `src/vs/platform/product/common/product.ts`: dev-build name.
- `src/vs/server/node/webClientServer.ts`: webview content is served from this server (`{{uuid}}.localhost`) instead of
  `vscode-cdn.net`.

## Security model

- Silicon Studio runs only in **trusted** workspaces.
- Tools run without a shell, against snapshot copies, with timeouts.
- Paths that resolve outside the project are rejected, symlinks included.
- Generated Tcl and Yosys scripts reject braces, backslashes, newlines and `#` in user values.
- `synthesis.extraCommands` accepts only an allowlist of Yosys optimization and reporting passes.
- Webviews use a nonce-based CSP, and SVG, VCD and layout content is sanitized or escaped.

## Limitations

- **Not signoff.** Routing DRC is the detailed router's rule check against the tech LEF. The foundry DRC/LVS decks need
  the KLayout desktop app, whose Homebrew cask is currently disabled, so the flow view lists them as *unavailable*.
  Timing uses one liberty corner. A generated GDSII is not manufacturing-ready.
- No macros/SRAMs, multi-corner analysis or DFT yet. AI assistance, cloud job queues and multi-user projects are later PRD
  phases.
- Simulation needs a native Icarus Verilog install. FST waveforms are not supported (dump VCD instead).
- The DMG is ad-hoc signed and runs on this Mac. Sharing it needs an Apple Developer ID and notarization.
