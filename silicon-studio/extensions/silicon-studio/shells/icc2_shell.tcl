# icc2_shell.tcl - an IC Compiler II-style command shell on top of OpenROAD.
#   openroad -no_init -no_splash icc2_shell.tcl
# Environment: SILICON_SCRIPT (script to source), SILICON_INTERACTIVE=1 (prompt 'icc2_shell> ' afterwards),
# SILICON_PLATFORM_TCL (technology, cell libraries and flow settings), SILICON_PYTHON + SILICON_FLOW_DIR (write_gds
# through flow/def2gds.py and the KLayout Python module).
#
# Each implementation command runs the OpenROAD steps of the Silicon Studio flow stage scripts (flow/floorplan.tcl,
# pdn.tcl, place.tcl, cts.tcl, route.tcl, finish.tcl), which are adapted from OpenROAD-flow-scripts (BSD-3-Clause,
# Copyright (c) 2018-2025, The Regents of the University of California and The OpenROAD Authors).
# OpenROAD commands are all still available (global_placement, report_checks, ...).

source [file join [file dirname [file normalize [info script]]] common.tcl]
set shell::tool "Silicon Studio icc2_shell (OpenROAD)"

if {[shell::env SILICON_PLATFORM_TCL] ne ""} { source $::env(SILICON_PLATFORM_TCL) }

namespace eval icc2 {
	variable dir [file dirname [file normalize [info script]]]
	variable lib ""          ;# library directory from create_lib/open_lib; save_block writes <lib>/<block>.odb
	variable tech_lef ""     ;# create_lib -technology (else the platform's)
	variable ref_lefs {}     ;# create_lib -ref_libs (else the platform's)
	variable loaded 0        ;# technology and cells read into OpenROAD
	variable files {}        ;# Verilog netlists read
	variable top ""          ;# -top of read_verilog / link_block
	variable block ""        ;# linked block
	variable pins 0          ;# place_pins ran
	variable taps 0          ;# tap cells inserted
	variable pg 0            ;# compile_pg ran
	variable cts 0           ;# clock_opt ran
	variable rcx 0           ;# extraction rules loaded
	variable drt 0           ;# detailed routing ran in this session
	variable app [dict create place.coarse.max_density "" route.detail.max_number_iterations ""]
}

# OpenROAD commands replaced by ICC2-style wrappers stay available under an _or_ prefix.
foreach cmd {read_verilog read_sdc initialize_floorplan place_pins write_def write_verilog report_power} { rename $cmd _or_$cmd }

proc icc2::plat {key} { expr {[info exists ::plat($key)] ? $::plat($key) : ""} }

proc icc2::libdir {} { expr {$::icc2::lib eq "" ? "." : $::icc2::lib} }

# Liberty files: link_library (set_app_var, resolved through search_path) or the platform's.
proc icc2::liberty {} {
	set libs [expr {[info exists ::link_library] ? [lsearch -all -inline -not -exact $::link_library *] : ""}]
	if {$libs eq ""} { return [plat lib] }
	lmap l $libs {shell::find_file $l}
}

# Read technology, cell LEFs and Liberty once (create_lib/open_lib only record what to read).
proc icc2::load {} {
	variable loaded
	if {$loaded} return
	set tech [expr {$::icc2::tech_lef ne "" ? $::icc2::tech_lef : [plat tech_lef]}]
	if {$tech eq ""} { error "no technology: use create_lib -technology <tech.lef> -ref_libs {<cells.lef>} or open a project with a platform" }
	read_lef $tech
	foreach l [expr {$::icc2::ref_lefs ne "" ? $::icc2::ref_lefs : [plat sc_lef]}] { read_lef $l }
	set libs [liberty]
	if {$libs eq ""} { puts "Warning: no Liberty libraries (set_app_var link_library {...}); timing is unavailable." }
	foreach l $libs { read_liberty $l }
	set loaded 1
}

proc icc2::block {} {
	set b [ord::get_db_block]
	if {$b eq "NULL" || $b eq ""} { error "no block; use read_verilog + link_block or open_block first" }
	return $b
}

# Link on demand, like ICC2 does for a block read from Verilog.
proc icc2::need_linked {} {
	if {$::icc2::block ne ""} return
	if {$::icc2::files eq ""} { error "no block; use read_verilog + link_block or open_block first" }
	link_block
}

proc icc2::need_floorplan {} {
	need_linked
	if {![llength [[block] getRows]]} { error "the block has no floorplan yet; run initialize_floorplan first" }
}

# Wire RC, dont_use list and routing layers every step needs (flow/common.tcl load_design).
proc icc2::setup_timing {} {
	if {[plat setrc_tcl] ne ""} { uplevel #0 [list source $::plat(setrc_tcl)] }
	if {[plat dont_use] ne "" && [liberty] ne ""} { set_dont_use $::plat(dont_use) }
}

proc icc2::setup_routing {} {
	if {[plat min_routing_layer] eq ""} return
	set layers $::plat(min_routing_layer)-$::plat(max_routing_layer)
	set_routing_layers -signal $layers -clock $layers
	set adjust [plat routing_layer_adjustment]
	if {[llength $adjust] == 1} { set adjust [list $layers $adjust] }
	foreach {range value} $adjust { set_global_routing_layer_adjustment $range $value }
}

proc icc2::density {} {
	set d [dict get $::icc2::app place.coarse.max_density]
	if {$d eq ""} { set d [plat place_density] }
	expr {$d eq "" ? 0.6 : $d}
}

proc icc2::place_io {} {
	set a {}
	if {[plat io_hor_layer] ne ""} { lappend a -hor_layers $::plat(io_hor_layer) -ver_layers $::plat(io_ver_layer) }
	_or_place_pins {*}$a
}

proc icc2::propagate_clocks {} {
	foreach clk [all_clocks] {
		if {[llength [get_property $clk sources]]} { set_propagated_clock $clk }
	}
}

proc icc2::slack {v} {
	if {$v > 1e29 || $v < -1e29} { return unconstrained }
	format %.3f $v
}

proc icc2::summary {cmd} {
	set b [block]
	puts [format "%s finished: %d instances, utilization %.1f%%, setup WNS %s, hold WNS %s" $cmd \
		[llength [$b getInsts]] [expr {[rsz::utilization] * 100}] [slack [sta::worst_slack -max]] [slack [sta::worst_slack -min]]]
}

# Fill, tap, endcap and diode cells, and cells without Liberty: layout only (flow/finish.tcl).
proc icc2::physical_only_masters {} {
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

# ---- libraries and blocks --------------------------------------------------------------------------------

proc set_app_options {args} {
	set o [shell::opts set_app_options {-name 1 -value 1 -list 1 -block 0 -global 0} $args]
	set pairs [shell::get $o -list]
	if {[dict exists $o -name]} { lappend pairs [dict get $o -name] [shell::get $o -value] }
	foreach {k v} $pairs {
		if {![dict exists $::icc2::app $k]} { puts "Warning: application option '$k' has no effect here." }
		dict set ::icc2::app $k $v
	}
	return 1
}

proc get_app_options {{pattern *}} { dict filter $::icc2::app key $pattern }

proc create_lib {args} {
	set o [shell::opts create_lib {-technology 1 -ref_libs 1 -use_technology_lib 1} $args]
	set name [lindex [dict get $o args] 0]
	if {$name eq ""} { error "create_lib: library name required" }
	foreach f [concat [shell::get $o -technology] [shell::get $o -ref_libs]] {
		if {[file extension $f] ne ".lef"} { error "create_lib: '$f' is not a LEF file (NDM and .tf libraries are Synopsys formats; give LEF files)" }
	}
	if {[dict exists $o -technology]} { set icc2::tech_lef [shell::find_file [dict get $o -technology]] }
	set icc2::ref_lefs [lmap f [shell::get $o -ref_libs] {shell::find_file $f}]
	file mkdir $name
	set icc2::lib $name
	puts "Information: created library '$name' ([expr {$icc2::tech_lef ne "" ? [file tail $icc2::tech_lef] : "platform [icc2::plat name]"}])."
	return 1
}

proc open_lib {name} {
	if {![file isdirectory $name]} { error "open_lib: no library '$name' (create it with create_lib)" }
	set icc2::lib $name
	puts "Information: opened library '$name'."
	return 1
}

proc current_lib {} { return $icc2::lib }

# open_block <block> or <lib>:<block>: read a block written by save_block.
proc open_block {name} {
	if {[regexp {^(.*):([^:]+)$} $name -> lib name]} { open_lib $lib }
	set path [file join [icc2::libdir] $name.odb]
	if {![file exists $path]} { error "open_block: no saved block '$path' (save_block writes it)" }
	if {$icc2::loaded} { error "open_block: a block is already open; start a new shell to open another" }
	read_db $path
	foreach l [icc2::liberty] { read_liberty $l }
	set icc2::loaded 1
	set icc2::block $name
	set sdc [file rootname $path].sdc
	if {[file exists $sdc]} { read_sdc $sdc }
	icc2::setup_timing
	icc2::setup_routing
	if {[llength [[icc2::block] getRows]]} { set icc2::taps 1 }
	puts "Information: opened block '$name' ($path)."
	return 1
}

proc current_block {} { return $icc2::block }

proc save_block {args} {
	set o [shell::opts save_block {-as 1 -force 0 -compress 0} $args]
	icc2::need_linked
	set name [shell::get $o -as $icc2::block]
	set path [file join [icc2::libdir] $name.odb]
	write_db $path
	write_sdc -no_timestamp [file rootname $path].sdc
	puts "Information: saved block '$name' to $path."
	return 1
}

proc read_verilog {args} {
	set o [shell::opts read_verilog {-top 1 -library 1 -design 1} $args]
	set files [lmap f [concat {*}[dict get $o args]] {shell::find_file $f}]
	if {$files eq ""} { error "read_verilog: file name required" }
	icc2::load
	foreach f $files {
		_or_read_verilog $f
		lappend icc2::files $f
		puts "Information: read Verilog '[file tail $f]'."
	}
	if {[dict exists $o -top]} { set icc2::top [dict get $o -top] }
	return 1
}

proc link_block {args} {
	set o [shell::opts link_block {-force 0 -top 1} $args]
	if {$icc2::files eq ""} { error "link_block: no netlist; use read_verilog first" }
	set top [shell::get $o -top $icc2::top]
	if {$top eq ""} { set top [shell::verilog_top $icc2::files] }
	link_design $top
	set icc2::block $top
	icc2::setup_timing
	puts "Information: linked block '$top' ([llength [[icc2::block] getInsts]] cells, [llength [[icc2::block] getBTerms]] ports)."
	return 1
}
interp alias {} link {} link_block

proc read_sdc {args} {
	icc2::need_linked
	_or_read_sdc {*}$args
}

# ---- floorplan -------------------------------------------------------------------------------------------

# ICC2 options mapped to OpenROAD's initialize_floorplan; -core_offset is {left bottom right top} (or one value
# for all sides, or {horizontal vertical}), -boundary the die ({{x0 y0} {x1 y1}}), or the core with -control_type core.
proc initialize_floorplan {args} {
	set o [shell::opts initialize_floorplan {-core_utilization 1 -shape 1 -side_ratio 1 -side_length 1 -core_offset 1
		-boundary 1 -control_type 1 -orientation 1 -flip_first_row 1 -site 1 -keep_all 0 -use_site_row 0 -row_core_ratio 1} $args]
	icc2::need_linked
	if {[shell::get $o -shape R] ne "R"} { error "initialize_floorplan: only -shape R (a rectangle) is supported" }
	set site [shell::get $o -site [icc2::plat site]]
	if {$site eq ""} { error "initialize_floorplan: -site <site name> is required without a platform" }
	set off [shell::get $o -core_offset 2]
	switch [llength $off] {
		1 { lassign [list $off $off $off $off] l b r t }
		2 { lassign $off l b; lassign [list $l $b] r t }
		4 { lassign $off l b r t }
		default { error "initialize_floorplan: -core_offset takes 1, 2 or 4 values" }
	}
	if {[dict exists $o -boundary]} {
		set box [concat {*}[dict get $o -boundary]]
		if {[llength $box] != 4} { error "initialize_floorplan: -boundary must be a rectangle {{x0 y0} {x1 y1}}" }
		lassign $box x0 y0 x1 y1
		if {[shell::get $o -control_type die] eq "core"} {
			set core $box
			set die [list [expr {$x0 - $l}] [expr {$y0 - $b}] [expr {$x1 + $r}] [expr {$y1 + $t}]]
		} else {
			set die $box
			set core [list [expr {$x0 + $l}] [expr {$y0 + $b}] [expr {$x1 - $r}] [expr {$y1 - $t}]]
		}
		_or_initialize_floorplan -die_area $die -core_area $core -site $site
	} elseif {[dict exists $o -side_length]} {
		lassign [dict get $o -side_length] w h
		if {$h eq ""} { set h $w }
		_or_initialize_floorplan -die_area [list 0 0 [expr {$l + $w + $r}] [expr {$b + $h + $t}]] \
			-core_area [list $l $b [expr {$l + $w}] [expr {$b + $h}]] -site $site
	} else {
		# ICC2 utilization is a fraction (0.6), OpenROAD's a percentage; side_ratio is {horizontal vertical}
		set def [icc2::plat core_utilization]
		set u [shell::get $o -core_utilization [expr {$def eq "" ? 0.7 : $def / 100.0}]]
		lassign [shell::get $o -side_ratio {1 1}] sw sh
		if {$sh eq ""} { set sh 1 }
		_or_initialize_floorplan -utilization [expr {$u <= 1 ? $u * 100.0 : $u}] -aspect_ratio [expr {double($sh) / $sw}] \
			-core_space [list $b $t $l $r] -site $site
	}
	if {[icc2::plat tracks_tcl] ne ""} { uplevel #0 [list source $::plat(tracks_tcl)] } else { make_tracks }
	icc2::setup_routing

	# As flow/floorplan.tcl: spread the single tie cells from synthesis, drop synthesis buffers, insert tap cells.
	foreach {cell port} [list [icc2::plat tie_lo_cell] [icc2::plat tie_lo_port] [icc2::plat tie_hi_cell] [icc2::plat tie_hi_port]] {
		if {$cell eq "" || ![llength [get_lib_cells -quiet */$cell]]} continue
		set lib [get_name [get_property [lindex [get_lib_cells */$cell] 0] library]]
		repair_tie_fanout -separation 0 $lib/$cell/$port
	}
	remove_buffers
	create_tap_cells

	set b [icc2::block]
	set die [$b getDieArea]
	set core [$b getCoreArea]
	set um {{v} {ord::dbu_to_microns $v}}
	puts [format "Information: die %.3f x %.3f um, core %.3f x %.3f um, %d rows, utilization %.1f%%." \
		[apply $um [$die dx]] [apply $um [$die dy]] [apply $um [$core dx]] [apply $um [$core dy]] \
		[llength [$b getRows]] [expr {[rsz::utilization] * 100}]]
	return 1
}

proc create_tap_cells {args} {
	icc2::need_floorplan
	if {$icc2::taps} { puts "Information: tap cells are already inserted."; return 1 }
	if {[icc2::plat tapcell_tcl] ne ""} {
		uplevel #0 [list source $::plat(tapcell_tcl)]
	} elseif {$args ne ""} {
		tapcell {*}$args
	} else {
		puts "Warning: no platform tap cell script; give OpenROAD tapcell options (create_tap_cells -tapcell_master X -distance D)."
		return 0
	}
	set icc2::taps 1
	return 1
}

# ICC2: place_pins -self [-ports ...]. OpenROAD place_pins options pass through; the platform pin layers by default.
proc place_pins {args} {
	icc2::need_floorplan
	set a {}
	for {set i 0} {$i < [llength $args]} {incr i} {
		switch -- [lindex $args $i] {
			-self {}
			-ports { incr i }
			default { lappend a [lindex $args $i] }
		}
	}
	if {"-hor_layers" ni $a && [icc2::plat io_hor_layer] ne ""} { lappend a -hor_layers $::plat(io_hor_layer) }
	if {"-ver_layers" ni $a && [icc2::plat io_ver_layer] ne ""} { lappend a -ver_layers $::plat(io_ver_layer) }
	_or_place_pins {*}$a
	set icc2::pins 1
	return 1
}

# ---- power grid: the platform grid (flow/pdn.tcl) --------------------------------------------------------

proc icc2::pg_note {cmd} {
	puts "Information: $cmd is accepted for script compatibility; compile_pg builds the platform power grid ([file tail [plat pdn_tcl]])."
	return 1
}
foreach cmd {create_net create_pg_mesh_pattern create_pg_ring_pattern create_pg_std_cell_conn_pattern create_pg_macro_conn_pattern
	create_pg_region set_pg_strategy set_pg_strategy_via_rule create_pg_via_master_rule set_pg_via_master_rule} {
	proc $cmd {args} "icc2::pg_note $cmd"
}

proc connect_pg_net {args} {
	icc2::need_linked
	global_connect
	return 1
}

proc compile_pg {args} {
	icc2::need_floorplan
	if {$icc2::pg} { puts "Information: the power grid is already built."; return 1 }
	if {[icc2::plat pdn_tcl] eq ""} { error "compile_pg: no platform power grid script; build the grid with OpenROAD's pdngen commands" }
	uplevel #0 [list source $::plat(pdn_tcl)]
	pdngen
	set shapes 0
	foreach net [[icc2::block] getNets] {
		if {[$net getSigType] ni {POWER GROUND}} continue
		foreach swire [$net getSWires] { incr shapes [llength [$swire getWires]] }
	}
	set icc2::pg 1
	puts "compile_pg finished: $shapes power/ground shapes."
	return 1
}

# ---- placement, clock tree, routing ----------------------------------------------------------------------

# flow/place.tcl: place ignoring IOs and put unplaced pins next to their logic, then place for real and repair.
proc place_opt {args} {
	icc2::need_floorplan
	if {!$icc2::pg && [icc2::plat pdn_tcl] ne ""} { puts "Warning: no power grid yet (compile_pg); placing without it." }
	set density [icc2::density]
	if {!$icc2::pins} {
		global_placement -skip_io -density $density
		icc2::place_io
		set icc2::pins 1
	}
	buffer_ports
	global_placement -routability_driven -timing_driven -density $density
	estimate_parasitics -placement
	repair_design
	detailed_placement
	improve_placement
	optimize_mirroring
	check_placement -verbose
	estimate_parasitics -placement
	icc2::summary place_opt
	return 1
}

# flow/cts.tcl: clock tree, propagated clocks, setup/hold repair, re-legalisation.
proc clock_opt {args} {
	icc2::need_floorplan
	set buf [icc2::plat cts_buf]
	repair_clock_inverters
	clock_tree_synthesis -sink_clustering_enable -repair_clock_nets {*}[expr {$buf eq "" ? "" : [list -buf_list $buf]}]
	icc2::propagate_clocks
	estimate_parasitics -placement
	detailed_placement
	estimate_parasitics -placement
	repair_timing -setup -hold
	detailed_placement
	check_placement -verbose
	estimate_parasitics -placement
	set icc2::cts 1
	icc2::summary clock_opt
	return 1
}

# flow/route.tcl: global route, antenna repair, detailed route (DRC report in the library directory).
proc route_auto {args} {
	set o [shell::opts route_auto {-max_detail_route_iterations 1 -save_after_global_route 0 -save_after_track_assignment 0} $args]
	icc2::need_floorplan
	icc2::propagate_clocks
	pin_access
	global_route -congestion_iterations 30 -verbose
	repair_antennas -iterations 5
	set iters [shell::get $o -max_detail_route_iterations [dict get $::icc2::app route.detail.max_number_iterations]]
	set drt [list -output_drc [file join [icc2::libdir] $icc2::block.drc.rpt] -verbose 1]
	if {$iters ne ""} { lappend drt -droute_end_iter $iters }
	detailed_route {*}$drt
	for {set i 0} {$i < 5 && [check_antennas]} {incr i} {
		repair_antennas
		detailed_route {*}$drt
	}
	set icc2::drt 1
	if {![design_is_routed]} { error "route_auto: the block has unrouted nets" }
	puts "route_auto finished: [detailed_route_num_drvs] DRC violations, [check_antennas] antenna violations."
	return 1
}

# OpenRCX extraction of the routed block (flow/finish.tcl) into 'spef', which then annotates timing.
proc icc2::extract {spef} {
	if {![design_is_routed]} { error "parasitic extraction needs a routed block; run route_auto first" }
	if {[plat rcx_rules] eq ""} { error "no platform extraction rules (rcx_rules)" }
	if {!$::icc2::rcx} {
		define_process_corner -ext_model_index 0 X
		set_extraction_rules_file $::plat(rcx_rules)
		set ::icc2::rcx 1
	}
	extract_parasitics
	# write_spef takes the raw $args list as its file name, so a path with a space breaks: write from its directory.
	set cwd [pwd]
	cd [file dirname [file normalize $spef]]
	try { write_spef [file tail $spef] } finally { cd $cwd }
	read_spef $spef
}

# OpenROAD has no post-route optimizer here: route_opt extracts parasitics and updates timing.
proc route_opt {args} {
	icc2::need_floorplan
	icc2::extract [file join [shell::workdir] $icc2::block.spef]
	puts "Information: route_opt extracted parasitics (OpenRCX) and updated timing (no post-route optimization)."
	icc2::summary route_opt
	return 1
}

proc write_parasitics {args} {
	set o [shell::opts write_parasitics {-output 1 -format 1 -compress 0 -no_name_mapping 0} $args]
	set file [shell::get $o -output [lindex [dict get $o args] 0]]
	if {$file eq ""} { error "write_parasitics: give -output <file.spef>" }
	icc2::need_floorplan
	icc2::extract $file
	puts "Information: wrote SPEF '$file'."
	return 1
}

proc check_routes {args} {
	icc2::need_floorplan
	set drvs [expr {$icc2::drt ? [detailed_route_num_drvs] : "unknown (route_auto not run in this session)"}]
	shell::header check_routes $icc2::block
	shell::kv "All nets routed" [expr {[design_is_routed] ? "yes" : "no"}]
	shell::kv "Detailed routing DRC violations" $drvs
	shell::kv "Antenna violations" [check_antennas]
	return 1
}

proc create_stdcell_fillers {args} {
	set o [shell::opts create_stdcell_fillers {-lib_cells 1 -prefix 1 -rules 1} $args]
	icc2::need_floorplan
	set cells [lmap c [shell::get $o -lib_cells [icc2::plat fill_cells]] {lindex [split $c /] end}]
	if {$cells eq ""} { error "create_stdcell_fillers: give -lib_cells {filler cells}" }
	filler_placement $cells
	check_placement
	global_connect
	return 1
}

# ---- reports ---------------------------------------------------------------------------------------------

proc report_timing {args} {
	icc2::need_linked
	shell::header timing $icc2::block
	report_checks {*}[shell::report_checks_args $args]
	return 1
}

proc report_power {args} {
	icc2::need_linked
	shell::header power $icc2::block
	_or_report_power
	return 1
}

proc report_qor {args} {
	icc2::need_linked
	set b [icc2::block]
	shell::header qor $icc2::block
	shell::print_timing_summary [shell::timing_summary]
	puts ""
	shell::kv "Cell count" [llength [$b getInsts]]
	shell::kv "Port count" [llength [$b getBTerms]]
	shell::kv "Cell area (um^2)" [sta::format_area [rsz::design_area] 3]
	if {[llength [$b getRows]]} { shell::kv "Utilization" [format %.1f%% [expr {[rsz::utilization] * 100}]] }
	shell::kv "Clock tree" [expr {$icc2::cts ? "built (propagated clocks)" : "ideal clocks"}]
	if {[llength [$b getRows]]} { shell::kv "All nets routed" [expr {[design_is_routed] ? "yes" : "no"}] }
	return 1
}

proc report_utilization {args} {
	icc2::need_floorplan
	set b [icc2::block]
	set um2 {{box} {expr {[ord::dbu_to_microns [$box dx]] * [ord::dbu_to_microns [$box dy]]}}}
	set std 0
	set phys 0
	foreach inst [$b getInsts] {
		if {[regexp {^(CORE_SPACER|CORE_WELLTAP|CORE_ANTENNACELL|ENDCAP)} [[$inst getMaster] getType]]} { incr phys } else { incr std }
	}
	shell::header utilization $icc2::block
	shell::kv "Die area (um^2)" [format %.3f [apply $um2 [$b getDieArea]]]
	shell::kv "Core area (um^2)" [format %.3f [apply $um2 [$b getCoreArea]]]
	shell::kv "Standard cell area (um^2)" [sta::format_area [rsz::design_area] 3]
	shell::kv "Standard cells" $std
	shell::kv "Physical-only cells (tap, filler)" $phys
	shell::kv "Utilization" [format %.2f%% [expr {[rsz::utilization] * 100}]]
	return 1
}

proc report_clock_qor {args} {
	icc2::need_linked
	shell::header clock_qor $icc2::block
	if {!$icc2::cts} { puts "Information: no clock tree built in this session (clock_opt); clocks are ideal.\n" }
	report_clock_properties
	report_clock_skew -digits 3
	report_clock_min_period
	return 1
}

# ---- output ----------------------------------------------------------------------------------------------

proc write_def {args} {
	set o [shell::opts write_def {-include 1 -exclude 1 -compress 1 -version 1 -units 1 -include_tech_via_definitions 0} $args]
	set file [lindex [dict get $o args] 0]
	if {$file eq ""} { error "write_def: file name required" }
	icc2::need_linked
	_or_write_def $file
	puts "Information: wrote DEF '$file'."
	return 1
}

# Physical-only cells (taps, fillers) are always left out, as with ICC2's -exclude {physical_only_cells}.
proc write_verilog {args} {
	set o [shell::opts write_verilog {-include 1 -exclude 1 -hierarchy 1 -top_module_first 0 -compress 1} $args]
	set file [lindex [dict get $o args] 0]
	if {$file eq ""} { error "write_verilog: file name required" }
	icc2::need_linked
	_or_write_verilog -remove_cells [icc2::physical_only_masters] $file
	puts "Information: wrote Verilog '$file'."
	return 1
}

# DEF of the block merged with the cell GDS by flow/def2gds.py (KLayout Python module).
proc write_gds {args} {
	set o [shell::opts write_gds {-hierarchy 1 -lib_cell_view 1 -layer_map 1 -compress 0 -fill 1 -long_names 0 -keep_data_type 0} $args]
	set file [lindex [dict get $o args] 0]
	if {$file eq ""} { error "write_gds: file name required" }
	icc2::need_floorplan
	set python [shell::env SILICON_PYTHON]
	if {$python eq ""} { error "write_gds needs Python with the klayout module; set SILICON_PYTHON" }
	if {![info exists ::plat(dir)]} { error "write_gds needs a platform (cell GDS and layer map)" }
	set script [file join [shell::env SILICON_FLOW_DIR [file join [file dirname $icc2::dir] flow]] def2gds.py]
	set def [file join [shell::workdir] $icc2::block.def]
	_or_write_def $def
	if {[catch {exec $python $script --platform-tcl-json [file join $::plat(dir) platform.json] --def $def --out $file \
			--top $icc2::block 2>@1} out]} {
		error "write_gds failed:\n[string trim $out]"
	}
	puts "Information: wrote GDSII '$file'."
	return 1
}

proc gui_start {args} {
	if {[catch {gui::show "" true} err]} { error "gui_start: the OpenROAD GUI is not available ($err)" }
	return 1
}

# ---- help ------------------------------------------------------------------------------------------------

foreach {cmd usage summary} {
	create_lib {name [-technology tech.lef] [-ref_libs {cells.lef}]} "Create a library directory (technology from the platform or LEF files)"
	open_lib {name} "Open a library directory created by create_lib"
	open_block {[lib:]block} "Open a block saved by save_block"
	save_block {[-as name]} "Save the block (<lib>/<block>.odb and .sdc)"
	current_block {} "Return the current block name"
	set_app_options {-name option -value value | -list {option value ...}} "Set place.coarse.max_density or route.detail.max_number_iterations"
	read_verilog {[-top design] files} "Read a gate-level netlist (reads technology and libraries first)"
	link_block {[-top design]} "Link the block (top found automatically when not given)"
	initialize_floorplan {[-core_utilization 0.6] [-side_ratio {1 1}] [-core_offset d] [-boundary {{x0 y0} {x1 y1}}] [-side_length {w h}]} "Die, core, rows, tracks, tie cells and tap cells"
	create_tap_cells {} "Insert the platform tap cells (initialize_floorplan does this)"
	place_pins {[-self] [OpenROAD place_pins options]} "Place the block ports on the platform pin layers"
	compile_pg {} "Build the platform power grid (create_pg_* patterns are accepted and ignored)"
	connect_pg_net {[-automatic]} "Connect cell power/ground pins to the supply nets"
	place_opt {} "Global placement, electrical repair, detailed placement"
	clock_opt {} "Clock tree synthesis, setup/hold repair"
	route_auto {[-max_detail_route_iterations n]} "Global and detailed routing with antenna repair"
	route_opt {} "Parasitic extraction (OpenRCX) and timing update"
	write_parasitics {-output file.spef} "Extract the routed block (OpenRCX) and write SPEF"
	check_routes {} "Unrouted nets, DRC and antenna violations"
	create_stdcell_fillers {[-lib_cells {cells}]} "Insert filler cells"
	report_timing {[-delay_type max|min] [-max_paths n] [-nworst n] [-from x] [-to x] [-input_pins] [-nets]} "Worst paths (OpenSTA)"
	report_qor {} "Timing, cell count, area and utilization summary"
	report_utilization {} "Die, core and cell area, utilization"
	report_clock_qor {} "Clock properties, skew and minimum period"
	report_power {} "Switching, internal and leakage power (OpenSTA)"
	write_def {file} "Write the block as DEF"
	write_verilog {file} "Write the netlist without physical-only cells"
	write_gds {file} "Write GDSII (DEF merged with the cell GDS by KLayout)"
	gui_start {} "Open the OpenROAD GUI"
} { shell::doc $cmd $usage $summary }

shell::main "icc2_shell> "
