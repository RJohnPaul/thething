"""Merge a routed DEF with the standard-cell GDS into one GDSII file.

usage: python def2gds.py --platform-tcl-json <platform.json> --def <6_final.def>
                         --out <6_final.gds> [--top <name>]

Uses the KLayout Python module (import klayout.db), not the KLayout app. The DEF
is read through the platform's KLayout tech file (layer map) with the platform
LEFs; the LEF placeholder cells are then emptied and filled from the cell GDS.
Exit code 1 when a placed cell has no GDS, a cell is orphaned, or on any error.

Adapted from OpenROAD-flow-scripts flow/util/def2stream.py (BSD-3-Clause,
Copyright (c) 2018-2025, The Regents of the University of California and
The OpenROAD Authors).
"""
import argparse
import json
import os
import sys

import klayout.db as db


def merge(platform_json, def_file, out_file, top_name=None):
    plat_dir = os.path.dirname(os.path.abspath(platform_json))
    with open(platform_json, encoding='utf-8') as f:
        plat = json.load(f)

    def path(rel):
        return os.path.join(plat_dir, rel)

    tech = db.Technology()
    tech.load(path(plat['klayoutLyt']))
    options = tech.load_layout_options
    options.lefdef_config.lef_files = [path(plat['techLef'])] + [path(f) for f in plat['scLef']]

    layout = db.Layout()
    layout.read(def_file, options)
    if top_name is None:
        top_name = layout.top_cell().name
    top = layout.cell(top_name)
    if top is None:
        raise RuntimeError(f"top cell '{top_name}' not found in {def_file}")

    # Empty the LEF-derived cells so the GDS supplies their contents; keep the
    # vias KLayout builds from LEF/DEF (VIA_*) and DEF fill.
    for cell in layout.each_cell():
        if cell.cell_index() != top.cell_index() and not cell.name.startswith('VIA_') \
                and not cell.name.endswith('_DEF_FILL'):
            cell.clear()
    for gds in plat['gds']:
        print(f'[INFO] reading {path(gds)}')
        layout.read(path(gds))

    # Copy only the top cell's tree, dropping unused library cells.
    merged = db.Layout()
    merged.dbu = layout.dbu
    merged.create_cell(top_name).copy_tree(layout.cell(top_name))

    errors = 0
    for cell in merged.each_cell():
        if cell.is_empty():
            print(f"[ERROR] cell '{cell.name}' has no matching GDS cell; it will be empty")
            errors += 1
        elif cell.name != top_name and cell.parent_cells() == 0:
            print(f"[ERROR] orphan cell '{cell.name}'")
            errors += 1
    # No timestamps: identical inputs give a byte-identical GDSII (run reproduction compares outputs).
    options = db.SaveLayoutOptions()
    options.gds2_write_timestamps = False
    merged.write(out_file, options)
    instances = sum(1 for _ in merged.cell(top_name).each_inst())
    print(f'[INFO] wrote {out_file}: top {top_name}, {instances} instances, {merged.cells()} cells, {errors} errors')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--platform-tcl-json', required=True, help='platform.json of the platform')
    parser.add_argument('--def', dest='def_file', required=True, help='routed DEF (6_final.def)')
    parser.add_argument('--out', required=True, help='output GDS path')
    parser.add_argument('--top', help='top cell name (default: the DEF design)')
    args = parser.parse_args()
    try:
        errors = merge(args.platform_tcl_json, args.def_file, args.out, args.top)
    except Exception as e:  # noqa: BLE001 - report any reader/writer failure as exit 1
        print(f'[ERROR] {e}')
        return 1
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
