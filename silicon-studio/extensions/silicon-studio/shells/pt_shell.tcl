# pt_shell.tcl - a PrimeTime-style static timing shell on top of OpenSTA inside OpenROAD.
#   openroad -no_init -no_splash pt_shell.tcl
# Environment: SILICON_SCRIPT (script to source), SILICON_INTERACTIVE=1 (prompt 'pt_shell> ' afterwards),
# SILICON_PLATFORM_TCL (default link_path libraries and wire RC).
#
# A gate-level netlist (read_verilog + link_design) is timed from Liberty alone; an OpenROAD database (read_db
# design.odb, e.g. from icc2_shell save_block) also carries placement, so parasitics are estimated from it unless
# read_parasitics annotates a SPEF. OpenSTA commands (report_checks, report_net, ...) are all still available.

source [file join [file dirname [file normalize [info script]]] common.tcl]
set shell::tool "Silicon Studio pt_shell (OpenSTA)"

set search_path .
set link_path *
if {[shell::env SILICON_PLATFORM_TCL] ne ""} {
	source $::env(SILICON_PLATFORM_TCL)
	set link_path [concat * $::plat(lib)]
}

namespace eval pt {
	variable files {}        ;# Verilog netlists read
	variable libs {}         ;# Liberty files read
	variable top ""          ;# linked design
	variable placed 0        ;# design came from an OpenROAD database (has placement)
	variable parasitics ""   ;# "" | spef | estimated | none
}

# OpenSTA/OpenROAD commands replaced by PrimeTime-style wrappers stay available under an _or_ prefix.
foreach cmd {read_verilog link_design read_db report_power} { rename $cmd _or_$cmd }

proc pt::read_libs {} {
	variable libs
	foreach l $::link_path {
		if {$l eq "*"} continue
		set p [shell::find_file $l]
		if {$p ni $libs} {
			read_liberty $p
			lappend libs $p
		}
	}
	if {$libs eq ""} { error "no libraries: set_app_var link_path {* <library>.lib} (or read_db <library>.db)" }
}

proc pt::need {} {
	if {$::pt::top ne ""} return
	if {$::pt::files eq ""} { error "no design; use read_verilog + link_design or read_db <design>.odb first" }
	link_design
}

# Parasitics before a report: the SPEF read, else estimates from the placement, else ideal (zero) wires.
proc pt::annotate {} {
	variable parasitics
	need
	if {$parasitics ne ""} return
	if {$::pt::placed} {
		if {[info exists ::plat(setrc_tcl)]} { uplevel #0 [list source $::plat(setrc_tcl)] }
		if {![catch {estimate_parasitics -placement} err]} {
			puts "Information: no parasitics read; using estimates from the placement (estimate_parasitics -placement)."
			set parasitics estimated
			return
		}
		puts "Warning: parasitic estimation failed ($err)."
	}
	puts "Information: no parasitics read (read_parasitics); nets are timed as ideal wires."
	set parasitics none
}

# ---- design and libraries --------------------------------------------------------------------------------

proc read_verilog {args} {
	set files [lmap f [concat {*}$args] {shell::find_file $f}]
	if {$files eq ""} { error "read_verilog: file name required" }
	if {$pt::top ne ""} { error "read_verilog: design '$pt::top' is already linked; start a new shell for another design" }
	foreach f $files {
		_or_read_verilog $f
		lappend pt::files $f
		puts "Information: read Verilog '[file tail $f]'."
	}
	return 1
}

# Liberty from link_path, a stand-in LEF made from it (OpenROAD links against LEF masters), then the netlist.
proc link_design {args} {
	set o [shell::opts link_design {-keep_sub_designs 0 -remove_sub_designs 0 -verbose 0} $args]
	if {$pt::top ne ""} { puts "Information: design '$pt::top' is already linked."; return 1 }
	if {$pt::files eq ""} { error "link_design: no netlist; use read_verilog first" }
	pt::read_libs
	set top [lindex [dict get $o args] 0]
	if {$top eq ""} { set top [shell::verilog_top $pt::files] }
	set lef [file join [shell::workdir] stub.lef]
	shell::stub_lef $pt::libs $lef
	read_lef $lef
	_or_link_design $top
	set pt::top $top
	puts "Information: linked design '$top' ([sta::network_leaf_instance_count] cells) with [join [lmap l $pt::libs {file tail $l}] {, }]."
	return 1
}
interp alias {} link {} link_design

# read_db <library>.db|.lib adds a timing library (as in PrimeTime); read_db <design>.odb opens an OpenROAD database.
proc read_db {args} {
	foreach file [concat {*}$args] {
		if {[file extension $file] in {.db .lib}} {
			set p [shell::find_file $file]
			if {$p ni $::link_path} { lappend ::link_path $p }
			pt::read_libs
			continue
		}
		if {$pt::top ne ""} { error "read_db: design '$pt::top' is already loaded" }
		_or_read_db [shell::find_file $file]
		pt::read_libs
		set pt::top [[ord::get_db_block] getName]
		set pt::placed 1
		puts "Information: read design '$pt::top' from [file tail $file] ([sta::network_leaf_instance_count] cells, placed)."
	}
	return 1
}

proc current_design {{name ""}} {
	pt::need
	if {$name ne "" && $name ne $pt::top} { error "current_design: only the linked design '$pt::top' is available" }
	return $pt::top
}

proc read_parasitics {args} {
	set o [shell::opts read_parasitics {-format 1 -keep_capacitive_coupling 0 -triplet_type 1 -path 1 -quiet 0} $args]
	set file [lindex [dict get $o args] 0]
	if {$file eq ""} { error "read_parasitics: file name required" }
	if {[string tolower [shell::get $o -format spef]] ne "spef"} { error "read_parasitics: only SPEF is supported" }
	pt::need
	set a [expr {[dict exists $o -keep_capacitive_coupling] ? "-keep_capacitive_coupling" : ""}]
	if {[dict exists $o -path]} { lappend a -path [dict get $o -path] }
	read_spef {*}$a [shell::find_file $file]
	set pt::parasitics spef
	puts "Information: annotated parasitics from '[file tail $file]'."
	return 1
}

proc update_timing {args} {
	pt::annotate
	sta::find_timing -full_update
	puts "Information: timing updated."
	return 1
}

# ---- reports ---------------------------------------------------------------------------------------------

proc report_timing {args} {
	pt::annotate
	shell::header timing $pt::top
	report_checks {*}[shell::report_checks_args $args]
	return 1
}

proc report_global_timing {args} {
	pt::annotate
	shell::header global_timing $pt::top
	shell::print_timing_summary [shell::timing_summary]
	return 1
}

proc report_constraint {args} {
	set o [shell::opts report_constraint {-all_violators 0 -max_delay 0 -min_delay 0 -max_transition 0 -max_capacitance 0
		-max_fanout 0 -nosplit 0 -verbose 0 -significant_digits 1} $args]
	pt::annotate
	shell::header constraint $pt::top
	if {![dict exists $o -all_violators]} {
		shell::print_timing_summary [shell::timing_summary]
		return 1
	}
	set checks [lmap c {-max_delay -min_delay -max_transition -max_capacitance -max_fanout} {
		if {![dict exists $o $c]} continue
		expr {$c eq "-max_transition" ? "-max_slew" : $c}
	}]
	tee -quiet -variable out [list report_check_types -violators -digits [shell::get $o -significant_digits 3] {*}$checks]
	puts [expr {[regexp VIOLATED $out] ? $out : "No constraint violations."}]
	return 1
}

proc report_clock {args} {
	pt::need
	shell::header clock $pt::top
	report_clock_properties
	return 1
}

proc report_power {args} {
	pt::annotate
	shell::header power $pt::top
	_or_report_power
	return 1
}

# ---- help ------------------------------------------------------------------------------------------------

foreach {cmd usage summary} {
	read_verilog {files} "Read a gate-level netlist"
	link_design {[design]} "Link the netlist against the link_path libraries (top found automatically)"
	read_db {library.db|.lib | design.odb} "Add a timing library, or open an OpenROAD database (placed design)"
	current_design {} "Return the linked design"
	read_parasitics {[-format spef] file} "Annotate net parasitics from SPEF"
	update_timing {[-full]} "Update timing"
	report_timing {[-delay_type max|min|min_max] [-max_paths n] [-nworst n] [-from x] [-to x] [-through x] [-input_pins] [-nets] [-transition_time] [-capacitance]} "Worst paths"
	report_global_timing {} "Setup/hold WNS, TNS and violation counts"
	report_constraint {[-all_violators] [-max_delay] [-min_delay] [-max_transition] [-max_capacitance]} "Constraint summary or violators"
	report_clock {} "Clock periods and waveforms"
	report_power {} "Switching, internal and leakage power (default activity)"
} { shell::doc $cmd $usage $summary }

shell::main "pt_shell> "
