#!/usr/bin/env python3
"""
Patch the InkFrame universal ComfyUI workflow template with values from the
placement payload sent by the web widget.

The template (`merged-tattoo-rotator-v6.json`, produced by
`scripts/build_template.py`) has sentinels such as `__BODY_FILENAME__`,
`__COMPOSITE_X__`, etc. baked into the relevant `widgets_values` slots.
This script replaces each sentinel with the live value from the payload.

Usage:
    # JSON payload via --payload, workflow via --workflow:
    python scripts/patch_workflow.py \
        --workflow merged-tattoo-rotator-v6.json \
        --payload payload.json \
        --output workflow-patched.json \
        --print-summary

    # Pipe the payload through stdin and capture the patched workflow on stdout:
    cat payload.json | python scripts/patch_workflow.py \
        --workflow merged-tattoo-rotator-v6.json > workflow-patched.json

The patched workflow is written to `--output` (if given) and is **also**
printed to stdout (server.js parses the JSON out of stdout).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

# ---------------------------------------------------------------------------
# Slot table — kept in sync with scripts/build_template.py.
# Each slot says:
#   placeholder : the sentinel string the template contains
#   widget_idx  : which widgets_values[] entry to write
#   key         : which payload field to read from
#   kind        : how to coerce the value before writing
#                   str           -> str(value)
#                   int           -> int(value), clamped to >= 0
#                   rotation_str  -> snaps the int to {0,90,180,270} then
#                                    writes "N degrees"
#                   bool          -> bool(value) (for mask feather, etc.)
# ---------------------------------------------------------------------------
SLOTS: List[Dict[str, Any]] = [
    {"placeholder": "__BODY_FILENAME__",  "widget_idx": 0, "key": "body_filename",  "kind": "str"},
    {"placeholder": "__TATTOO_FILENAME__","widget_idx": 0, "key": "tattoo_filename","kind": "str"},
    # Rotation is now a plain integer 0-359 (RotateImage node from
    # comfyui-instantid-faceswap, accepts any value, not just 90-step snaps).
    {"placeholder": "__ROTATION_DEG__",   "widget_idx": 0, "key": "rotation",      "kind": "rotation_int"},
    {"placeholder": "__TATTOO_WIDTH__",   "widget_idx": 1, "key": "width",         "kind": "int"},
    {"placeholder": "__TATTOO_HEIGHT__",  "widget_idx": 2, "key": "height",        "kind": "int"},
    {"placeholder": "__COMPOSITE_X__",    "widget_idx": 0, "key": "composite_x",   "kind": "int"},
    {"placeholder": "__COMPOSITE_Y__",    "widget_idx": 1, "key": "composite_y",   "kind": "int"},
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _coerce(value: Any, kind: str) -> Any:
    if value is None:
        raise ValueError(f"payload value is null for kind={kind}")
    if kind == "str":
        s = str(value).strip()
        if not s:
            raise ValueError("empty string value where a filename was expected")
        return s
    if kind == "int":
        try:
            n = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"expected int, got {value!r}") from exc
        return max(0, n)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        raise ValueError(f"cannot coerce {value!r} to bool")
    if kind == "rotation_str":
        # Legacy: snap to {0,90,180,270} and emit "N degrees" string for the
        # old ImageRotate node. Kept for backward compatibility.
        try:
            deg = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"rotation must be int-like, got {value!r}") from exc
        deg = ((deg % 360) + 360) % 360
        snapped = min((0, 90, 180, 270), key=lambda p: min(abs(p - deg), 360 - abs(p - deg)))
        return f"{snapped} degrees"
    if kind == "rotation_int":
        # New: RotateImage from comfyui-instantid-faceswap accepts any int
        # in [0, 360). No snapping -- free rotation.
        try:
            deg = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"rotation must be int-like, got {value!r}") from exc
        deg = ((deg % 360) + 360) % 360
        # UI uses clockwise convention; RotateImage expects counterclockwise.
        # Convert: ccw = (360 - cw) % 360  (0 stays 0)
        deg = (360 - deg) % 360
        return deg
    raise ValueError(f"unknown slot kind {kind!r}")


def _slot_value(payload: Dict[str, Any], slot: Dict[str, Any]) -> Tuple[Any, bool]:
    """Return (coerced_value, found). found=False means the payload didn't
    supply a value for this slot — we keep the placeholder so the failure
    is obvious downstream."""
    key = slot["key"]
    if key not in payload or payload[key] is None:
        return None, False
    return _coerce(payload[key], slot["kind"]), True


def _walk_nodes(workflow: Dict[str, Any]):
    """Yield (slot_placeholder, node, widgets_list) for every node that has
    `widgets_values`. We search all widgets entries for our sentinels."""
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("template has no `nodes` array")
    for node in nodes:
        widgets = node.get("widgets_values")
        if isinstance(widgets, list):
            yield node, widgets


def patch_workflow(workflow: Dict[str, Any], payload: Dict[str, Any], verbose: bool = False) -> Dict[str, Any]:
    """Mutate `workflow` in place: substitute sentinels with payload values.
    Returns a summary dict for logging."""
    summary: Dict[str, Any] = {"slots": [], "missing_payload_keys": [], "unmatched_placeholders": []}

    slot_by_placeholder = {s["placeholder"]: s for s in SLOTS}

    # Pass 1: replace each sentinel wherever we find it.
    seen_placeholders: set = set()
    for node, widgets in _walk_nodes(workflow):
        for idx, value in enumerate(widgets):
            if not isinstance(value, str):
                continue
            if value not in slot_by_placeholder:
                continue
            slot = slot_by_placeholder[value]
            new_value, found = _slot_value(payload, slot)
            if not found:
                summary["missing_payload_keys"].append({"key": slot["key"], "node_id": node.get("id"), "placeholder": value})
                continue
            widgets[idx] = new_value
            seen_placeholders.add(value)
            summary["slots"].append({
                "node_id": node.get("id"),
                "title": node.get("title"),
                "key": slot["key"],
                "kind": slot["kind"],
                "value": new_value,
            })

    # Any placeholder we never saw -> upstream config drift.
    for s in SLOTS:
        if s["placeholder"] not in seen_placeholders:
            summary["unmatched_placeholders"].append({"placeholder": s["placeholder"], "key": s["key"]})

    if verbose:
        if summary["unmatched_placeholders"]:
            for u in summary["unmatched_placeholders"]:
                print(f"[warn] placeholder {u['placeholder']!r} not found in template (key={u['key']})", file=sys.stderr)
        if summary["missing_payload_keys"]:
            for m in summary["missing_payload_keys"]:
                print(f"[warn] payload missing key {m['key']!r} (node {m['node_id']}, placeholder {m['placeholder']!r})", file=sys.stderr)

    # Hard-fail if absolutely nothing was substituted — that almost certainly
    # means the wrong workflow was passed in.
    if not summary["slots"]:
        raise RuntimeError(
            "no placeholders were substituted — is this really the InkFrame universal template? "
            f"unmatched={summary['unmatched_placeholders']} missing={summary['missing_payload_keys']}"
        )

    # Required-field gate: every slot must have been supplied, otherwise the
    # render will fail inside ComfyUI with a confusing error.
    if summary["missing_payload_keys"]:
        keys = sorted({m["key"] for m in summary["missing_payload_keys"]})
        raise RuntimeError(f"payload missing required fields: {', '.join(keys)}")

    return summary


def main() -> int:
    p = argparse.ArgumentParser(description="Patch the InkFrame universal workflow with a payload")
    p.add_argument("--workflow", "-w", required=True, help="Path to the universal template JSON")
    p.add_argument("--payload",  "-p", help="Path to payload.json (default: read from stdin)")
    p.add_argument("--output",   "-o", help="Write patched workflow here (default: stdout)")
    p.add_argument("--print-summary", action="store_true", help="Print a human summary to stderr")
    args = p.parse_args()

    # Read payload
    if args.payload:
        payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))
    else:
        payload = json.load(sys.stdin)

    # Read template
    wf_path = Path(args.workflow)
    if not wf_path.exists():
        print(f"[fatal] workflow not found: {wf_path.resolve()}", file=sys.stderr)
        return 1
    workflow = json.loads(wf_path.read_text(encoding="utf-8"))

    summary = patch_workflow(workflow, payload, verbose=args.print_summary)

    # Emit patched workflow
    out = json.dumps(workflow, indent=2)
    if args.output:
        Path(args.output).write_text(out, encoding="utf-8")
        print(f"[ok] wrote patched workflow: {Path(args.output).resolve()}", file=sys.stderr)
    else:
        sys.stdout.write(out)
        sys.stdout.write("\n")

    if args.print_summary:
        print("\nPatched slots:", file=sys.stderr)
        for s in summary["slots"]:
            print(f"  node {s['node_id']:3}  [{s['title']}]  {s['key']} = {s['value']!r}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
