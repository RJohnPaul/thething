## A project is a folder with `silicon.json`

`silicon.json` names the **top module**, the **RTL sources**, the **testbench**, synthesis options and an optional **liberty** cell library. The editor validates it as you type.

The template is a PWM generator (`rtl/`), a self-checking testbench (`tb/`), SDC constraints and a small demo cell library (`lib/silicon_demo.lib`, fictional data for learning).

Every job snapshots its inputs into `.silicon/runs/<run-id>/`, so editing files never changes a job that is already running.
