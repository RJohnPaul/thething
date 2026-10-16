# Finish / signoff-style reports: 6_route.odb -> 6_final.{odb,def,v,sdc,spef}.
# OpenRCX extraction, then STA on the extracted parasitics: setup/hold, power,
# area. Adapted from ORFS final_report.tcl and report_metrics.tcl (BSD-3-Clause).
source [file join [file dirname [info script]] common.tcl]

# Fill, tap, endcap and diode cells: layout only, left out of the netlist.
proc physical_only_masters {} {
  set names {}
  foreach lib [[ord::get_db] getLibs] {
    foreach master [$lib getMasters] {
      if {[regexp {^(CORE_SPACER|CORE_WELLTAP|CORE_ANTENNACELL|ENDCAP)} [$master getType]]
          || [get_lib_cells -quiet */[$master getName]] eq ""} {
        lappend names [$master getName]
      }
    }
  }
  return $names
}

# Highest clock frequency every constrained clock still meets, in MHz.
proc fmax_mhz {} {
  set fmax ""
  foreach clk [all_clocks] {
    set period [sta::find_clk_min_period $clk 1]
    if {$period <= 0} { continue }
    set f [expr {1e-6 / $period}]
    if {$fmax eq "" || $f < $fmax} { set fmax $f }
  }
  return $fmax
}

run_stage finish {
  load_design 6_route.odb
  propagate_clocks
  set out $::cfg(out_dir)

  write_db $out/6_final.odb
  write_def $out/6_final.def
  write_verilog -remove_cells [physical_only_masters] $out/6_final.v
  write_sdc -no_timestamp $out/6_final.sdc

  define_process_corner -ext_model_index 0 X
  set_extraction_rules_file $::plat(rcx_rules)
  extract_parasitics
  # write_spef takes the raw $args list as its file name, so a path with a space breaks: write from out_dir.
  set cwd [pwd]
  cd $out
  try { write_spef 6_final.spef } finally { cd $cwd }
  read_spef $out/6_final.spef

  # internal, switching, leakage, total in W
  lassign [sta::design_power [sta::cmd_scene]] internal switching leakage total
  write_metrics [concat [area_metrics] [timing_metrics] [list \
    clock_skew_setup_ns [sta::worst_clock_skew -setup] fmax_mhz [fmax_mhz] \
    power_total_mw [expr {$total * 1e3}] power_internal_mw [expr {$internal * 1e3}] \
    power_switching_mw [expr {$switching * 1e3}] power_leakage_mw [expr {$leakage * 1e3}] \
    max_slew_violations [sta::max_slew_violation_count] \
    max_cap_violations [sta::max_capacitance_violation_count] \
    max_fanout_violations [sta::max_fanout_violation_count]]]
  report finish.rpt [concat [timing_reports] {
    {report_clock_skew -digits 3}
    {report_clock_min_period -include_port_paths}
    {report_power -digits 4}
    report_design_area
    report_cell_usage
  }]
  if {[catch {web_save_report [file join $::cfg(report_dir) 6_final_timing.html]} err]} {
    puts "\[WARNING FLOW\] HTML timing report skipped: $err"
  }
  save_images {finish {} finish_placement {{routing false} {special_nets false}}}
}
