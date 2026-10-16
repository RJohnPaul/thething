## Synthesize with Yosys + ABC

The generated script (`outputs/synth.ys`) runs `synth`, then maps to the liberty library with `dfflibmap` and `abc -liberty`. It writes:

- `netlist.v`, the gate-level Verilog netlist,
- `netlist.json` for the schematic viewer,
- generic gate counts and mapped standard-cell area, reported separately.

Without a native Yosys install, the bundled **WebAssembly** build runs instead (setting `siliconStudio.yosys.engine`).
