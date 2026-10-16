# Power planning: 2_floorplan.odb -> 3_pdn.odb with the platform power grid
# (global power/ground connections + pdngen). Adapted from ORFS pdn.tcl (BSD-3-Clause).
source [file join [file dirname [info script]] common.tcl]

run_stage pdn {
  load_design 2_floorplan.odb
  source $::plat(pdn_tcl)
  pdngen

  # The grid checks out when no supply net has floating shapes or unconnected
  # instances (cells are placed later, hence -floorplanning).
  set grid_ok 1
  set shapes 0
  foreach net [[ord::get_db_block] getNets] {
    if {[$net getSigType] ni {POWER GROUND}} { continue }
    foreach swire [$net getSWires] { incr shapes [llength [$swire getWires]] }
    set file [file join $::cfg(report_dir) pdn_[$net getName].rpt]
    if {[catch {check_power_grid -net [$net getName] -floorplanning -error_file $file} err]} {
      puts "\[WARNING FLOW\] power grid check for [$net getName]: $err"
      set grid_ok 0
    }
  }

  write_checkpoint 3_pdn.odb
  write_metrics [concat [area_metrics] [list pdn_shapes $shapes power_grid_ok $grid_ok]]
  report pdn.rpt {report_design_area}
  save_images {pdn {}}
}
