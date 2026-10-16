# Floorplan: netlist -> 2_floorplan.odb (die/core, rows, tracks, IO pins,
# placement blockages, tap cells). Adapted from ORFS floorplan.tcl,
# io_placement.tcl and tapcell.tcl (BSD-3-Clause).
source [file join [file dirname [info script]] common.tcl]

run_stage floorplan {
  load_design

  set margin [knob core_margin 2]
  set die [knob die_area]
  if {$die ne ""} {
    lassign $die x0 y0 x1 y1
    set core [knob core_area [list [expr {$x0 + $margin}] [expr {$y0 + $margin}] \
      [expr {$x1 - $margin}] [expr {$y1 - $margin}]]]
    initialize_floorplan -die_area $die -core_area $core -site $::plat(site)
  } else {
    initialize_floorplan -utilization [knob utilization $::plat(core_utilization)] \
      -aspect_ratio [knob aspect_ratio 1] -core_space $margin -site $::plat(site)
  }
  source $::plat(tracks_tcl)

  # Spread the single tie cells from synthesis, then drop synthesis buffers.
  foreach {cell port} [list $::plat(tie_lo_cell) $::plat(tie_lo_port) $::plat(tie_hi_cell) $::plat(tie_hi_port)] {
    set lib [get_name [get_property [lindex [get_lib_cells */$cell] 0] library]]
    repair_tie_fanout -separation 0 $lib/$cell/$port
  }
  remove_buffers

  place_io
  set block [ord::get_db_block]
  set stdcells [llength [$block getInsts]]
  foreach box [knob blockages] { create_blockage -region $box }
  source $::plat(tapcell_tcl)

  write_checkpoint 2_floorplan.odb
  write_metrics [concat [area_metrics] [list stdcell_count $stdcells \
    tapcell_count [expr {[llength [$block getInsts]] - $stdcells}] \
    io_pins [llength [$block getBTerms]] rows [llength [$block getRows]] \
    blockages [llength [$block getBlockages]]]]
  report floorplan.rpt {report_design_area report_units}
  save_images {floorplan {{rows true}}}
}
