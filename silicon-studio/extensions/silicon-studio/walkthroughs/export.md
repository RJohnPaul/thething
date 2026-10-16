## Verify and export

**Check Equivalence** uses Yosys `equiv_make` / `equiv_induct` to prove that the netlist matches the RTL. A result is reported as *proven* or *inconclusive*, never just "ok".

**Export Handoff Bundle** writes `exports/<name>-<time>.zip` with the exact source snapshot, the netlist, reports, logs, waveforms, every run manifest and a `manifest.json` of SHA-256 checksums and tool versions.

Any run can be **reproduced** from its recorded inputs. Silicon Studio then reports whether the outputs are byte-identical.
