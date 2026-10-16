## Simulate

The testbench is compiled with **Icarus Verilog** and run with `vvp`. The run is

- **passed** when the log prints `PASS` and nothing failed,
- **failed** when it prints `FAIL`, hits `$error`/`$fatal`, or exits non-zero,
- **inconclusive** when it finishes without a verdict.

A passing simulation is not proof of functional correctness. The VCD opens in the waveform viewer (zoom, pan, cursors, radix, PNG export).
