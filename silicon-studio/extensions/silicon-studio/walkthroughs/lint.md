## Lint

Silicon Studio runs **Verilator** (`--lint-only -Wall`), or **Icarus Verilog** when Verilator is missing, followed by a **Yosys** elaboration that checks hierarchy, drivers and latches.

Findings land in the **Problems** panel with file, line and column. Change a rule's severity in `silicon.json`:

```json
"lint": { "severity": { "UNUSEDSIGNAL": "off", "WIDTHTRUNC": "error" } }
```

Files are linted on save (setting `siliconStudio.lintOnSave`).
