# Timing intent for the PWM template (used by static timing analysis in a later release).
create_clock -name clk -period 10.0 [get_ports clk]
set_input_delay  2.0 -clock clk [get_ports {rst en duty[*]}]
set_output_delay 2.0 -clock clk [get_ports out]
