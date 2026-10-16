# dc_shell.tcl - a Design Compiler-style command shell on top of Yosys.
#   yosys -q -c dc_shell.tcl
# Environment: SILICON_SCRIPT (script to source), SILICON_INTERACTIVE=1 (prompt 'dc_shell> ' afterwards),
# SILICON_PLATFORM_TCL (default libraries), SILICON_OPENROAD (OpenROAD binary for timing/power reports),
# SILICON_YOSYS (yosys binary for child runs; found automatically when unset).
#
# A yosys error ends the yosys process, so every step that changes the design runs in a child yosys on an RTLIL
# checkpoint; this process only loads the latest checkpoint for queries and reports. A syntax error or a failed
# compile therefore prints "Error: ..." and the session continues.
# The compile recipe follows OpenROAD-flow-scripts flow/scripts/synth.tcl (BSD-3-Clause, Copyright (c) 2018-2026,
# The Regents of the University of California and the OpenROAD-flow-scripts authors).

source [file join [file dirname [file normalize [info script]]] common.tcl]
set shell::tool "Silicon Studio dc_shell (Yosys)"

set search_path .
set target_library ""
set link_library *
set synthetic_library ""
if {[shell::env SILICON_PLATFORM_TCL] ne ""} {
	source $::env(SILICON_PLATFORM_TCL)
	set target_library $::plat(lib)
	set link_library [concat * $::plat(lib)]
}

namespace eval dc {
	variable dir [file dirname [file normalize [info script]]]
	variable work [shell::workdir]
	variable n 0             ;# checkpoint counter
	variable reads {}        ;# analyzed sources, each a read_verilog command
	variable top ""          ;# current design
	variable ckpt ""         ;# RTLIL checkpoint of the current design ("" = not elaborated yet)
	variable loaded ""       ;# checkpoint loaded in this process
	variable mapped 0
	variable sdc {}          ;# recorded constraints: {command args}
	variable clocks [dict create]   ;# clock name -> period
	variable dont_use {}
	variable portcache {}
	# SDC options whose value is a plain word (not a design object)
	variable plain_opts {-period -name -waveform -lib_cell -library -pin -from_pin -comment -divide_by -multiply_by
		-edges -edge_shift -input_transition_rise -input_transition_fall -setup -hold -max -min}
	variable value_opts {-period -name -waveform -lib_cell -library -pin -from_pin -comment -divide_by -multiply_by
		-edges -edge_shift -input_transition_rise -input_transition_fall -clock -from -to -through -rise_from
		-fall_from -rise_to -fall_to -source -master_clock -reference_pin}
}

# ---- yosys plumbing --------------------------------------------------------------------------------------

proc dc::y {args} { yosys tee -q -s result.string {*}$args }
proc dc::json {args} { yosys tee -q -s result.json {*}$args }

proc dc::yosys_exe {} {
	set exe [shell::env SILICON_YOSYS]
	if {$exe eq ""} { catch {set exe [string trim [exec ps -o comm= -p [pid]]]} }
	if {$exe eq "" || [file pathtype $exe] ne "absolute"} { set exe [lindex [auto_execok yosys] 0] }
	if {$exe eq ""} { error "cannot find the yosys executable; set SILICON_YOSYS" }
	return $exe
}

proc dc::openroad_exe {} {
	set exe [shell::env SILICON_OPENROAD [lindex [auto_execok openroad] 0]]
	if {$exe eq ""} { error "timing and power reports need OpenROAD; set SILICON_OPENROAD" }
	return $exe
}

# Run Tcl lines in a child yosys; returns its console output (warnings). A yosys ERROR becomes a Tcl error.
proc dc::child {what lines} {
	variable work
	set f [file join $work step.tcl]
	set fh [open $f w]
	puts $fh [join $lines \n]
	close $fh
	if {[catch {exec [yosys_exe] -q -l [file join $work step.log] -c $f 2>@1} out]} {
		set errs [lmap e [regexp -all -inline -line {^ERROR:.*$} $out] {string range $e 7 end}]
		error "$what failed: [expr {$errs eq "" ? [string trim $out] : [join $errs {; }]}]"
	}
	return [string trim $out]
}

# Run lines on the current checkpoint in a child; the result becomes the new checkpoint.
proc dc::step {what lines} {
	variable ckpt
	set next [file join $::dc::work design[incr ::dc::n].il]
	set out [child $what [list [list yosys read_rtlil $ckpt] {*}$lines [list yosys write_rtlil $next]]]
	set ckpt $next
	return $out
}

# Make sure a design is elaborated (read_verilog/read_file elaborate lazily, like DC links on demand).
proc dc::need {} {
	variable ckpt
	if {$ckpt ne ""} return
	if {$::dc::reads eq ""} { error "no design loaded; use analyze + elaborate or read_verilog first" }
	elaborate "" ""
}

proc dc::sync {} {
	variable ckpt
	variable loaded
	need
	if {$loaded ne $ckpt} {
		y design -reset
		y read_rtlil $ckpt
		set loaded $ckpt
	}
}

proc dc::target_libs {} {
	if {$::target_library eq ""} { error "target_library is empty; use set_app_var target_library <library.lib>" }
	lmap l $::target_library {shell::find_file $l}
}

proc dc::link_libs {} {
	set libs [target_libs]
	foreach l $::link_library {
		if {$l eq "*"} continue
		set p [shell::find_file $l]
		if {$p ni $libs} { lappend libs $p }
	}
	return $libs
}

proc dc::lib_cell {type} {
	foreach l [link_libs] {
		set lib [shell::liberty $l]
		if {[dict exists $lib cells $type]} { return [list [dict get $lib name] [dict get $lib cells $type]] }
	}
	return ""
}

proc dc::plat {key} { expr {[info exists ::plat($key)] ? $::plat($key) : ""} }

# ---- reading and elaboration -----------------------------------------------------------------------------

proc dc::reader {format defines} {
	set rd {read_verilog -defer}
	switch -- $format {
		verilog {}
		sverilog - systemverilog { lappend rd -sv }
		default { error "unsupported format '$format' (use verilog or sverilog; there is no VHDL front end)" }
	}
	foreach d [regexp -all -inline {[^,\s]+} $defines] { lappend rd -D$d }
	return $rd
}

proc dc::analyze {format defines files} {
	variable reads
	set rd [reader $format $defines]
	set files [lmap f [concat {*}$files] {shell::find_file $f}]
	if {$files eq ""} { error "no files given" }
	foreach f $files {
		set warn [child "analyze [file tail $f]" [list [list yosys {*}$rd $f]]]
		if {$warn ne ""} { puts $warn }
		set reads [lsearch -all -inline -not -exact -index end $reads $f]
		lappend reads [list {*}$rd $f]
		puts "Analyzed $format file '[file tail $f]'"
	}
}

# Give parameterized modules Design Compiler style names: $paramod\counter\WIDTH=s32'..1000 -> counter_WIDTH8.
set dc::rename_paramods {
	foreach m [dict keys [dict get [yosys tee -q -s result.json stat -json] modules]] {
		if {![regexp {^\$paramod\\([^\\]+)\\(.+)$} $m -> base params]} continue
		set new $base
		foreach p [split $params \\] {
			if {![regexp {^([^=]+)=s?\d+'([01]+)$} $p -> k bits]} { set new ""; break }
			append new _$k[expr "0b$bits"]
		}
		if {$new ne ""} { yosys rename $m $new; yosys chtype -map $m $new }
	}
}

proc dc::elaborate {top params} {
	variable reads
	variable ckpt
	if {$reads eq ""} { error "nothing analyzed; use analyze or read_verilog first" }
	set hier [expr {$top eq "" ? {hierarchy -check -auto-top} : [list hierarchy -check -top $top]}]
	foreach p [regexp -all -inline {[^,\s]+} $params] {
		if {![regexp {^([^=]+)=(.+)$} $p -> k v]} { error "bad parameter '$p' (expected NAME=VALUE)" }
		lappend hier -chparam $k $v
	}
	set lines {}
	if {![catch {target_libs} libs]} {
		# library cells instantiated in the RTL resolve against the target library
		lappend lines [list yosys read_liberty -lib {*}$libs]
		lappend hier -purge_lib
	}
	foreach r $reads { lappend lines [list yosys {*}$r] }
	set next [file join $::dc::work design[incr ::dc::n].il]
	lappend lines [list yosys {*}$hier] {yosys proc} {yosys opt_clean} $::dc::rename_paramods [list yosys write_rtlil $next]
	set warn [child elaborate $lines]
	if {$warn ne ""} { puts $warn }
	set ckpt $next
	set ::dc::mapped 0
	sync
	set ::dc::top [string trim [y select -list-mod A:top]]
	puts "Elaborated design '$::dc::top'"
}

proc analyze {args} {
	set o [shell::opts analyze {-format 1 -library 1 -work 1 -define 1 -autoread 0 -recursive 0} $args]
	dc::analyze [shell::get $o -format verilog] [shell::get $o -define] [dict get $o args]
	return 1
}

proc elaborate {args} {
	set o [shell::opts elaborate {-parameters 1 -library 1 -architecture 1 -update 0} $args]
	set top [lindex [dict get $o args] 0]
	if {$top eq ""} { error "elaborate: design name required" }
	dc::elaborate $top [shell::get $o -parameters]
	return 1
}

proc read_file {args} {
	set o [shell::opts read_file {-format 1 -define 1 -library 1 -top 1 -rtl 0 -netlist 0 -autoread 0 -recursive 0} $args]
	dc::analyze [shell::get $o -format verilog] [shell::get $o -define] [dict get $o args]
	set dc::ckpt ""
	if {[dict exists $o -top]} { dc::elaborate [dict get $o -top] "" }
	return 1
}

proc read_verilog {args} { read_file -format verilog {*}$args }
proc read_sverilog {args} { read_file -format sverilog {*}$args }

proc current_design {{name ""}} {
	if {$name eq "" || $name eq $dc::top && $dc::ckpt ne ""} { dc::need; return $dc::top }
	if {$dc::ckpt ne ""} { puts "Information: re-elaborating with '$name' as the top design." }
	dc::elaborate $name ""
	return $dc::top
}

proc link {args} {
	dc::need
	set libs [expr {[catch {dc::link_libs} l] ? "" : $l}]
	puts "Linking design '$dc::top'"
	foreach l $libs { puts "  using library [dict get [shell::liberty $l] name] ($l)" }
	return 1
}

proc uniquify {args} {
	dc::need
	puts "Information: each parameterization is already a separate design; nothing to uniquify."
	return 1
}

proc check_design {args} {
	dc::sync
	set log [dc::y check]
	shell::header check_design $dc::top
	set issues [regexp -all -inline -line {^Warning:.*$} $log]
	foreach w $issues { puts $w }
	puts "\nFound [llength $issues] issue(s) in design '$dc::top'."
	return 1
}

# ---- object queries (return lists of names) --------------------------------------------------------------

# Ports of the current design as {name direction width offset}, in declaration order.
proc dc::ports {} {
	variable portcache
	sync
	if {[dict exists $portcache $::dc::ckpt]} { return [dict get $portcache $::dc::ckpt] }
	set re {^\s*wire (?:width (\d+) )?(?:offset (-?\d+) )?(?:upto )?(?:signed )?(input|output|inout) (\d+) \\?(\S+)$}
	set ports {}
	foreach {- w off dir idx name} [regexp -all -inline -line $re [y dump $::dc::top/x:*]] {
		lappend ports [list $idx $name $dir [expr {$w eq "" ? 1 : $w}] [expr {$off eq "" ? 0 : $off}]]
	}
	set ports [lmap p [lsort -integer -index 0 $ports] {lrange $p 1 end}]
	set portcache [dict create $::dc::ckpt $ports]
	return $ports
}

# Synopsys patterns: * and ? are wildcards, brackets are literal (bus bits).
proc dc::match {names patterns} {
	set out {}
	foreach p $patterns {
		set g [string map {[ \\[ ] \\]} $p]
		foreach n $names { if {[string match $g $n] && $n ni $out} { lappend out $n } }
	}
	return $out
}

proc dc::port_bits {dirs patterns} {
	set out {}
	foreach p [ports] {
		lassign $p name dir w off
		if {$dir ni $dirs} continue
		set bits [list $name]
		if {$w > 1} {
			set bits {}
			for {set i $off} {$i < $off + $w} {incr i} { lappend bits $name\[$i\] }
		}
		lappend out {*}[expr {[match [list $name] $patterns] ne "" ? $bits : [match $bits $patterns]}]
	}
	return $out
}

# Cells (c) or nets (w) of the current design.
proc dc::names {kind} {
	sync
	set prefix $::dc::top/
	set out {}
	foreach l [split [y select -list $prefix$kind:*] \n] {
		set l [string trim $l]
		if {[string first $prefix $l] == 0} { lappend out [string range $l [string length $prefix] end] }
	}
	return $out
}

proc dc::modules {} {
	sync
	lmap m [dict keys [dict get [json stat -json] modules]] {string trimleft $m \\}
}

proc get_ports {{patterns *}} { dc::port_bits {input output inout} $patterns }
proc get_cells {args} { dc::match [dc::names c] [lindex [shell::opts get_cells {-hierarchical 0} $args] end] }
proc get_nets {args} { dc::match [dc::names w] [lindex [shell::opts get_nets {-hierarchical 0} $args] end] }
proc get_designs {{patterns *}} { dc::match [dc::modules] $patterns }
proc get_clocks {{patterns *}} { dc::match [dict keys $dc::clocks] $patterns }
proc all_inputs {} { dc::port_bits {input inout} * }
proc all_outputs {} { dc::port_bits {output inout} * }
proc all_clocks {} { dict keys $dc::clocks }
proc remove_from_collection {a b} { lmap x $a {if {$x in $b} continue; set x} }
proc sizeof_collection {a} { llength $a }

proc get_lib_cells {{patterns */*}} {
	set names {}
	foreach l [dc::link_libs] {
		set lib [shell::liberty $l]
		foreach c [dict keys [dict get $lib cells]] { lappend names [dict get $lib name]/$c }
	}
	dc::match $names $patterns
}

proc set_dont_use {cells {value true}} {
	foreach c $cells {
		set c [lindex [split $c /] end]
		set dc::dont_use [lsearch -all -inline -not -exact $dc::dont_use $c]
		if {[string is true $value]} { lappend dc::dont_use $c }
	}
	return 1
}

proc set_dont_touch {objects {value true}} {
	dc::sync
	set v [expr {[string is true $value] ? 1 : 0}]
	set mods [dc::modules]
	set cells [dc::names c]
	set lines {}
	foreach o $objects {
		if {$o in $mods} {
			lappend lines [list yosys setattr -mod -set keep_hierarchy $v $o]
		} elseif {$o in $cells || $o in [dc::names w]} {
			lappend lines [list yosys setattr -set keep $v $dc::top/$o]
		} else {
			error "set_dont_touch: no design, cell or net named '$o'"
		}
	}
	dc::step set_dont_touch $lines
	return 1
}

# ---- constraints: recorded here, written by write_sdc, timed by OpenSTA -----------------------------------

proc dc::record {cmd argv} {
	variable clocks
	if {$cmd eq "create_clock"} {
		set o [shell::opts create_clock {-period 1 -name 1 -waveform 1 -add 0 -comment 1} $argv]
		if {![dict exists $o -period]} { error "create_clock: -period is required" }
		set name [shell::get $o -name [lindex [concat {*}[dict get $o args]] 0]]
		if {$name eq ""} { error "create_clock: give -name or a source port" }
		dict set clocks $name [dict get $o -period]
	}
	lappend ::dc::sdc [list $cmd $argv]
	return
}

foreach cmd {create_clock create_generated_clock set_input_delay set_output_delay set_load set_driving_cell
	set_input_transition set_max_area set_max_transition set_max_fanout set_max_capacitance set_clock_uncertainty
	set_clock_latency set_clock_transition set_false_path set_multicycle_path set_max_delay set_min_delay
	set_case_analysis set_wire_load_model set_operating_conditions set_propagated_clock set_ideal_network} {
	proc $cmd {args} "dc::record $cmd \$args"
}

# A recorded argument back as SDC text: lists of design objects become get_* queries.
proc dc::sdc_word {w} {
	if {[string is double -strict $w]} { return $w }
	foreach {kind names} [list ports [port_bits {input output inout} *] clocks [dict keys $::dc::clocks]] {
		if {$w ne "" && [lmap x $w {if {$x in $names} continue; set x}] eq ""} { return "\[get_$kind [list $w]\]" }
	}
	foreach {kind k} {cells c nets w} {
		set names [names $k]
		if {$w ne "" && [lmap x $w {if {$x in $names} continue; set x}] eq ""} { return "\[get_$kind [list $w]\]" }
	}
	if {$w eq $::dc::top} { return {[current_design]} }
	return [list $w]
}

proc dc::write_sdc {file} {
	variable value_opts
	need
	set f [open $file w]
	puts $f "# Constraints for '$::dc::top' written by $::shell::tool\nset sdc_version 2.1\n"
	foreach c $::dc::sdc {
		lassign $c cmd argv
		set out [list $cmd]
		set prev ""
		foreach w $argv {
			if {[string match -* $w] && ![string is double -strict $w]} {
				lappend out $w
			} elseif {$prev in $value_opts && $prev in $::dc::plain_opts} {
				lappend out [list $w]
			} elseif {$prev in {-clock -master_clock}} {
				lappend out "\[get_clocks [list $w]\]"
			} else {
				lappend out [sdc_word $w]
			}
			set prev $w
		}
		puts $f [join $out " "]
	}
	close $f
}

proc write_sdc {args} {
	set file [lindex [dict get [shell::opts write_sdc {-nosplit 0 -version 1} $args] args] 0]
	if {$file eq ""} { error "write_sdc: file name required" }
	dc::write_sdc $file
	puts "Wrote constraints to '$file'"
	return 1
}

# ---- compile ---------------------------------------------------------------------------------------------

proc dc::compile {cmd flatten o} {
	variable top
	need
	foreach f {-scan -gate_clock -retime -spg} {
		if {[dict exists $o $f]} { puts "Warning: $cmd $f is not supported here and is ignored." }
	}
	if {$::dc::mapped && ([dict exists $o -incremental] || [dict exists $o -incremental_mapping])} {
		puts "Information: '$top' is already mapped; nothing to do for an incremental compile."
		return 1
	}
	set la [concat {*}[lmap l [target_libs] {list -liberty $l}]]
	set du [concat {*}[lmap c [concat [plat dont_use] $::dc::dont_use] {list -dont_use $c}]]
	set fl [expr {$flatten ? "-flatten" : ""}]
	set lines [list [list yosys hierarchy -check -top $top] [list yosys synth -top $top {*}$fl -run :fine]]
	if {[plat adder_map] ne ""} {
		lappend lines {yosys extract_fa} [list yosys techmap -map [plat adder_map]] {yosys techmap} {yosys opt -fast -purge}
	}
	lappend lines [list yosys synth -top $top {*}$fl -run fine: -noabc] {yosys opt -purge}
	if {[plat latch_map] ne ""} {
		set f [open [plat latch_map]]
		set cells [regexp -all -inline -line {^\s*module\s+([^\s(]+)} [read $f]]
		close $f
		set legal [concat {*}[lmap {- m} $cells {list -cell $m x}]]
		lappend lines [list yosys dfflegalize {*}$legal {t:$_DLATCH_*}] [list yosys techmap -map [plat latch_map]]
	}
	lappend lines [list yosys dfflibmap {*}$la {*}$du] {yosys opt} {yosys setundef -zero}
	set abc [list yosys abc {*}$la {*}$du]
	if {[dict size $::dc::clocks]} {
		# timing-driven mapping against the fastest clock (library time unit ns -> ABC ps)
		lappend abc -D [expr {round(1000 * [tcl::mathfunc::min {*}[dict values $::dc::clocks]])}]
		if {[plat abc_driver_cell] ne ""} {
			set constr [file join $::dc::work abc.constr]
			set f [open $constr w]
			puts $f "set_driving_cell [plat abc_driver_cell]\nset_load [plat abc_load_in_ff]"
			close $f
			lappend abc -constr $constr
		}
	}
	lappend lines $abc {yosys splitnets} {yosys opt_clean -purge}
	if {[plat tie_hi_cell] ne ""} {
		lappend lines [list yosys hilomap -singleton -hicell [plat tie_hi_cell] [plat tie_hi_port] \
			-locell [plat tie_lo_cell] [plat tie_lo_port]]
	}
	if {[plat min_buf_cell] ne ""} {
		lappend lines [list yosys insbuf -buf [plat min_buf_cell] [plat min_buf_in] [plat min_buf_out]]
	}
	lappend lines {yosys rename -enumerate}
	puts "Mapping '$top' to [join [lmap l [target_libs] {file tail $l}] {, }][expr {$flatten ? " (flattened)" : ""}] ..."
	dc::step $cmd $lines
	set ::dc::mapped 1
	sync
	set d [dict get [json stat -json {*}$la] design]
	puts [format "%s finished: %d cells, total cell area %.3f" $cmd [dict get $d num_cells] [dict get $d area]]
	return 1
}

proc compile {args} {
	dc::compile compile 0 [shell::opts compile {-map_effort 1 -area_effort 1 -power_effort 1 -incremental_mapping 0
		-incremental 0 -ungroup_all 0 -exact_map 0 -scan 0 -gate_clock 0 -retime 0 -boundary_optimization 0
		-no_design_rule 0 -only_design_rule 0 -auto_ungroup 1 -no_autoungroup 0} $args]
}

proc compile_ultra {args} {
	set o [shell::opts compile_ultra {-no_autoungroup 0 -incremental 0 -scan 0 -gate_clock 0 -retime 0 -spg 0
		-timing_high_effort_script 0 -area_high_effort_script 0 -no_boundary_optimization 0 -exact_map 0
		-no_seq_output_inversion 0} $args]
	dc::compile compile_ultra [expr {![dict exists $o -no_autoungroup]}] $o
}

# ---- area reports (yosys stat -liberty) ------------------------------------------------------------------

proc dc::stat {} {
	sync
	json stat -json {*}[concat {*}[lmap l [link_libs] {list -liberty $l}]]
}

# Classify a cell type: {library area kind} with kind seq, bufinv, comb, hier or unmapped.
proc dc::classify {type stat} {
	if {[dict exists $stat modules \\$type]} { return [list "" [dict get $stat modules \\$type area] hier] }
	if {[dict exists $stat modules $type]} { return [list "" [dict get $stat modules $type area] hier] }
	set lc [lib_cell $type]
	if {$lc eq ""} { return {"" 0 unmapped} }
	lassign $lc lib c
	list $lib [dict get $c area] [expr {[dict get $c seq] ? "seq" : [dict get $c bufinv] ? "bufinv" : "comb"}]
}

proc report_area {args} {
	set o [shell::opts report_area {-hierarchy 0 -nosplit 0 -physical 0 -designware 0} $args]
	set s [dc::stat]
	set top [dict get $s modules \\$dc::top]
	set count [dict create comb 0 seq 0 bufinv 0 hier 0 unmapped 0]
	dict for {type n} [dict get $top num_cells_by_type] {
		dict incr count [lindex [dc::classify $type $s] 2] $n
	}
	set bufinv_area 0.0
	dict for {type n} [dict get $s design num_cells_by_type] {
		lassign [dc::classify $type $s] - area kind
		if {$kind eq "bufinv"} { set bufinv_area [expr {$bufinv_area + $n * $area}] }
	}
	set total [dict get $s design area]
	set seq [dict get $s design sequential_area]
	shell::header area $dc::top
	puts "Library(s) used:\n"
	foreach l [dc::link_libs] { puts "    [dict get [shell::liberty $l] name] (file: $l)" }
	puts ""
	shell::kv "Number of ports" [dict get $top num_port_bits]
	shell::kv "Number of nets" [dict get $top num_wire_bits]
	shell::kv "Number of cells" [dict get $top num_cells]
	shell::kv "Number of combinational cells" [expr {[dict get $count comb] + [dict get $count bufinv]}]
	shell::kv "Number of sequential cells" [dict get $count seq]
	shell::kv "Number of hierarchical cells" [dict get $count hier]
	shell::kv "Number of buf/inv" [dict get $count bufinv]
	shell::kv "Number of references" [dict size [dict get $top num_cells_by_type]]
	if {[dict get $count unmapped]} { shell::kv "Number of unmapped cells" "[dict get $count unmapped] (run compile)" }
	puts ""
	shell::kv "Combinational area" [format %.6f [expr {$total - $seq}]]
	shell::kv "Buf/Inv area" [format %.6f $bufinv_area]
	shell::kv "Noncombinational area" [format %.6f $seq]
	shell::kv "Macro/Black Box area" [format %.6f 0]
	shell::kv "Net Interconnect area" "undefined (no wire load model)"
	puts ""
	shell::kv "Total cell area" [format %.6f $total]
	shell::kv "Total area" undefined
	if {[dict exists $o -hierarchy]} {
		puts "\nHierarchical area distribution\n"
		set rows [lmap {m d} [dict get $s modules] {list [string trimleft $m \\] [format %.4f [dict get $d area]] \
			[format %.1f [expr {$total > 0 ? 100.0 * [dict get $d area] / $total : 0}]]}]
		shell::table {Design "Total area" "Percent"} $rows
	}
	return 1
}

proc report_reference {args} {
	set s [dc::stat]
	set rows {}
	set total 0.0
	dict for {type n} [dict get $s modules \\$dc::top num_cells_by_type] {
		lassign [dc::classify $type $s] lib area kind
		set attr [dict get {seq n bufinv "" comb "" hier h unmapped u} $kind]
		lappend rows [list $type $lib [format %.6f $area] $n [format %.6f [expr {$n * $area}]] $attr]
		set total [expr {$total + $n * $area}]
	}
	shell::header reference $dc::top
	puts "Attributes: n - noncombinational, h - hierarchical, u - unmapped\n"
	shell::table {Reference Library "Unit area" Count "Total area" Attributes} [lsort -index 0 $rows]
	puts [format "Total %d references%*s" [llength $rows] 36 [format %.6f $total]]
	return 1
}

proc report_cell {args} {
	set s [dc::stat]
	set rows {}
	set total 0.0
	foreach {- type name} [regexp -all -inline -line {^\s*cell \\?(\S+) \\?(\S+)$} [dc::y dump $dc::top/c:*]] {
		lassign [dc::classify $type $s] lib area kind
		lappend rows [list $name $type $lib [format %.6f $area] [dict get {seq n bufinv "" comb "" hier h unmapped u} $kind]]
		set total [expr {$total + $area}]
	}
	shell::header cell $dc::top
	puts "Attributes: n - noncombinational, h - hierarchical, u - unmapped\n"
	shell::table {Cell Reference Library Area Attributes} [lsort -dictionary -index 0 $rows]
	puts [format "Total %d cells, area %.6f" [llength $rows] $total]
	return 1
}

# ---- timing, constraint and power reports (OpenSTA inside OpenROAD) --------------------------------------

# Write the mapped netlist + constraints, run 'body' in OpenROAD after linking them, return what it printed.
proc dc::sta {body} {
	variable work
	need
	if {!$::dc::mapped} { error "'$::dc::top' is not mapped yet; run compile or compile_ultra first" }
	sync
	set libs [link_libs]
	y write_verilog -noattr -noexpr -nohex -nodec [file join $work sta.v]
	write_sdc [file join $work sta.sdc]
	shell::stub_lef $libs [file join $work stub.lef]
	set f [open [file join $work sta.tcl] w]
	puts $f [list source [file join $::dc::dir common.tcl]]
	puts $f [list read_lef [file join $work stub.lef]]
	foreach l $libs { puts $f [list read_liberty $l] }
	puts $f [list read_verilog [file join $work sta.v]]
	puts $f [list link_design $::dc::top]
	puts $f [list read_sdc [file join $work sta.sdc]]
	puts $f "puts @@REPORT@@\n$body"
	close $f
	if {[catch {exec [openroad_exe] -no_init -no_splash -exit [file join $work sta.tcl] 2>@1} out]} {
		error "OpenSTA run failed:\n[string trim $out]"
	}
	string trim [string range $out [expr {[string first @@REPORT@@ $out] + 10}] end]
}

proc report_timing {args} {
	set out [dc::sta "report_checks [shell::report_checks_args $args]"]
	shell::header timing $dc::top
	puts [expr {$out eq "" ? "No paths (are there clocks and constraints? see create_clock)." : $out}]
	return 1
}

proc report_constraint {args} {
	set o [shell::opts report_constraint {-all_violators 0 -max_delay 0 -min_delay 0 -nosplit 0 -significant_digits 1} $args]
	shell::header constraint $dc::top
	if {[dict exists $o -all_violators]} {
		set out [dc::sta "report_check_types -violators -digits [shell::get $o -significant_digits 3]"]
		puts [expr {[regexp VIOLATED $out] ? $out : "No constraint violations."}]
	} else {
		shell::print_timing_summary [dc::sta {puts [shell::timing_summary]}]
	}
	return 1
}

proc report_power {args} {
	set out [dc::sta report_power]
	shell::header power $dc::top
	puts $out
	return 1
}

proc report_qor {args} {
	set s [dc::stat]
	set d [dict get $s design]
	shell::header qor $dc::top
	if {$dc::mapped} {
		puts "Timing\n"
		shell::print_timing_summary [dc::sta {puts [shell::timing_summary]}]
		puts ""
	}
	puts "Cell count and area\n"
	shell::kv "Leaf cell count" [dict get $d num_cells]
	shell::kv "Hierarchical modules" [expr {[dict size [dict get $s modules]] - 1}]
	shell::kv "Clocks" [expr {[dict size $dc::clocks] ? [dict keys $dc::clocks] : "none"}]
	shell::kv "Combinational area" [format %.6f [expr {[dict get $d area] - [dict get $d sequential_area]}]]
	shell::kv "Noncombinational area" [format %.6f [dict get $d sequential_area]]
	shell::kv "Total cell area" [format %.6f [dict get $d area]]
	return 1
}

# ---- output ----------------------------------------------------------------------------------------------

proc write {args} {
	set o [shell::opts write {-format 1 -hierarchy 0 -output 1 -names 1} $args]
	set format [shell::get $o -format ddc]
	dc::sync
	set file [shell::get $o -output $dc::top.[expr {$format eq "verilog" ? "v" : $format}]]
	switch -- $format {
		verilog { dc::y write_verilog -noattr -noexpr -nohex -nodec $file }
		ddc {
			set file [file rootname $file].json
			puts "Information: .ddc is Synopsys' proprietary database format; writing the Yosys JSON netlist instead."
			dc::y write_json $file
		}
		default { error "write: unsupported format '$format' (verilog or ddc)" }
	}
	puts "Writing $format file '$file' (all modules of '$dc::top')."
	return 1
}
interp alias {} write_file {} write

# ---- help ------------------------------------------------------------------------------------------------

foreach {cmd usage summary} {
	analyze {-format verilog|sverilog [-library WORK] [-define {A B=1}] {files}} "Parse HDL files (syntax check; elaborate builds the design)"
	elaborate {design [-parameters "N=8,M=2"] [-library WORK]} "Build the design hierarchy from analyzed files"
	read_verilog {files} "Read Verilog files; the design is elaborated when first needed"
	read_file {-format verilog|sverilog [-top design] {files}} "Read HDL files (like read_verilog)"
	current_design {[design]} "Return or set the current (top) design"
	link {} "Resolve all references of the current design"
	check_design {} "Report undriven wires, multiple drivers and combinational loops"
	uniquify {} "No-op: every parameterization is already its own design"
	set_dont_touch {objects [true|false]} "Keep designs (hierarchy), cells or nets out of optimization"
	set_dont_use {lib_cells [true|false]} "Exclude library cells from mapping"
	get_ports {[patterns]} "Return port names (bus bits expanded)"
	get_cells {[-hierarchical] [patterns]} "Return cell names of the current design"
	get_nets {[-hierarchical] [patterns]} "Return net names of the current design"
	get_designs {[patterns]} "Return design (module) names"
	get_clocks {[patterns]} "Return clock names"
	get_lib_cells {[library/cell patterns]} "Return library cells as library/cell"
	all_inputs {} "Return all input port bits"
	all_outputs {} "Return all output port bits"
	all_clocks {} "Return all clock names"
	remove_from_collection {collection remove} "Return collection without the given objects"
	sizeof_collection {collection} "Number of objects in a collection"
	create_clock {-period p [-name n] [-waveform {r f}] [ports]} "Define a clock (recorded for write_sdc and timing)"
	set_input_delay {delay -clock c [-max|-min] ports} "Input external delay (SDC)"
	set_output_delay {delay -clock c [-max|-min] ports} "Output external delay (SDC)"
	set_load {value ports} "Capacitive load on ports (SDC)"
	set_driving_cell {-lib_cell cell [-pin pin] ports} "Drive inputs with a library cell (SDC)"
	set_max_area {area} "Area goal (recorded in the SDC)"
	set_max_transition {value objects} "Maximum transition design rule (SDC)"
	set_clock_uncertainty {value [-setup|-hold] clocks} "Clock uncertainty (SDC)"
	compile {[-ungroup_all] [-map_effort e] [-incremental_mapping]} "Map to target_library keeping the hierarchy"
	compile_ultra {[-no_autoungroup]} "Flatten and map to target_library with timing-driven ABC mapping"
	report_area {[-hierarchy]} "Cell area summary from yosys stat -liberty"
	report_reference {} "Cell references with counts and area"
	report_cell {} "Cells of the current design with reference and area"
	report_qor {} "Timing, cell count and area summary"
	report_timing {[-delay_type max|min] [-max_paths n] [-nworst n] [-from x] [-to x] [-input_pins] [-nets]} "Worst paths (OpenSTA)"
	report_constraint {[-all_violators]} "Constraint violations (OpenSTA)"
	report_power {} "Switching, internal and leakage power (OpenSTA, default activity)"
	write {-format verilog|ddc [-hierarchy] -output file} "Write the netlist (ddc is written as Yosys JSON)"
	write_file {-format verilog|ddc [-hierarchy] -output file} "Same as write"
	write_sdc {file} "Write the recorded constraints as SDC"
} { shell::doc $cmd $usage $summary }

shell::main "dc_shell> "
