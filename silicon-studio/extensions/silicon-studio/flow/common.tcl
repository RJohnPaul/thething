# Silicon Studio physical flow: helpers shared by the OpenROAD stage scripts.
#
#   cd <run dir>; SILICON_CONFIG=<config.tcl> openroad -no_init -no_splash -threads <n> \
#     -exit <this dir>/<stage>.tcl          stages: floorplan pdn place cts route finish
#
# config.tcl sets ::cfg(...) (see the stage contract); platform.tcl sets ::plat(...).
# Stage structure and command choices are adapted from OpenROAD-flow-scripts
# flow/scripts/*.tcl (BSD-3-Clause, Copyright (c) 2018-2025, The Regents of the
# University of California and The OpenROAD Authors).

proc fail {msg} {
  puts stderr "\[ERROR FLOW\] $msg"
  exit 1
}

if {![info exists ::env(SILICON_CONFIG)]} { fail "SILICON_CONFIG is not set" }
if {[catch {source $::env(SILICON_CONFIG)} err]} { fail "cannot read config: $err" }
if {[catch {source $::cfg(platform_tcl)} err]} { fail "cannot read platform: $err" }
foreach dir {out_dir report_dir image_dir} { file mkdir $::cfg($dir) }

# A ::cfg knob, or the default when it is missing or "".
proc knob {key {default ""}} {
  if {[info exists ::cfg($key)] && $::cfg($key) ne ""} { return $::cfg($key) }
  return $default
}

if {[knob threads] ne ""} { set_thread_count $::cfg(threads) }

# Runs a stage body; any Tcl/OpenROAD error ends the process with exit code 1.
proc run_stage {name body} {
  set ::stage $name
  set ::stage_t0 [clock milliseconds]
  if {[catch {uplevel #0 $body} err opts]} {
    puts stderr [dict get $opts -errorinfo]
    fail "stage $name failed: $err"
  }
  puts "\[INFO FLOW\] stage $name finished in [stage_seconds] s"
}

proc stage_seconds {} { format %.1f [expr {([clock milliseconds] - $::stage_t0) / 1000.0}] }

# Reads the netlist (no checkpoint given) or a checkpoint from out_dir, then the
# timing libraries, SDC, wire RC and routing layers every stage needs.
proc load_design {{checkpoint ""}} {
  foreach lib $::plat(lib) { read_liberty $lib }
  if {$checkpoint eq ""} {
    read_lef $::plat(tech_lef)
    foreach lef $::plat(sc_lef) { read_lef $lef }
    read_verilog $::cfg(netlist)
    link_design $::cfg(design)
  } else {
    set path [file join $::cfg(out_dir) $checkpoint]
    if {![file exists $path]} { fail "missing checkpoint $path; run the previous stage first" }
    read_db $path
  }
  foreach sdc $::cfg(sdc) { read_sdc $sdc }
  source $::plat(setrc_tcl)
  set_dont_use $::plat(dont_use)
  if {$checkpoint eq ""} { return } ;# no routing tracks before the floorplan
  set layers [knob min_routing_layer $::plat(min_routing_layer)]-[knob max_routing_layer $::plat(max_routing_layer)]
  set_routing_layers -signal $layers -clock $layers
  set adjust $::plat(routing_layer_adjustment)
  if {[llength $adjust] == 1} { set adjust [list $layers $adjust] }
  foreach {range value} $adjust { set_global_routing_layer_adjustment $range $value }
}

proc write_checkpoint {name} { write_db [file join $::cfg(out_dir) $name] }

# Post-CTS timing uses the real clock tree; virtual (IO) clocks have none.
proc propagate_clocks {} {
  foreach clk [all_clocks] {
    if {[llength [get_property $clk sources]]} { set_propagated_clock $clk }
  }
}

# Pin constraints live only in the pin placer's memory, so they are applied
# again before every place_pins.
proc place_io {} {
  foreach constraint [knob pin_constraints] {
    lassign $constraint side pins
    set_io_pin_constraint -pin_names $pins -region $side:*
  }
  place_pins -hor_layers $::plat(io_hor_layer) -ver_layers $::plat(io_ver_layer)
}

# Writes report_dir/<file>: each command's output under a header line.
proc report {file commands} {
  set path [file join $::cfg(report_dir) $file]
  file delete $path
  foreach cmd $commands {
    set f [open $path a]
    puts $f "\n==========================================================================\n$cmd\n--------------------------------------------------------------------------"
    close $f
    tee -quiet -append -file $path $cmd
  }
}

proc json_number {v} {
  if {[string is double -strict $v] && ![catch {expr {abs($v) < 1e29}} ok] && $ok} {
    return [expr {[string is entier $v] ? $v + 0 : [format %.10g $v]}]
  }
  return null
}

# Writes report_dir/<stage>.metrics.json: a flat object of numbers (null when
# unknown or unconstrained), plus the stage runtime.
proc write_metrics {pairs} {
  lappend pairs runtime_s [stage_seconds]
  set items {}
  foreach {key value} $pairs { lappend items "  \"$key\": [json_number $value]" }
  set f [open [file join $::cfg(report_dir) $::stage.metrics.json] w]
  puts $f "\{\n[join $items ",\n"]\n\}"
  close $f
}

proc um {dbu} { ord::dbu_to_microns $dbu }

proc area_metrics {} {
  set block [ord::get_db_block]
  set die [$block getDieArea]
  set core [$block getCoreArea]
  list die_width_um [um [$die dx]] die_height_um [um [$die dy]] \
    die_area_um2 [expr {[um [$die dx]] * [um [$die dy]]}] \
    core_area_um2 [expr {[um [$core dx]] * [um [$core dy]]}] \
    cell_area_um2 [sta::format_area [rsz::design_area] 3] \
    utilization_pct [expr {[rsz::utilization] * 100}] \
    instance_count [llength [$block getInsts]]
}

proc timing_metrics {} {
  list setup_ws_ns [sta::worst_slack -max] setup_wns_ns [sta::worst_negative_slack -max] \
    setup_tns_ns [sta::total_negative_slack -max] \
    hold_ws_ns [sta::worst_slack -min] hold_wns_ns [sta::worst_negative_slack -min] \
    hold_tns_ns [sta::total_negative_slack -min] \
    setup_violations [sta::endpoint_violation_count max] \
    hold_violations [sta::endpoint_violation_count min]
}

proc timing_reports {} {
  return {
    {report_tns -digits 3}
    {report_wns -digits 3}
    {report_worst_slack -max -digits 3}
    {report_worst_slack -min -digits 3}
    {report_checks -path_delay max -format full_clock_expanded -fields {slew cap input net fanout} -digits 3}
    {report_checks -path_delay min -format full_clock_expanded -fields {slew cap input net fanout} -digits 3}
    {report_check_types -max_slew -max_capacitance -max_fanout -violators}
  }
}

# Saves image_dir/<name>.png of the whole die for each {name {{option value} ...}}
# pair, with OpenROAD's web tile renderer: headless, no Qt or display needed
# (the Qt GUI's "offscreen" platform is missing from the macOS build).
# Options are save_image -web display keys (stdcells, routing, net_clock, rudy...).
# Imaging problems never fail a stage.
proc save_images {views} {
  foreach {name options} $views {
    set args {}
    foreach option $options { lappend args -display_option $option }
    if {[catch {save_image -web -width 1600 {*}$args [file join $::cfg(image_dir) $name.png]} err]} {
      puts "\[WARNING FLOW\] image $name skipped: $err"
    }
  }
}
