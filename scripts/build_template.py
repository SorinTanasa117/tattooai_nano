#!/usr/bin/env python3
"""
Build a "universal" ComfyUI workflow template from `final.json`.

`final.json` is the hand-tuned upstream workflow (it contains hard-coded
filenames like `f1daae0c-...jpg` and `download.jpg`, plus the developer's
personal `widgets_values`). This script produces a **template** that:

  * contains placeholder sentinels at every per-render injection point
    (e.g. `"__BODY_FILENAME__"`, `"__TATTOO_FILENAME__"`, `__COMPOSITE_X__`,
    `__COMPOSITE_Y__`, `__ROTATION_DEG__`, `__TATTOO_WIDTH__`),
  * preserves every model loader, sampler and link exactly as authored,
  * stays in ComfyUI's "nodes / links" JSON shape so it can be POSTed to
    `/prompt` after substitution.

Patch mapping (kept in sync with scripts/patch_workflow.py):

    node 1   LoadImage              widgets_values[0] -> body filename
    node 2   LoadImage              widgets_values[0] -> tattoo filename
    node 21  ImageRotate            widgets_values[0] -> "N degrees" string
    node 22  ResizeImageMaskNode    widgets_values[1] -> tattoo width (px)
    node 203 ImageCompositeMasked  widgets_values[0] -> composite X
                                   widgets_values[1] -> composite Y

Usage:
    python scripts/build_template.py \
        --source final.json \
        --output merged-tattoo-rotator-v6.json

    # Or with the defaults (final.json -> merged-tattoo-rotator-v6.json):
    python scripts/build_template.py
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# Slot table -- every per-render injection point, in one place.
# ---------------------------------------------------------------------------
# Format:
#   node_id        -> ComfyUI node id in final.json
#   node_type      -> sanity check (must match `type` field)
#   title          -> human label
#   slots          -> list of {index, key, placeholder, kind}
#                       index      : position inside widgets_values
#                       key        : payload field name (informational)
#                       placeholder: sentinel that goes into the template
#                       kind       : 'str' | 'int' | 'rotation_str' | 'bool'
SLOTS = [
    {
        "node_id": 1, "node_type": "LoadImage", "title": "Body photo loader",
        "slots": [
            {"index": 0, "key": "body_filename", "placeholder": "__BODY_FILENAME__", "kind": "str"},
        ],
    },
    {
        "node_id": 2, "node_type": "LoadImage", "title": "Tattoo design loader",
        "slots": [
            {"index": 0, "key": "tattoo_filename", "placeholder": "__TATTOO_FILENAME__", "kind": "str"},
        ],
    },
    {
        # Node 218 = RotateImage from comfyui-instantid-faceswap. Unlike the old
        # ImageRotate (COMBO of ['none','90','180','270']), this one accepts
        # any integer 0-359 for the angle, so we can pass full-rotation values.
        "node_id": 218, "node_type": "RotateImage", "title": "Tattoo rotator",
        "slots": [
            {"index": 0, "key": "rotation", "placeholder": "__ROTATION_DEG__", "kind": "rotation_int"},
        ],
    },
    {
        # Node 22 = ResizeImageMaskNode (comfy-core v3 schema). In v3 the
        # node takes two distinct inputs:
        #   widgets[0] = resize_type choice (e.g. "scale width")
        #   widgets[1] = the matching sub-field (width for SCALE_WIDTH)
        #   widgets[2] = scale_method / interpolation (e.g. "lanczos")
        # Only widgets[1] is patched per-render; widgets[0] and widgets[2]
        # are baked as constants below.
        "node_id": 22, "node_type": "ResizeImageMaskNode", "title": "Tattoo resizer",
        "slots": [
            {"index": 1, "key": "width",        "placeholder": "__TATTOO_WIDTH__",  "kind": "int"},
        ],
    },
    {
        "node_id": 203, "node_type": "ImageCompositeMasked", "title": "Composite placement",
        "slots": [
            {"index": 0, "key": "composite_x", "placeholder": "__COMPOSITE_X__", "kind": "int"},
            {"index": 1, "key": "composite_y", "placeholder": "__COMPOSITE_Y__", "kind": "int"},
        ],
    },
]

# A small header that the patcher writes into the patched workflow so we
# can tell at a glance that the substitution actually happened.
TEMPLATE_MARKER = "inkframe:universal-template/v1"


def _find_node(nodes: List[Dict[str, Any]], node_id: int) -> Dict[str, Any]:
    for n in nodes:
        if n.get("id") == node_id:
            return n
    raise KeyError(f"node id={node_id} not found in source workflow")


def build_template(source: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of `source` with sentinels written into the slot nodes."""
    wf = json.loads(json.dumps(source))  # deep copy
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("source workflow has no `nodes` array")

    summary: List[Dict[str, Any]] = []
    for slot in SLOTS:
        node = _find_node(nodes, slot["node_id"])
        if node.get("type") != slot["node_type"]:
            print(
                f"[warn] node {slot['node_id']} type mismatch: "
                f"expected {slot['node_type']!r}, got {node.get('type')!r}",
                file=sys.stderr,
            )
        widgets = node.setdefault("widgets_values", [])
        # Extend widgets if the source is missing trailing slots.
        while len(widgets) <= max(s["index"] for s in slot["slots"]):
            widgets.append(None)
        for s in slot["slots"]:
            before = widgets[s["index"]]
            widgets[s["index"]] = s["placeholder"]
            summary.append({
                "node_id": slot["node_id"],
                "title": node.get("title"),
                "key": s["key"],
                "index": s["index"],
                "before": before,
                "after": s["placeholder"],
            })

    # Hardcoded constants -- not user-tunable. These replace widget values
    # that the upstream workflow has but no longer need user input. For
    # node 22 (ResizeImageMaskNode v3) widgets_values is laid out as:
    #   [0] = resize_type choice (string),  [1] = patched width,
    #   [2] = scale_method (interpolation). We bake choices [0] and [2]
    #   so the renderer always picks "scale width" + "lanczos".
    for node in nodes:
        if node.get("id") == 22 and node.get("type") == "ResizeImageMaskNode":
            widgets = node.setdefault("widgets_values", [])
            while len(widgets) < 3:
                widgets.append(None)
            widgets[0] = "scale width"
            widgets[2] = "lanczos"
            summary.append({
                "node_id": 22, "title": node.get("title"),
                "key": "_constant:resize_type+scale_method",
                "index": None,
                "before": list(widgets),
                "after": list(widgets),
            })

    # Stamp a header so we can detect a template-vs-exported-workflow later.
    wf["id"] = "merged-tattoo-rotator-v6"
    wf["properties"] = dict(wf.get("properties") or {})
    wf["properties"]["inkframe"] = {
        "marker": TEMPLATE_MARKER,
        "slots": SLOTS,
        "notes": (
            "Auto-generated by scripts/build_template.py from final.json. "
            "Patch in scripts/patch_workflow.py replaces each __PLACEHOLDER__ "
            "with the live value from the InkFrame web-app payload."
        ),
    }
    return {"workflow": wf, "summary": summary}


def main() -> int:
    p = argparse.ArgumentParser(description="Build the InkFrame universal workflow template from final.json")
    p.add_argument("--source", "-s", default="final.json", help="Source workflow (default: final.json)")
    p.add_argument("--output", "-o", default="merged-tattoo-rotator-v6.json", help="Output template path")
    p.add_argument("--print-summary", action="store_true", help="Print the slot mapping summary")
    args = p.parse_args()

    src_path = Path(args.source)
    if not src_path.exists():
        print(f"[fatal] source workflow not found: {src_path.resolve()}", file=sys.stderr)
        return 1
    with src_path.open("r", encoding="utf-8") as fh:
        source = json.load(fh)

    built = build_template(source)
    out_path = Path(args.output)
    out_path.write_text(json.dumps(built["workflow"], indent=2), encoding="utf-8")

    print(f"[ok] wrote universal template: {out_path.resolve()}", file=sys.stderr)
    print(f"     marker: {TEMPLATE_MARKER}", file=sys.stderr)
    if args.print_summary:
        print("\nSlot mapping:", file=sys.stderr)
        for row in built["summary"]:
            print(
                f"  node {row['node_id']:3}  [{row['title']}]  "
                f"widgets[{row['index']}] = {row['after']!r}  "
                f"(was {row['before']!r}, payload key: {row['key']})",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
