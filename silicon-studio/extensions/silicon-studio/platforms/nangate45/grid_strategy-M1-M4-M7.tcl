####################################
# global connections
####################################
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {^VDD$} -power
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {^VDDPE$}
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {^VDDCE$}
add_global_connection -net {VSS} -inst_pattern {.*} -pin_pattern {^VSS$} -ground
add_global_connection -net {VSS} -inst_pattern {.*} -pin_pattern {^VSSE$}
global_connect
####################################
# voltage domains
####################################
set_voltage_domain -name {CORE} -power {VDD} -ground {VSS}
####################################
# standard cell grid
####################################
define_pdn_grid -name {grid} -voltage_domains {CORE} -pins {metal7}
# Silicon Studio patch (see README.md): ORFS sizes these strap pitches for large blocks and PDNGen stops with
# PDN-0185 on a smaller core, so pitches and offsets shrink until every power/ground pair fits (scale 1 = ORFS),
# rounded to 0.01 um to stay on the manufacturing grid.
set ::pdn_scale [apply {{} {
  set block [ord::get_db_block]
  set core [$block getCoreArea]
  set side [expr {min([$core dx], [$core dy]) / double([$block getDbUnitsPerMicron])}]
  return [expr {min(1.0, 0.95 * ($side - 0.48) / (2 + 28.0), 0.95 * ($side - 1.40) / (2 + 15.0))}]
}}]
if { $::pdn_scale < 1 } { puts "Silicon Studio: small core, power strap pitch scaled by [format %.2f $::pdn_scale]" }
add_pdn_stripe -grid {grid} -layer {metal1} -width {0.17} -pitch {2.4} -offset {0} -followpins
add_pdn_stripe -grid {grid} -layer {metal4} -width {0.48} -pitch [format %.2f [expr {56.0 * $::pdn_scale}]] -offset [format %.2f [expr {2 * $::pdn_scale}]]
add_pdn_stripe -grid {grid} -layer {metal7} -width {1.40} -pitch [format %.2f [expr {30.0 * $::pdn_scale}]] -offset [format %.2f [expr {2 * $::pdn_scale}]]
add_pdn_connect -grid {grid} -layers {metal1 metal4}
add_pdn_connect -grid {grid} -layers {metal4 metal7}
####################################
# macro grids: dropped by Silicon Studio (see README.md), the flow places no macros and
# PDNGen checks these strap pitches against the core even when no macro is present.
