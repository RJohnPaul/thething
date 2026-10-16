`timescale 1ns / 1ps

// PWM generator: out is high for `duty` cycles out of every 2**WIDTH cycles.
// Top-level module of the template project (see "top" in silicon.json).
module pwm #(
    parameter WIDTH = 8
) (
    input  wire             clk,
    input  wire             rst,
    input  wire             en,
    input  wire [WIDTH-1:0] duty,
    output reg              out
);
    wire [WIDTH-1:0] count;
    wire             lt;

    counter #(.WIDTH(WIDTH)) u_counter (
        .clk   (clk),
        .rst   (rst),
        .en    (en),
        .count (count)
    );

    comparator #(.WIDTH(WIDTH)) u_cmp (
        .a  (count),
        .b  (duty),
        .lt (lt)
    );

    // Register the output so it is glitch-free.
    always @(posedge clk) begin
        if (rst)
            out <= 1'b0;
        else
            out <= lt & en;
    end
endmodule
