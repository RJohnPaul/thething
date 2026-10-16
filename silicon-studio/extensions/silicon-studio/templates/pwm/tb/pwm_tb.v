`timescale 1ns / 1ps

// Self-checking testbench: measures the PWM duty cycle for several duty values and
// prints PASS or FAIL. Silicon Studio reads that verdict from the simulation log.
module pwm_tb;
    localparam WIDTH  = 4;
    localparam PERIOD = 1 << WIDTH;

    reg              clk  = 1'b0;
    reg              rst  = 1'b1;
    reg              en   = 1'b0;
    reg  [WIDTH-1:0] duty = {WIDTH{1'b0}};
    wire             out;

    integer errors = 0;
    integer high;
    integer i;
    integer k;

    pwm #(.WIDTH(WIDTH)) dut (
        .clk  (clk),
        .rst  (rst),
        .en   (en),
        .duty (duty),
        .out  (out)
    );

    always #5 clk = ~clk;

    task check_duty(input [WIDTH-1:0] value);
        begin
            duty = value;
            // Let the new duty value propagate for one full period, then count.
            repeat (PERIOD) @(posedge clk);
            high = 0;
            for (k = 0; k < 2 * PERIOD; k = k + 1) begin
                @(posedge clk);
                if (out === 1'b1)
                    high = high + 1;
            end
            if (high !== 2 * value) begin
                $display("FAIL: duty=%0d expected %0d high cycles, measured %0d", value, 2 * value, high);
                errors = errors + 1;
            end else begin
                $display("ok:   duty=%0d -> %0d/%0d cycles high", value, high, 2 * PERIOD);
            end
        end
    endtask

    initial begin
        $dumpfile("wave.vcd");
        $dumpvars(0, pwm_tb);

        repeat (3) @(posedge clk);
        rst <= 1'b0;
        en  <= 1'b1;

        for (i = 0; i < PERIOD - 1; i = i + 5)
            check_duty(i);
        check_duty(PERIOD - 1);

        if (errors == 0)
            $display("PASS: all duty-cycle checks passed");
        else
            $display("FAIL: %0d duty-cycle check(s) failed", errors);
        $finish;
    end
endmodule
