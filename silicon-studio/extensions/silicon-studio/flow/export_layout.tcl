# Silicon Studio - export an OpenDB checkpoint as compact JSON for the layout viewer (media/layout.js).
#   SILICON_ODB=<abs .odb> SILICON_LAYOUT_OUT=<abs .json> openroad -no_init -no_splash -exit export_layout.tcl
# Works on any checkpoint after floorplan; unplaced instances and IO pins without shapes are skipped and counted.
#
# JSON format, version 1. Coordinates are integer database units (microns = value / dbu); a rect is x0,y0,x1,y1.
# "flat N" arrays repeat an N-number record; net/layer/inst/viaDef fields are indexes into the tables below.
#   version, design, dbu, die: rect, core: rect | null
#   layers       [{name, type: "routing"|"cut", dir: "H"|"V"|"", level}]  bottom-up stack order
#   rows         flat 4: rect
#   masters      [name]
#   kinds        ["std","macro","tap","fill","endcap","buffer","clock","tie","pad"]
#   insts        {names, data: flat 7: master, kind, fixed (0 placed, 1 locked/firm/cover), rect}
#   nets         {names, start, insts}: instances of net i are insts[start[i] .. start[i+1]-1], driver first
#                (connectivity for flylines; empty for power/ground nets)
#   pins         {names, dirs, nets: [net | -1], data: flat 6: pin, layer, rect}
#   viaDefs      [{name, rects: flat 5: layer, rect relative to the via origin}]
#   wires        flat 6: net, layer, rect   signal routing, segments widened and end-extended like DEF
#   vias         flat 4: net, viaDef, x, y
#   swires       flat 6: net, layer, rect   special (power/ground) wiring from SWires
#   svias        flat 4: net, viaDef, x, y
#   blockages    flat 4: rect               placement blockages
#   obstructions flat 5: layer, rect        routing obstructions
#   unplaced     {insts, pins}

foreach var {SILICON_ODB SILICON_LAYOUT_OUT} {
  if {![info exists ::env($var)]} { puts stderr "export_layout: set $var"; exit 1 }
}
read_db $::env(SILICON_ODB)
set block [ord::get_db_block]
set tech [[ord::get_db] getTech]

proc jstr {s} { return "\"[string map {\\ \\\\ \" \\\" \n \\n \r \\r \t \\t} $s]\"" }
proc jnames {names} { return "\[[join [lmap s $names {jstr $s}] ,]\]" }
proc jnums {nums} { return "\[[join $nums ,]\]" }
proc rect {b} { list [$b xMin] [$b yMin] [$b xMax] [$b yMax] }

# Layers: only routing and cut layers are exported; shapes on other layers are dropped.
set layers {}
foreach l [$tech getLayers] {
  set type [string tolower [$l getType]]
  if {$type ni {routing cut}} { continue }
  set lidx($l) [llength $layers]
  set dir [string map {HORIZONTAL H VERTICAL V NONE ""} [$l getDirection]]
  lappend layers "{\"name\":[jstr [$l getName]],\"type\":\"$type\",\"dir\":\"$dir\",\"level\":[$l getRoutingLevel]}"
}

set viaDefs {}
proc via_def {via} {
  global vidx viaDefs lidx
  if {![info exists vidx($via)]} {
    set rects {}
    foreach b [$via getBoxes] {
      set l [$b getTechLayer]
      if {[info exists lidx($l)]} { lappend rects $lidx($l) {*}[rect $b] }
    }
    set vidx($via) [llength $viaDefs]
    lappend viaDefs "{\"name\":[jstr [$via getName]],\"rects\":[jnums $rects]}"
  }
  return $vidx($via)
}

# Instance kinds: LEF CLASS first, then master-name conventions for libraries that leave cells as plain CORE.
set kinds {std macro tap fill endcap buffer clock tie pad}
proc master_kind {m} {
  if {[$m isPad]} { return pad }
  if {[$m isBlock]} { return macro }
  if {[$m isEndCap]} { return endcap }
  switch -- [$m getType] { CORE_WELLTAP { return tap } CORE_SPACER { return fill } CORE_TIEHIGH - CORE_TIELOW { return tie } }
  set n [$m getName]
  # ponytail: name heuristics; read liberty function if a library breaks them
  if {[regexp -nocase {tap} $n]} { return tap }
  if {[regexp -nocase {fill|decap} $n]} { return fill }
  if {[regexp -nocase {tie|logic[01]|conb} $n]} { return tie }
  if {[regexp -nocase {buf} $n]} { return buffer }
  return std
}
# Clock-tree cells: buffers/inverters/gates driving a net that CTS marked CLOCK.
foreach net [$block getNets] {
  if {[$net getSigType] ne "CLOCK"} { continue }
  foreach it [$net getITerms] { if {[$it isOutputSignal]} { set clockInst([$it getInst]) 1 } }
}

set masters {}; set inames {}; set idata {}; set unplacedInsts 0
foreach inst [$block getInsts] {
  set st [$inst getPlacementStatus]
  if {$st in {NONE UNPLACED}} { incr unplacedInsts; continue }
  set m [$inst getMaster]
  if {![info exists midx($m)]} {
    set midx($m) [llength $masters]
    lappend masters [$m getName]
    set mkind($m) [master_kind $m]
  }
  set kind $mkind($m)
  if {$kind in {std buffer} && [info exists clockInst($inst)]} { set kind clock }
  set iidx($inst) [llength $inames]
  lappend inames [$inst getName]
  lappend idata $midx($m) [lsearch $kinds $kind] [expr {$st in {LOCKED FIRM COVER}}] {*}[rect [$inst getBBox]]
}

set nnames {}; set cstart {}; set cinsts {}
foreach net [$block getNets] {
  set nidx($net) [llength $nnames]
  lappend nnames [$net getName]
  lappend cstart [llength $cinsts]
  if {[$net getSigType] in {POWER GROUND}} { continue }
  set loads {}
  foreach it [$net getITerms] {
    set inst [$it getInst]
    if {![info exists iidx($inst)]} { continue }
    if {[$it isOutputSignal]} { lappend cinsts $iidx($inst) } else { lappend loads $iidx($inst) }
  }
  lappend cinsts {*}$loads
}
lappend cstart [llength $cinsts]

# Signal routing: walk the dbWire opcode stream (DEF path semantics) and emit one rect per segment/patch.
foreach op {PATH JUNCTION SHORT VWIRE POINT POINT_EXT VIA TECH_VIA RECT RULE END_DECODE} {
  set OP($op) [set odb::dbWireDecoder_$op]
}
proc width {layer ndr} {
  global wcache
  if {![info exists wcache($layer,$ndr)]} {
    set w [$layer getWidth]
    if {$ndr ne ""} {
      set lr [$ndr getLayerRule $layer]
      if {$lr ne "NULL"} { set w [$lr getWidth] }
    }
    set wcache($layer,$ndr) $w
  }
  return $wcache($layer,$ndr)
}
set wires {}; set vias {}
set d [odb::dbWireDecoder]
foreach net [$block getNets] {
  set wire [$net getWire]
  if {$wire eq "NULL"} { continue }
  set n $nidx($net)
  $d begin $wire
  set prev {}; set ndr ""; set virtual 0; set layer ""
  while {[set op [$d next]] != $OP(END_DECODE)} {
    if {$op == $OP(PATH) || $op == $OP(JUNCTION) || $op == $OP(SHORT) || $op == $OP(VWIRE)} {
      set prev {}; set ndr ""; set virtual [expr {$op == $OP(VWIRE)}]; set layer [$d getLayer]
    } elseif {$op == $OP(RULE)} {
      set ndr [[$d getRule] getNonDefaultRule]
    } elseif {$op == $OP(VIA) || $op == $OP(TECH_VIA)} {
      set via [expr {$op == $OP(VIA) ? [$d getVia] : [$d getTechVia]}]
      if {$prev ne {}} { lappend vias $n [via_def $via] [lindex $prev 0] [lindex $prev 1] }
      set layer [$d getLayer]
    } elseif {$op == $OP(RECT)} {
      # dbWireDecoder::getRect has no Tcl binding; the four deltas are the op's operands.
      set j [$d getJunctionId]
      lassign $prev px py
      if {$prev ne {} && [info exists lidx($layer)]} {
        lappend wires $n $lidx($layer) [expr {$px + [$wire getData $j]}] [expr {$py + [$wire getData [incr j]]}] \
          [expr {$px + [$wire getData [incr j]]}] [expr {$py + [$wire getData [incr j]]}]
      }
    } elseif {$op == $OP(POINT) || $op == $OP(POINT_EXT)} {
      set pt [expr {$op == $OP(POINT) ? [concat [$d getPoint] -1] : [$d getPoint_ext]}]
      if {$prev ne {} && !$virtual && [info exists lidx($layer)]} {
        lassign $prev x0 y0 e0
        lassign $pt x1 y1 e1
        set hw [expr {[width $layer $ndr] / 2}]
        if {$e0 < 0} { set e0 $hw }
        if {$e1 < 0} { set e1 $hw }
        if {$x0 > $x1 || $y0 > $y1} { lassign [list $x1 $y1 $e1 $x0 $y0 $e0] x0 y0 e0 x1 y1 e1 }
        if {$y0 == $y1 && $x0 != $x1} {
          lappend wires $n $lidx($layer) [expr {$x0 - $e0}] [expr {$y0 - $hw}] [expr {$x1 + $e1}] [expr {$y0 + $hw}]
        } elseif {$x0 == $x1 && $y0 != $y1} {
          lappend wires $n $lidx($layer) [expr {$x0 - $hw}] [expr {$y0 - $e0}] [expr {$x0 + $hw}] [expr {$y1 + $e1}]
        }
      }
      set prev $pt
    }
  }
}

set swires {}; set svias {}
foreach net [$block getNets] {
  set n $nidx($net)
  foreach sw [$net getSWires] {
    foreach b [$sw getWires] {
      if {[$b isVia]} {
        set via [$b getTechVia]
        if {$via eq "NULL"} { set via [$b getBlockVia] }
        lappend svias $n [via_def $via] {*}[$b getViaXY]
      } elseif {[info exists lidx([set l [$b getTechLayer]])]} {
        lappend swires $n $lidx($l) {*}[rect $b]
      }
    }
  }
}

set pnames {}; set pdirs {}; set pnets {}; set pdata {}; set unplacedPins 0
foreach bt [$block getBTerms] {
  set shapes {}
  foreach bp [$bt getBPins] {
    foreach b [$bp getBoxes] {
      set l [$b getTechLayer]
      lappend shapes [expr {[info exists lidx($l)] ? $lidx($l) : -1}] {*}[rect $b]
    }
  }
  if {$shapes eq {}} { incr unplacedPins; continue }
  set p [llength $pnames]
  foreach {l x0 y0 x1 y1} $shapes { lappend pdata $p $l $x0 $y0 $x1 $y1 }
  lappend pnames [$bt getName]
  lappend pdirs [$bt getIoType]
  set net [$bt getNet]
  lappend pnets [expr {$net ne "NULL" && [info exists nidx($net)] ? $nidx($net) : -1}]
}

set rows {}
foreach r [$block getRows] { lappend rows {*}[rect [$r getBBox]] }
set blockages {}
foreach bk [$block getBlockages] { lappend blockages {*}[rect [$bk getBBox]] }
set obstructions {}
foreach ob [$block getObstructions] {
  set b [$ob getBBox]
  if {[info exists lidx([set l [$b getTechLayer]])]} { lappend obstructions $lidx($l) {*}[rect $b] }
}
set core [rect [$block getCoreArea]]
set core [expr {[lindex $core 2] > [lindex $core 0] ? [jnums $core] : "null"}]

set f [open $::env(SILICON_LAYOUT_OUT) w]
puts $f "{\"version\":1,\"design\":[jstr [$block getName]],\"dbu\":[$tech getDbUnitsPerMicron],\
\"die\":[jnums [rect [$block getDieArea]]],\"core\":$core,\
\"layers\":\[[join $layers ,]\],\"rows\":[jnums $rows],\"masters\":[jnames $masters],\"kinds\":[jnames $kinds],\
\"insts\":{\"names\":[jnames $inames],\"data\":[jnums $idata]},\
\"nets\":{\"names\":[jnames $nnames],\"start\":[jnums $cstart],\"insts\":[jnums $cinsts]},\
\"pins\":{\"names\":[jnames $pnames],\"dirs\":[jnames $pdirs],\"nets\":[jnums $pnets],\"data\":[jnums $pdata]},\
\"viaDefs\":\[[join $viaDefs ,]\],\"wires\":[jnums $wires],\"vias\":[jnums $vias],\
\"swires\":[jnums $swires],\"svias\":[jnums $svias],\"blockages\":[jnums $blockages],\"obstructions\":[jnums $obstructions],\
\"unplaced\":{\"insts\":$unplacedInsts,\"pins\":$unplacedPins}}"
close $f
puts "export_layout: [llength $inames] instances, [llength $nnames] nets, [expr {[llength $wires] / 6}] wire shapes,\
 [expr {[llength $vias] / 4}] vias, [expr {[llength $swires] / 6}] special shapes -> $::env(SILICON_LAYOUT_OUT)"
