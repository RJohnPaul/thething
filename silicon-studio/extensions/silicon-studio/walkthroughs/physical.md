## Place and route to GDSII

Set a platform in `silicon.json` and synthesis maps to its standard cells:

```json
"physical": {
	"platform": "nangate45",
	"utilization": 40, "aspectRatio": 1, "coreMargin": 2,
	"scenarios": [
		{ "name": "util30", "utilization": 30 },
		{ "name": "fixed-die", "dieArea": [0, 0, 60, 60], "coreArea": [4, 4, 56, 56] }
	]
}
```

**Run Place & Route** executes the OpenROAD stages, each with a checkpoint:

1. floorplan
2. power grid
3. placement
4. clock tree
5. routing
6. parasitic extraction and signoff timing/power

KLayout's engine then merges the routed design with the cell layouts into `6_final.gds`.

- **Explore Floorplan Scenarios** runs several floorplans and compares die area, wirelength, timing and DRC side by side.
- **Layout Viewer** shows each stage interactively.
- **DC Shell / ICC2 Shell / PrimeTime Shell** (terminal profiles) accept familiar Synopsys-style commands on top of Yosys and OpenROAD.
