`timescale 1ns / 1ps

// Unsigned less-than comparator.
module comparator #(
    parameter WIDTH = 8
) (
    input  wire [WIDTH-1:0] a,
    input  wire [WIDTH-1:0] b,
    output wire             lt
);
    assign lt = (a < b);
endmodule
