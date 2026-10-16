# Routing: 5_cts.odb -> 6_route.odb (global route, antenna repair, detailed
# route with DRC report, filler cells). Adapted from ORFS global_route.tcl,
# detail_route.tcl and fillcell.tcl (BSD-3-Clause).
source [file join [file dirname [info script]] common.tcl]

run_stage route {
  load_design 5_cts.odb
  propagate_clocks

  pin_access
  tee -variable grt_log [list global_route -congestion_iterations 30 -verbose \
    -congestion_report_file [file join $::cfg(report_dir) 6_route_congestion.rpt]]
  repair_antennas -iterations 5
  check_antennas -report_file [file join $::cfg(report_dir) 6_grt_antennas.rpt]

  set drt_args [list -output_drc [file join $::cfg(report_dir) 6_route_drc.rpt] -verbose 1]
  if {[knob drt_iterations] ne ""} { lappend drt_args -droute_end_iter $::cfg(drt_iterations) }
  tee -variable drt_log [list detailed_route {*}$drt_args]
  # Diodes/jumpers for antennas found on the real routes, then route again.
  for {set i 0} {$i < 5 && [check_antennas]} {incr i} {
    repair_antennas
    tee -variable drt_log [list detailed_route {*}$drt_args]
  }
  set antennas [check_antennas -report_file [file join $::cfg(report_dir) 6_route_antennas.rpt]]
  if {![design_is_routed]} { error "design has unrouted nets" }

  filler_placement $::plat(fill_cells)
  check_placement
  global_connect

  write_checkpoint 6_route.odb
  # Last value of each summary line ("" when absent); the GRT congestion line
  # is "Total <resource> <demand> <usage%> <maxH> / <maxV> / <overflow>".
  set overflow [lindex [regexp -all -inline -line {^Total\s.*/\s*(\d+)\s*$} $grt_log] end]
  set wirelength [lindex [regexp -all -inline {Total wire length = ([0-9.]+) um} $drt_log] end]
  set vias [lindex [regexp -all -inline {Total number of vias = (\d+)} $drt_log] end]
  write_metrics [concat [area_metrics] [list wirelength_um $wirelength vias $vias \
    grt_overflow $overflow drc_violations [detailed_route_num_drvs] antenna_violations $antennas]]
  report route.rpt {report_design_area {report_wire_length -net * -summary}}
  save_images {route {} route_congestion {{rudy true}} route_clock {{stdcells false} {special_nets false} {net_signal false} {net_power false}}}
}
