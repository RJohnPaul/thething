####################################
# global connections
####################################
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {^VDD$} -power
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {^VDDPE$}
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {^VDDCE$}
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {VPWR}
add_global_connection -net {VDD} -inst_pattern {.*} -pin_pattern {VPB}
add_global_connection -net {VSS} -inst_pattern {.*} -pin_pattern {^VSS$} -ground
add_global_connection -net {VSS} -inst_pattern {.*} -pin_pattern {^VSSE$}
add_global_connection -net {VSS} -inst_pattern {.*} -pin_pattern {VGND}
add_global_connection -net {VSS} -inst_pattern {.*} -pin_pattern {VNB}
global_connect
####################################
# voltage domains
####################################
set_voltage_domain -name {CORE} -power {VDD} -ground {VSS}
####################################
# standard cell grid
####################################
define_pdn_grid -name {grid} -voltage_domains {CORE} -pins {met5}
# Silicon Studio patch (see README.md): ORFS sizes these strap pitches for large blocks and PDNGen stops with
# PDN-0185 on a smaller core, so pitches and offsets shrink until every power/ground pair fits (scale 1 = ORFS),
# rounded to 0.01 um to stay on the manufacturing grid.
set ::pdn_scale [apply {{} {
  set block [ord::get_db_block]
  set core [$block getCoreArea]
  set side [expr {min([$core dx], [$core dy]) / double([$block getDbUnitsPerMicron])}]
  return [expr {min(1.0, 0.95 * ($side - 1.6) / (13.57 + 13.57), 0.95 * ($side - 1.6) / (13.6 + 13.6))}]
}}]
if { $::pdn_scale < 1 } { puts "Silicon Studio: small core, power strap pitch scaled by [format %.2f $::pdn_scale]" }
add_pdn_stripe -grid {grid} -layer {met1} -width {0.48} -pitch {5.44} -offset {0} -followpins
add_pdn_stripe -grid {grid} -layer {met4} -width {1.600} -pitch [format %.2f [expr {27.140 * $::pdn_scale}]] -offset [format %.2f [expr {13.570 * $::pdn_scale}]]
add_pdn_stripe -grid {grid} -layer {met5} -width {1.600} -pitch [format %.2f [expr {27.200 * $::pdn_scale}]] -offset [format %.2f [expr {13.600 * $::pdn_scale}]]
add_pdn_connect -grid {grid} -layers {met1 met4}
add_pdn_connect -grid {grid} -layers {met4 met5}
####################################
# macro grids
####################################
####################################
# grid for: CORE_macro_grid_1
####################################
define_pdn_grid -name {CORE_macro_grid_1} -voltage_domains {CORE} -macro \
  -orient {R0 R180 MX MY} -halo {2.0 2.0 2.0 2.0} -default -grid_over_boundary
add_pdn_connect -grid {CORE_macro_grid_1} -layers {met4 met5}
####################################
# grid for: CORE_macro_grid_2
####################################
define_pdn_grid -name {CORE_macro_grid_2} -voltage_domains {CORE} -macro \
  -orient {R90 R270 MXR90 MYR90} -halo {2.0 2.0 2.0 2.0} -default -grid_over_boundary
add_pdn_connect -grid {CORE_macro_grid_2} -layers {met4 met5}
