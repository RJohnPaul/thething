# nangate45 platform

Nangate Open Cell Library (PDKv1.3_v2010_12) on the FreePDK45 45 nm generic process: a research library for exploring
EDA flows. It is deliberately **not manufacturable**.

## Origin and licenses

Vendored from [OpenROAD-flow-scripts](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts)
`flow/platforms/nangate45` at commit `9c43140` (9c431405a71909ca9aa5b9000d3d11fa36b2a32a).

- Library data (LEF, Liberty, GDS, KLayout files): Apache License 2.0, see `LICENSE`. Originally downloaded by ORFS
  from https://projects.si2.org/openeda.si2.org/project/showfiles.php?group_id=63#503; ORFS regenerated the LEF
  abstracts from the GDS, fixed the poly contact enclosure of `AOI21_X1` (rule CONTACT.5) and added the flow files.
- ORFS flow scripts (`make_tracks.tcl`, `tapcell.tcl`, `grid_strategy-M1-M4-M7.tcl`, `setRC.tcl`, `cells_*.v`):
  BSD 3-Clause, see `LICENSE.ORFS`.

## Files

| File | Used for |
| --- | --- |
| `lef/NangateOpenCellLibrary.tech.lef`, `lef/NangateOpenCellLibrary.macro.mod.lef` | technology and cell abstracts |
| `lib/NangateOpenCellLibrary_typical.lib` | timing/power, typical corner (synthesis and STA) |
| `gds/NangateOpenCellLibrary.gds` | cell layouts merged into the final GDS |
| `make_tracks.tcl`, `tapcell.tcl`, `grid_strategy-M1-M4-M7.tcl`, `setRC.tcl` | floorplan tracks, tap/endcap cells, power grid, layer RC |
| `rcx_patterns.rules` | OpenRCX parasitic extraction rules |
| `FreePDK45.lyt`, `FreePDK45.lyp`, `drc/FreePDK45.lydrc` | KLayout technology (DEF to GDS layer map), layer colours, DRC deck |
| `cells_latch.v`, `cells_clkgate.v`, `cells_adders.v` | Yosys latch, clock-gate and full/half-adder mapping |
| `platform.tcl`, `platform.json` | the platform metadata the flow reads (same data twice: Tcl for OpenROAD, JSON for the extension) |

Dropped from the ORFS directory because the Silicon Studio flow does not use them: `config.mk` (its values are in
`platform.tcl`/`platform.json`), `fastroute.tcl` (folded into the routing-layer settings), the CDL netlist (ORFS ships
no nangate45 LVS deck, so `lvs_deck` and `cdl` are empty), FakeRAM, Magic, IR-drop template and the extra corners.

## Local patches

- `tapcell.tcl`: the cell name `TAPCELL_X1` replaces `$::env(TAP_CELL_NAME)`.
- `grid_strategy-M1-M4-M7.tcl`: the metal4/metal7 strap pitches and offsets are multiplied by `::pdn_scale`
  (1.0 = ORFS values), which drops below 1 on a core too small for the ORFS pitches (PDNGen error PDN-0185); values are
  rounded to 0.01 um to stay on the manufacturing grid. ORFS solves this per design (its `gcd` halves the pitches).
- `grid_strategy-M1-M4-M7.tcl`: the two macro grids are removed. The flow places no macros, and PDNGen checks their
  metal5/metal6 pitches against the core even when no macro exists.

## Values in platform.tcl / platform.json

Taken from ORFS `config.mk`: LEF/lib/GDS, site, IO layers (metal5/metal6), routing layers metal2-metal10, fill cells,
tie cells, minimum buffer, dont-use cells, place density 0.30, Yosys map files, ABC driver/load, KLayout files, RCX rules.
Chosen here (not in `config.mk`):

- `cts_buf` = `CLKBUF_X3`: ORFS lets CTS pick buffers; this is the cell the OpenROAD CTS regression tests use.
- `core_utilization` = 25 %: ORFS leaves it to each design; it stays below the 0.30 place density so placement works
  with the platform defaults.
- `routing_layer_adjustment` = 0.5: ORFS `fastroute.tcl` uses 0.5 on metal2-metal3 and 0.25 above; one value (the ORFS
  default) is applied to all routing layers.
- `power_net`/`ground_net` = VDD/VSS (the net names in the PDN script), `corner` = `typical` (the bundled Liberty).
