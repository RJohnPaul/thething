# Clock tree synthesis: 4_place.odb -> 5_cts.odb (clock tree, propagated
# clocks, setup/hold repair, re-legalisation). Adapted from ORFS cts.tcl (BSD-3-Clause).
source [file join [file dirname [info script]] common.tcl]

run_stage cts {
  load_design 4_place.odb

  # Clone clock inverters next to their registers so CTS does not buffer them.
  repair_clock_inverters
  clock_tree_synthesis -sink_clustering_enable -repair_clock_nets \
    -buf_list [knob cts_buf $::plat(cts_buf)]
  tee -quiet -variable cts_report report_cts
  propagate_clocks

  estimate_parasitics -placement
  detailed_placement
  estimate_parasitics -placement
  repair_timing -setup -hold
  detailed_placement
  check_placement -verbose
  estimate_parasitics -placement

  write_checkpoint 5_cts.odb
  regexp {Buffers Inserted: *([0-9]+)} $cts_report -> clock_buffers
  regexp {Sinks: *([0-9]+)} $cts_report -> clock_sinks
  write_metrics [concat [area_metrics] [timing_metrics] [list \
    clock_skew_setup_ns [sta::worst_clock_skew -setup] clock_skew_hold_ns [sta::worst_clock_skew -hold] \
    clock_buffers $clock_buffers clock_sinks $clock_sinks hold_buffers [rsz::hold_buffer_count]]]
  report cts.rpt [concat {report_cts {report_clock_skew -digits 3}} [timing_reports]]
  save_images {cts {{stdcells false} {special_nets false} {net_signal false} {net_power false}}}
}
