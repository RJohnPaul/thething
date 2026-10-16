# nangate45 platform metadata for the Silicon Studio physical flow (flow/*.tcl sources this file).
# Values come from OpenROAD-flow-scripts flow/platforms/nangate45/config.mk at commit 9c43140 (BSD-3-Clause,
# see LICENSE.ORFS); README.md lists the defaults chosen here. platform.json holds the same data for the extension.
set ::plat(dir) [file dirname [file normalize [info script]]]

set ::plat(name)        nangate45
set ::plat(tech_lef)    $::plat(dir)/lef/NangateOpenCellLibrary.tech.lef
set ::plat(sc_lef)      [list $::plat(dir)/lef/NangateOpenCellLibrary.macro.mod.lef]
set ::plat(lib)         [list $::plat(dir)/lib/NangateOpenCellLibrary_typical.lib]
set ::plat(gds)         [list $::plat(dir)/gds/NangateOpenCellLibrary.gds]
set ::plat(site)        FreePDK45_38x28_10R_NP_162NW_34O
set ::plat(tracks_tcl)  $::plat(dir)/make_tracks.tcl
set ::plat(tapcell_tcl) $::plat(dir)/tapcell.tcl
set ::plat(pdn_tcl)     $::plat(dir)/grid_strategy-M1-M4-M7.tcl
set ::plat(setrc_tcl)   $::plat(dir)/setRC.tcl
set ::plat(rcx_rules)   $::plat(dir)/rcx_patterns.rules
set ::plat(klayout_lyt) $::plat(dir)/FreePDK45.lyt
set ::plat(klayout_lyp) $::plat(dir)/FreePDK45.lyp
set ::plat(drc_deck)    $::plat(dir)/drc/FreePDK45.lydrc
set ::plat(lvs_deck)    ""
set ::plat(cdl)         ""

set ::plat(min_routing_layer) metal2
set ::plat(max_routing_layer) metal10
set ::plat(io_hor_layer)      metal5
set ::plat(io_ver_layer)      metal6
set ::plat(routing_layer_adjustment) 0.5

set ::plat(cts_buf)       CLKBUF_X3
set ::plat(fill_cells)    {FILLCELL_X1 FILLCELL_X2 FILLCELL_X4 FILLCELL_X8 FILLCELL_X16 FILLCELL_X32}
set ::plat(tie_hi_cell)   LOGIC1_X1
set ::plat(tie_hi_port)   Z
set ::plat(tie_lo_cell)   LOGIC0_X1
set ::plat(tie_lo_port)   Z
set ::plat(min_buf_cell)  BUF_X1
set ::plat(min_buf_in)    A
set ::plat(min_buf_out)   Z
set ::plat(dont_use)      {TAPCELL_X1 FILLCELL_X1 AOI211_X1 OAI211_X1}

set ::plat(place_density)    0.30
set ::plat(core_utilization) 25
set ::plat(power_net)        VDD
set ::plat(ground_net)       VSS

set ::plat(latch_map)       $::plat(dir)/cells_latch.v
set ::plat(clkgate_map)     $::plat(dir)/cells_clkgate.v
set ::plat(adder_map)       $::plat(dir)/cells_adders.v
set ::plat(abc_driver_cell) BUF_X1
set ::plat(abc_load_in_ff)  3.898
set ::plat(corner)          typical
