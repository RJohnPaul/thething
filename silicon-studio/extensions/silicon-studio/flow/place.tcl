# Placement: 3_pdn.odb -> 4_place.odb (global placement, IO pin optimisation,
# electrical repair, legalisation). Adapted from ORFS global_place_skip_io.tcl,
# io_placement.tcl, global_place.tcl, resize.tcl and detail_place.tcl (BSD-3-Clause).
source [file join [file dirname [info script]] common.tcl]

run_stage place {
  load_design 3_pdn.odb

  # Place cells ignoring IOs, put the pins next to their logic, then place for
  # real. gpl raises a density below the design's uniform density (GPL-0302).
  set density [knob place_density $::plat(place_density)]
  global_placement -skip_io -density $density
  place_io
  buffer_ports
  global_placement -routability_driven -timing_driven -density $density
  set density [expr {max($density, [gpl::get_global_placement_uniform_density])}]

  estimate_parasitics -placement
  repair_design
  detailed_placement
  improve_placement
  optimize_mirroring
  check_placement -verbose
  estimate_parasitics -placement

  write_checkpoint 4_place.odb
  tee -quiet -variable hpwl ord::report_hpwl
  write_metrics [concat [area_metrics] [timing_metrics] [list \
    hpwl_um [string trim $hpwl] place_density $density \
    repair_buffers [rsz::repair_design_buffer_count]]]
  report place.rpt [concat {report_design_area} [timing_reports]]
  save_images {place {{routing false}} place_congestion {{routing false} {rudy true}}}
}
