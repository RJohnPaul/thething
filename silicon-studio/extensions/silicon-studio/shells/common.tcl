# Shared pieces of the Synopsys-style shells (dc_shell.tcl, icc2_shell.tcl, pt_shell.tcl): a small REPL,
# option parsing, report formatting, command help, a Liberty scanner and liberty-only timing helpers.
# Runs in any Tcl 8.6+/9 interpreter (yosys and OpenROAD both embed one).

namespace eval shell {
	variable doc [dict create]   ;# command -> {usage summary}
	variable history {}
	variable tool shell          ;# set by each shell, printed in report headers
	variable libcache
}

# In OpenROAD's Tcl 9 the first local-time 'clock format' fails (invalid command ":Tcl/Localtime"); later ones work.
catch {clock format 0}

proc shell::env {name {default ""}} {
	expr {[info exists ::env($name)] && $::env($name) ne "" ? $::env($name) : $default}
}

# ---- help / man / history ---------------------------------------------------------------------------------

proc shell::doc {cmd usage summary} { dict set ::shell::doc $cmd [list $usage $summary] }

proc help {{pattern *}} {
	foreach cmd [lsort [dict keys $::shell::doc $pattern]] {
		puts [format "  %-30s %s" $cmd [lindex [dict get $::shell::doc $cmd] 1]]
	}
}

proc man {cmd} {
	if {![dict exists $::shell::doc $cmd]} { error "no manual entry for '$cmd' (type 'help' for the command list)" }
	lassign [dict get $::shell::doc $cmd] usage summary
	puts "NAME\n    $cmd - $summary\n\nSYNTAX\n    $cmd $usage"
}

proc history {} {
	set i 0
	foreach c $::shell::history { puts [format "%5d  %s" [incr i] $c] }
}

proc quit {} { exit 0 }

shell::doc help    {[pattern]} "List the commands of this shell"
shell::doc man     {command} "Show the syntax of a command"
shell::doc history {} "List the commands entered at the prompt"
shell::doc quit    {} "Leave the shell (same as exit)"

# ---- option parsing ---------------------------------------------------------------------------------------

# Parse Synopsys-style options. spec is {-flag 1 -switch 0 ...} (1 = takes a value). Unique prefixes are accepted,
# as Synopsys shells do ("-f verilog"). Returns a dict of the given options plus "args" (the positional words).
proc shell::opts {cmd spec argv} {
	set out [dict create args {}]
	for {set i 0} {$i < [llength $argv]} {incr i} {
		set a [lindex $argv $i]
		if {![string match -* $a] || [string is double -strict $a]} { dict lappend out args $a; continue }
		set hits [expr {[dict exists $spec $a] ? [list $a] : [lsearch -all -inline -glob [dict keys $spec] $a*]}]
		if {[llength $hits] != 1} { error "$cmd: [expr {$hits eq "" ? "unknown" : "ambiguous"}] option '$a'" }
		set f [lindex $hits 0]
		if {[dict get $spec $f]} {
			if {[incr i] >= [llength $argv]} { error "$cmd: option '$f' needs a value" }
			dict set out $f [lindex $argv $i]
		} else {
			dict set out $f 1
		}
	}
	return $out
}

# An option value from a shell::opts dict, or the default.
proc shell::get {o key {default ""}} { dict getdef $o $key $default }

# ---- report formatting ------------------------------------------------------------------------------------

proc shell::header {report {design ""}} {
	set bar [string repeat * 56]
	puts $bar
	puts "Report    : $report"
	if {$design ne ""} { puts "Design    : $design" }
	puts "Generated : $::shell::tool, [clock format [clock seconds] -format {%a %b %d %H:%M:%S %Y}]"
	puts $bar\n
}

proc shell::kv {label value} { puts [format "%-36s %s" $label: $value] }

# Print rows under a header with dashed rules; columns whose first row is numeric are right-aligned.
proc shell::table {headers rows} {
	set w [lmap h $headers {string length $h}]
	foreach r $rows {
		set i 0
		foreach c $r { lset w $i [expr {max([lindex $w $i], [string length $c])}]; incr i }
	}
	set fmt [lmap c [lindex $rows 0] {expr {[string is double -strict $c] ? "%*s" : "%-*s"}}]
	set line {{fmt row} {
		upvar w w
		set out {}
		foreach c $row ww $w f $fmt { lappend out [format [expr {$f eq "" ? "%-*s" : $f}] $ww $c] }
		string trimright [join $out "  "]
	}}
	set rule [string repeat - [expr {[tcl::mathop::+ {*}$w] + 2 * ([llength $w] - 1)}]]
	puts [apply $line $fmt $headers]
	puts $rule
	foreach r $rows { puts [apply $line $fmt $r] }
	puts $rule
}

# ---- REPL -------------------------------------------------------------------------------------------------

# Read commands from stdin until EOF or exit/quit. Multi-line input is collected until 'info complete';
# errors are printed as "Error: ..." and the session continues.
proc shell::repl {prompt} {
	set buf ""
	while 1 {
		puts -nonewline [expr {$buf eq "" ? $prompt : "? "}]
		flush stdout
		if {[gets stdin line] < 0} break
		append buf $line \n
		if {![info complete $buf]} continue
		set cmd [string trim $buf]
		set buf ""
		if {$cmd eq ""} continue
		if {[regexp {^(exit|quit)\M} $cmd]} break
		lappend ::shell::history $cmd
		if {[catch {uplevel #0 $cmd} res]} {
			puts "Error: [regsub {^Error: } $res {}]"
		} elseif {$res ne ""} {
			puts $res
		}
	}
	puts ""
}

# Entry point of every shell: source $SILICON_SCRIPT (if set), then run the REPL when SILICON_INTERACTIVE=1.
# In batch mode the first error ends the run with exit code 1.
proc shell::main {prompt} {
	set interactive [expr {[env SILICON_INTERACTIVE 0] eq "1"}]
	set script [env SILICON_SCRIPT]
	if {$script ne "" && [catch {uplevel #0 [list source $script]} err]} {
		set at [string first "(file \"$script\" line " $::errorInfo]
		if {$at >= 0 && [scan [string range $::errorInfo $at end] {(file "%*[^"]" line %d} line] == 1} {
			append err " ([file tail $script] line $line)"
		}
		puts "Error: [regsub {^Error: } $err {}]"
		if {!$interactive} {
			if {[info exists ::shell::work]} { file delete -force $::shell::work }
			exit 1
		}
	}
	if {$interactive} { repl $prompt }
	if {[info exists ::shell::work]} { file delete -force $::shell::work }
	exit 0
}

# Scratch directory of this shell session, removed when the shell exits through shell::main.
proc shell::workdir {} {
	variable work
	if {![info exists work]} {
		set work [file join [env TMPDIR /tmp] silicon_shell_[pid]]
		file mkdir $work
	}
	return $work
}

# Top module of Verilog files: a module no other module instantiates (the last one when there are several).
proc shell::verilog_top {files} {
	set mods {}
	set used {}
	foreach file $files {
		set f [open $file]
		set text [read $f]
		close $f
		regsub -all {//[^\n]*|/\*.*?\*/} $text "" text
		foreach {- m} [regexp -all -inline {\mmodule\s+\\?([\w$]+)} $text] { lappend mods $m }
		foreach {- t} [regexp -all -inline -line {^\s*\\?([\w$]+)\s+(?:#\s*\(.*?\)\s*)?\\?[\w$\[\]]+\s*\(} $text] { lappend used $t }
	}
	set tops [lmap m $mods {if {$m in $used} continue; set m}]
	if {$tops eq ""} { error "cannot tell the top module of [join [lmap f $files {file tail $f}] {, }]; name it explicitly" }
	lindex $tops end
}

# ---- Synopsys-style app variables -------------------------------------------------------------------------

set ::shell::app_vars {search_path target_library link_library synthetic_library link_path}
proc set_app_var {name value} {
	upvar #0 $name v
	if {$name ni $::shell::app_vars} { lappend ::shell::app_vars $name }
	set v $value
}
proc get_app_var {name} {
	upvar #0 $name v
	if {![info exists v]} { error "unknown application variable '$name'" }
	return $v
}
shell::doc set_app_var {name value} "Set an application variable (search_path, target_library, link_library, ...)"
shell::doc get_app_var {name} "Return the value of an application variable"
proc report_app_var {{pattern *}} {
	puts [format "%-24s %s" Variable Value]
	puts [string repeat - 72]
	foreach name [lsort $::shell::app_vars] {
		if {[string match $pattern $name] && [info exists ::$name]} { puts [format "%-24s %s" $name [set ::$name]] }
	}
}
shell::doc report_app_var {?pattern?} "List application variables and their values"

# Resolve a file name through search_path. Synopsys .db libraries are a proprietary compiled format,
# so a .db name is looked up as the Liberty (.lib) source with the same base name.
proc shell::find_file {name} {
	if {[file extension $name] eq ".db"} { set name [file rootname $name].lib }
	set dirs [expr {[info exists ::search_path] ? $::search_path : "."}]
	foreach d [linsert $dirs 0 .] {
		set p [file join $d $name]
		if {[file isfile $p]} { return [file normalize $p] }
	}
	error "cannot find '$name' in search_path {$dirs}"
}

# ---- Liberty scanner --------------------------------------------------------------------------------------

# Returns {name <library> cells {<cell> {area A seq 0|1 bufinv 0|1 pins {pin dir ...}} ...}}.
# ponytail: regular expressions over the text, not a Liberty parser; standard-cell libraries only.
proc shell::liberty {file} {
	variable libcache
	if {[info exists libcache($file)]} { return $libcache($file) }
	set f [open $file]
	set text [read $f]
	close $f
	set lib [file rootname [file tail $file]]
	regexp {library\s*\(\s*"?([^")\s]+)} $text -> lib
	set hdrs [regexp -all -indices -inline {\n\s*cell\s*\(\s*"?([^")\s]+?)"?\s*\)} $text]
	set cells [dict create]
	for {set i 0} {$i < [llength $hdrs]} {incr i 2} {
		set name [string range $text {*}[lindex $hdrs $i+1]]
		set end [expr {$i + 2 < [llength $hdrs] ? [lindex $hdrs $i+2 0] : "end"}]
		set body [string range $text [lindex $hdrs $i 1] $end]
		set area 0
		regexp {\marea\s*:\s*"?([-0-9.eE+]+)} $body -> area
		set pins {}
		set ins 0
		foreach {- p d} [regexp -all -inline {\n\s*pin\s*\(\s*"?([^")\s]+?)"?\s*\)\s*\{[^\}]*?direction\s*:\s*"?(\w+)} $body] {
			lappend pins $p $d
			if {$d eq "input"} { incr ins }
		}
		set funcs [lmap {- fn} [regexp -all -inline {function\s*:\s*"([^"]*)"} $body] {regsub -all {[\s()]} $fn ""}]
		set seq [regexp {\m(ff|latch|ff_bank|latch_bank|statetable)\s*\(} $body]
		set bufinv [expr {!$seq && $ins == 1 && [llength $funcs] == 1 && [regexp {^!?\w+$|^\w+'$} [lindex $funcs 0]]}]
		dict set cells $name [dict create area $area seq $seq bufinv $bufinv pins $pins]
	}
	set libcache($file) [dict create name $lib cells $cells]
}

# ---- liberty-only timing (dc_shell, pt_shell) -------------------------------------------------------------

# OpenROAD links a netlist only against LEF masters, while Design Compiler and PrimeTime time a netlist from
# Liberty alone. Write a stand-in LEF (one layer, one site, a pin-only MACRO per Liberty cell) so OpenSTA inside
# OpenROAD can do the same; geometry is irrelevant because nothing is placed.
proc shell::stub_lef {libs out} {
	set f [open $out w]
	puts $f "VERSION 5.8 ;\nBUSBITCHARS \"\[\]\" ;\nDIVIDERCHAR \"/\" ;\nUNITS\n  DATABASE MICRONS 1000 ;\nEND UNITS\n"
	puts $f "LAYER M1\n  TYPE ROUTING ;\n  DIRECTION HORIZONTAL ;\n  PITCH 0.2 ;\n  WIDTH 0.1 ;\nEND M1\n"
	puts $f "SITE stub\n  CLASS CORE ;\n  SIZE 0.2 BY 2 ;\nEND stub\n"
	set seen {}
	foreach lib $libs {
		dict for {cell c} [dict get [liberty $lib] cells] {
			if {$cell in $seen} continue
			lappend seen $cell
			puts $f "MACRO $cell\n  CLASS CORE ;\n  SIZE 1 BY 2 ;\n  SITE stub ;"
			foreach {p d} [dict get $c pins] {
				if {$d in {input output inout}} { puts $f "  PIN $p\n    DIRECTION [string toupper $d] ;\n  END $p" }
			}
			puts $f "END $cell\n"
		}
	}
	puts $f "END LIBRARY"
	close $f
}

# Translate PrimeTime/Design Compiler report_timing options into OpenSTA report_checks arguments.
proc shell::report_checks_args {argv} {
	set o [opts report_timing {
		-delay_type 1 -max_paths 1 -nworst 1 -from 1 -to 1 -through 1 -path_type 1 -significant_digits 1
		-input_pins 0 -nets 0 -transition_time 0 -capacitance 0 -nosplit 0 -sort_by 1 -group 1
	} $argv]
	set a [list -path_delay [dict getdef $o -delay_type max] -digits [dict getdef $o -significant_digits 3]]
	set type [dict getdef $o -path_type full_clock_expanded]
	lappend a -format [expr {$type eq "short" ? "short" : $type eq "end" ? "end" : $type}]
	foreach {dc sta} {-max_paths -group_path_count -nworst -endpoint_path_count -from -from -to -to -through -through -group -path_group} {
		if {[dict exists $o $dc]} { lappend a $sta [dict get $o $dc] }
	}
	set fields {}
	foreach {dc f} {-input_pins input_pin -nets net -transition_time slew -capacitance capacitance} {
		if {[dict exists $o $dc]} { lappend fields $f }
	}
	if {$fields ne ""} { lappend a -fields $fields }
	return $a
}

# Summary numbers for report_qor / report_global_timing / report_constraint, evaluated inside OpenROAD.
proc shell::timing_summary {} {
	set r {}
	foreach mm {max min} {
		set wns [sta::worst_slack -$mm]
		lappend r [expr {$wns > 1e29 ? "" : $wns}] [sta::total_negative_slack -$mm] [sta::endpoint_violation_count $mm]
	}
	lappend r [sta::max_slew_violation_count] [sta::max_capacitance_violation_count] [sta::max_fanout_violation_count]
}

# Print the summary returned by shell::timing_summary as a Synopsys-style table.
proc shell::print_timing_summary {s} {
	lassign $s swns stns sviol hwns htns hviol slew cap fanout
	set fmt {{v} {if {$v eq ""} { return -- }; format %.3f $v}}
	shell::table {Check WNS TNS Violations} [list \
		[list "Setup (max delay)" [apply $fmt $swns] [apply $fmt $stns] $sviol] \
		[list "Hold (min delay)" [apply $fmt $hwns] [apply $fmt $htns] $hviol]]
	puts ""
	shell::table {"Design rule" Violations} [list [list max_transition $slew] [list max_capacitance $cap] [list max_fanout $fanout]]
}
