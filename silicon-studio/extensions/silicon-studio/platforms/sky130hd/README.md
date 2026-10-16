# sky130hd platform

SkyWater SKY130 130 nm open-source process with the high-density standard-cell library `sky130_fd_sc_hd`, typical
corner (tt, 25 C, 1.80 V).

## Origin and licenses

Vendored from [OpenROAD-flow-scripts](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts)
`flow/platforms/sky130hd` at commit `9c43140` (9c431405a71909ca9aa5b9000d3d11fa36b2a32a).

- Library and PDK data (LEF, Liberty, GDS, CDL, KLayout files): Copyright 2020 The SkyWater PDK Authors, Apache
  License 2.0 (see `LICENSE`; upstream https://github.com/google/skywater-pdk).
- ORFS flow scripts (`make_tracks.tcl`, `tapcell.tcl`, `pdn.tcl`, `setRC.tcl`, `cells_*_hd.v`): BSD 3-Clause, see
  `LICENSE.ORFS`.
- `rcx_patterns.rules` is a symbolic link to `../sky130hs/rcx_patterns.rules` in ORFS; the file itself is copied here.

## Files

| File | Used for |
| --- | --- |
| `lef/sky130_fd_sc_hd.tlef`, `lef/sky130_fd_sc_hd_merged.lef` | technology and cell abstracts |
| `lib/sky130_fd_sc_hd__tt_025C_1v80.lib` | timing/power, typical corner (synthesis and STA) |
| `gds/sky130_fd_sc_hd.gds` | cell layouts merged into the final GDS |
| `make_tracks.tcl`, `tapcell.tcl`, `pdn.tcl`, `setRC.tcl` | floorplan tracks, tap cells, power grid, layer RC |
| `rcx_patterns.rules` | OpenRCX parasitic extraction rules |
| `sky130hd.lyt`, `sky130hd.lyp` | KLayout technology (DEF to GDS layer map) and layer colours |
| `drc/sky130hd.lydrc`, `lvs/sky130hd.lylvs`, `cdl/sky130hd.cdl` | KLayout DRC and LVS decks, cell netlists for LVS |
| `cells_latch_hd.v`, `cells_clkgate_hd.v`, `cells_adders_hd.v` | Yosys latch, clock-gate and full/half-adder mapping |
| `platform.tcl`, `platform.json` | the platform metadata the flow reads (same data twice: Tcl for OpenROAD, JSON for the extension) |

Dropped from the ORFS directory because the Silicon Studio flow does not use them: `config.mk` (its values are in
`platform.tcl`/`platform.json`), `fastroute.tcl` (folded into the routing-layer settings), `fill.json` (metal density
fill), the IO-pad LEF/Liberty and the IR-drop template.

## Local patches

- `tapcell.tcl`: the cell name `sky130_fd_sc_hd__tapvpwrvgnd_1` replaces `$::env(TAP_CELL_NAME)`.
- `pdn.tcl`: the met4/met5 strap pitches and offsets are multiplied by `::pdn_scale` (1.0 = ORFS values), which drops
  below 1 on a core too small for the ORFS pitches (PDNGen error PDN-0185); values are rounded to 0.01 um to stay on
  the manufacturing grid.

## Values in platform.tcl / platform.json

Taken from ORFS `config.mk`: LEF/lib/GDS, site `unithd`, IO layers (met3/met2), routing layers met1-met5, fill cells,
tie cells (`conb_1` HI/LO), minimum buffer (`buf_4`), place density 0.60, Yosys map files, ABC driver/load, KLayout
files, RCX rules, `routing_layer_adjustment` 0.2 (from `fastroute.tcl`). Chosen here (not in `config.mk`):

- `dont_use` lists the 36 ORFS cells as the patterns `sky130_fd_sc_hd__probe_p_8`, `sky130_fd_sc_hd__probec_p_8`,
  `sky130_fd_sc_hd__lpflow_*` (the Liberty has exactly those lpflow cells): with all 36 names ABC rejects its
  `read_lib` command line and synthesis fails.
- `cts_buf` = `sky130_fd_sc_hd__clkbuf_4`: ORFS lets CTS pick buffers; this is the usual SKY130 clock buffer.
- `core_utilization` = 40 %: ORFS leaves it to each design (its `gcd` uses 38); it stays below the 0.60 place density.
- `power_net`/`ground_net` = VDD/VSS (the net names in the PDN script), `corner` = `tt_025C_1v80` (the bundled Liberty).
