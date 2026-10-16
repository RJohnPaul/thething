# Silicon Studio — running it locally on a Mac

This guide gets Silicon Studio (RTL → synthesis → place & route → GDSII) running on macOS. There are two ways:

- **A. Install the app (DMG).** Fastest; use this to *use* Silicon Studio.
- **B. Run from source.** Use this to *develop* Silicon Studio, or when you have no DMG.

Tested on macOS 15.7, Apple M2 Max (arm64), Node 24.21, Yosys 0.70, Icarus Verilog 13, Verilator 5.052,
OpenROAD (Bazel CI build of commit 1c6ff61) and KLayout DB 0.30.12. Other Apple Silicon Macs should work the same.

Folder layout used below. `nithishprojj` is the parent folder; any name works.

```
nithishprojj/
├── silicon-studio/          ← this repository (the VS Code fork)
├── .tools/                  ← local toolchain: node24/, bin/ (openroad, bazelisk), pyenv/, env.sh, src/OpenROAD
├── dist/                    ← built DMG
└── VSCode-darwin-arm64/     ← built Silicon Studio.app
```

---

## 1. Prerequisites (both ways)

1. **Xcode Command Line Tools** (compilers, `git`, `hdiutil`, `codesign`):

   ```bash
   xcode-select --install
   ```

2. **Homebrew** (<https://brew.sh>), then the front-end EDA tools:

   ```bash
   brew install yosys icarus-verilog verilator
   ```

   Yosys does synthesis, equivalence checking and the DC Shell. Icarus Verilog does simulation. Verilator does lint.
   Without native Yosys, a bundled WebAssembly Yosys still runs synthesis.

3. **KLayout layout engine** (merges the routed layout with the cell layouts into GDSII). It is a Python module, so the
   KLayout desktop app is *not* needed; its Homebrew cask is currently disabled.

   ```bash
   /opt/homebrew/bin/python3 -m venv ~/.silicon-studio/tools/pyenv
   ~/.silicon-studio/tools/pyenv/bin/python3 -m pip install klayout
   ```

   Silicon Studio looks in `~/.silicon-studio/tools/pyenv` automatically. You can also run
   **Silicon Studio: Set Up GDSII Export (KLayout)** inside the app, which runs these two commands for you.

---

## 2A. Install and run the app (DMG)

1. Open `dist/Silicon-Studio-1.141.1-arm64.dmg` and drag **Silicon Studio** onto **Applications**.
2. Start it from Applications or Launchpad. The DMG already contains **OpenROAD**, so place and route works without
   installing anything else.
   - If macOS says the app "cannot be opened", right-click it → **Open** → **Open**. The app is ad-hoc signed for this
     Mac, not notarized.
3. Continue with **[3. First project](#3-first-project)**.

To rebuild the DMG after changing the source, see [5. Building the DMG](#5-building-the-dmg).

---

## 2B. Run from source

### 2B.1 Node 24 and a working Python

VS Code needs exactly the Node major version in `.nvmrc` (24). Install it into `.tools`, which leaves your system Node
alone:

```bash
mkdir -p ../.tools && cd ../.tools
curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep darwin-arm64.tar.gz
```

The last command prints the current file name, e.g. `node-v24.21.0-darwin-arm64.tar.gz`. Download and unpack it:

```bash
curl -fsSLO https://nodejs.org/dist/latest-v24.x/node-v24.21.0-darwin-arm64.tar.gz
tar xzf node-v24.21.0-darwin-arm64.tar.gz && ln -sfn node-v24.21.0-darwin-arm64 node24
```

`brew install node@24` also works; it is keg-only, so put `/opt/homebrew/opt/node@24/bin` first on `PATH`.

Native modules need a Python that works. On some Macs `~/.local/bin/python3` is a broken (empty) file that shadows the
real one, so point the build at Homebrew's Python. Create `../.tools/env.sh` with:

```bash
# Build environment for the Silicon Studio fork: Node 24 (required by .nvmrc) and a working python3.
T=/absolute/path/to/nithishprojj/.tools          # <- change to your path
mkdir -p "$T/bin" && ln -sfn /opt/homebrew/bin/python3 "$T/bin/python3" && ln -sfn /opt/homebrew/bin/python3 "$T/bin/python"
export PATH="$T/bin:$T/node24/bin:$PATH"
export PYTHON="$T/bin/python3"
```

`scripts/silicon-studio.sh` sources `../.tools/env.sh` automatically when it exists. For other locations, set
`SILICON_TOOLS_ENV=/path/to/env.sh`.

### 2B.2 OpenROAD (place and route)

The OpenROAD project ships no macOS binaries, but its Bazel build uses the project's public build cache. A commit that
CI already built therefore downloads instead of compiling (about 4 minutes on Apple Silicon). The result is one
self-contained `openroad` binary that includes the Qt GUI.

```bash
cd ../.tools
curl -fsSL -o bin/bazelisk https://github.com/bazelbuild/bazelisk/releases/latest/download/bazelisk-darwin-arm64
chmod +x bin/bazelisk
git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/The-OpenROAD-Project/OpenROAD.git src/OpenROAD
(cd src/OpenROAD && ../../bin/bazelisk build --//:platform=gui //:openroad)
mkdir -p ~/.silicon-studio/tools/bin && cp -L src/OpenROAD/bazel-bin/openroad ~/.silicon-studio/tools/bin/openroad
~/.silicon-studio/tools/bin/openroad -version
```

Silicon Studio finds `openroad` in any of these places:

- `~/.silicon-studio/tools/bin`
- `extensions/silicon-studio/tools/bin`
- `PATH`
- the setting `siliconStudio.tools.openroadPath`

### 2B.3 Install, compile, launch

From the `silicon-studio/` folder:

```bash
./scripts/silicon-studio.sh setup
```

`setup` runs `npm install` and `npm run compile` and downloads Electron, which takes 5–10 minutes the first time. A
message about built-in extensions failing to download (GitHub rate limit) is harmless.

Then launch the desktop app:

```bash
./scripts/silicon-studio.sh desktop
```

Or run the browser build:

```bash
./scripts/silicon-studio.sh web
```

The browser build serves <http://localhost:9888>. Open that address in Chrome. The in-app browser of some tools lacks
service workers, which the views need.

After editing extension code, recompile just the extension and reload the window (**Developer: Reload Window**):

```bash
npm run gulp compile-extension:silicon-studio
```

---

## 3. First project

1. **File → Open Folder…** on an empty folder. When VS Code asks, choose **Trust**, because Silicon Studio runs tools on
   your files and stays off in Restricted Mode.
2. Click the **chip icon** in the activity bar, then **New Project** → *Current folder*. This creates a PWM design with a
   self-checking testbench, an SDC and a `silicon.json` set up for the **nangate45** platform with three floorplan
   scenarios.
3. **Silicon Studio: Show Engine Status** should list `yosys`, `iverilog`, `vvp`, `verilator`, `openroad` and `klayout`.
4. Run the flow from the **Flow** view (or the Command Palette, ⇧⌘P):

   | Step | Command | Result |
   | --- | --- | --- |
   | Lint | *Run Lint* | Problems panel |
   | Simulate | *Run Simulation* | PASS/FAIL + waveform viewer |
   | Synthesize | *Synthesize (Yosys + ABC)* | nangate45 netlist, report, schematics |
   | Equivalence | *Check Equivalence* | RTL ↔ netlist proof |
   | Place & route | *Run Place & Route (Netlist → GDSII)* | floorplan → power grid → placement → clock tree → routing → signoff timing/power → `6_final.gds` |
   | Everything | *Run Flow* | all of the above in order |

   For the template, place and route takes about 10 seconds and reports 0 DRC violations and +7.7 ns setup slack.
5. Inspect the results:
   - **Open Physical Design Report**: per-stage metrics, layout snapshots, timing and power reports.
   - **Open Layout Viewer**: interactive layers, zoom, pan, selection, net highlighting and search.
   - **Open in OpenROAD GUI**: the full Qt layout browser.
   - **Reveal GDSII File**: `6_final.gds` in Finder.
6. **Explore Floorplan Scenarios…** runs the scenarios from `silicon.json` and compares them side by side.
   **Select Floorplan Scenario…** picks the one that **Run Place & Route** uses.
7. **Export Handoff Bundle** zips the sources, netlist, GDSII, DEF, SPEF, reports and run manifests (with checksums)
   into `exports/`.

### Synopsys-style shells

Open them from the terminal panel's **+ ▾** menu as **DC Shell / ICC2 Shell / PrimeTime Shell (Silicon Studio)**, from the
Flow view's **…** menu, or with **Run Tcl Script in Shell…** on a `.tcl` file:

```tcl
dc_shell>   analyze -format verilog {rtl/counter.v rtl/comparator.v rtl/pwm.v}
dc_shell>   elaborate pwm -parameters "WIDTH=8"
dc_shell>   create_clock -period 10 [get_ports clk]
dc_shell>   compile_ultra
dc_shell>   report_area ; report_timing ; write -format verilog -output pwm_netlist.v
icc2_shell> create_lib pwm_lib ; read_verilog pwm_netlist.v ; link_block ; read_sdc constraints/pwm.sdc
icc2_shell> initialize_floorplan -core_utilization 0.4 ; compile_pg ; place_opt ; clock_opt ; route_auto
icc2_shell> report_qor ; write_gds pwm.gds
```

When `silicon.json` names a platform, the shells pick up its libraries automatically. Type `help` for the command list.

---

## 4. Running the tests

```bash
./scripts/silicon-studio.sh test
```

This compiles the extension and runs every self-check against the real tools: parsers, grammar, waveforms, schematic,
synthesis, the full place-and-route flow on nangate45, the layout export and the three shells. It takes about 40 s. To
exercise SkyWater 130 nm too:

```bash
cd extensions/silicon-studio && PLATFORM=sky130hd node test/pnr.test.js
```

---

## 5. Building the DMG

```bash
./scripts/silicon-studio.sh dmg
```

This packages the minified app into `../VSCode-darwin-arm64/Silicon Studio.app` (about 4 minutes) and copies `openroad`
into it. It then ad-hoc signs the app and writes `../dist/Silicon-Studio-<version>-arm64.dmg` with `hdiutil`. The DMG runs
on this Mac; distributing it to other Macs needs an Apple Developer ID and notarization.

---

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `*** Please use Node.js v24.x` during `npm install` | Node on `PATH` is not 24: source `../.tools/env.sh` (step 2B.1). |
| `gyp ERR! find Python` | `PYTHON` / `python3` points at a broken file. Use the `env.sh` from step 2B.1. |
| Silicon Studio view says "no data provider" / commands do nothing | The folder is in **Restricted Mode**: click it in the status bar → **Trust**. |
| Flow view shows "openroad not installed" | Install OpenROAD (step 2B.2) or set `siliconStudio.tools.openroadPath`, then **Show Engine Status**. |
| Run summary says "GDSII not written" | Install the KLayout module (prerequisite 3) or run **Set Up GDSII Export (KLayout)**. |
| Place & route is *inconclusive*: "no clock constrains the design" | Add `create_clock` to an SDC listed in `silicon.json` → `constraints`. |
| Place & route is *failed*: "Timing not met" | The GDSII is still written. Relax the clock, lower `utilization`, or look at the timing report. |
| Webviews (waveform, layout, report) are blank in the browser build | Use Chrome or Safari. The page must be served from `localhost`/`127.0.0.1`, because webviews load from `*.localhost`. |
| `Address already in use` for the web build | Another server holds port 9888: `PORT=9890 ./scripts/silicon-studio.sh web`. |
| "Could not be opened" on first launch of the DMG app | Right-click → **Open** (ad-hoc signature). |

The output panel **Silicon Studio** shows every tool command and its log. Each run's logs, inputs and outputs are under
`.silicon/runs/<run-id>/` in the project.
