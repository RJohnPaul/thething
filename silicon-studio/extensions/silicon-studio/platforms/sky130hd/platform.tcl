# sky130hd platform metadata for the Silicon Studio physical flow (flow/*.tcl sources this file).
# Values come from OpenROAD-flow-scripts flow/platforms/sky130hd/config.mk at commit 9c43140 (BSD-3-Clause,
# see LICENSE.ORFS); README.md lists the defaults chosen here. platform.json holds the same data for the extension.
set ::plat(dir) [file dirname [file normalize [info script]]]

set ::plat(name)        sky130hd
set ::plat(tech_lef)    $::plat(dir)/lef/sky130_fd_sc_hd.tlef
set ::plat(sc_lef)      [list $::plat(dir)/lef/sky130_fd_sc_hd_merged.lef]
set ::plat(lib)         [list $::plat(dir)/lib/sky130_fd_sc_hd__tt_025C_1v80.lib]
set ::plat(gds)         [list $::plat(dir)/gds/sky130_fd_sc_hd.gds]
set ::plat(site)        unithd
set ::plat(tracks_tcl)  $::plat(dir)/make_tracks.tcl
set ::plat(tapcell_tcl) $::plat(dir)/tapcell.tcl
set ::plat(pdn_tcl)     $::plat(dir)/pdn.tcl
set ::plat(setrc_tcl)   $::plat(dir)/setRC.tcl
set ::plat(rcx_rules)   $::plat(dir)/rcx_patterns.rules
set ::plat(klayout_lyt) $::plat(dir)/sky130hd.lyt
set ::plat(klayout_lyp) $::plat(dir)/sky130hd.lyp
set ::plat(drc_deck)    $::plat(dir)/drc/sky130hd.lydrc
set ::plat(lvs_deck)    $::plat(dir)/lvs/sky130hd.lylvs
set ::plat(cdl)         $::plat(dir)/cdl/sky130hd.cdl

set ::plat(min_routing_layer) met1
set ::plat(max_routing_layer) met5
set ::plat(io_hor_layer)      met3
set ::plat(io_ver_layer)      met2
set ::plat(routing_layer_adjustment) 0.2

set ::plat(cts_buf)       sky130_fd_sc_hd__clkbuf_4
set ::plat(fill_cells)    {sky130_fd_sc_hd__fill_1 sky130_fd_sc_hd__fill_2 sky130_fd_sc_hd__fill_4 sky130_fd_sc_hd__fill_8}
set ::plat(tie_hi_cell)   sky130_fd_sc_hd__conb_1
set ::plat(tie_hi_port)   HI
set ::plat(tie_lo_cell)   sky130_fd_sc_hd__conb_1
set ::plat(tie_lo_port)   LO
set ::plat(min_buf_cell)  sky130_fd_sc_hd__buf_4
set ::plat(min_buf_in)    A
set ::plat(min_buf_out)   X
# Same 36 cells as ORFS DONT_USE_CELLS (probe cells carry metal on every layer; lpflow cells are for multiple
# power domains), as patterns: ABC rejects a read_lib command line that long.
set ::plat(dont_use) {sky130_fd_sc_hd__probe_p_8 sky130_fd_sc_hd__probec_p_8 sky130_fd_sc_hd__lpflow_*}

set ::plat(place_density)    0.60
set ::plat(core_utilization) 40
set ::plat(power_net)        VDD
set ::plat(ground_net)       VSS

set ::plat(latch_map)       $::plat(dir)/cells_latch_hd.v
set ::plat(clkgate_map)     $::plat(dir)/cells_clkgate_hd.v
set ::plat(adder_map)       $::plat(dir)/cells_adders_hd.v
set ::plat(abc_driver_cell) sky130_fd_sc_hd__buf_1
set ::plat(abc_load_in_ff)  5
set ::plat(corner)          tt_025C_1v80
