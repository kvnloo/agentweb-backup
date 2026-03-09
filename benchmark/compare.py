#!/usr/bin/env python3
"""Compare two benchmark runs side-by-side.

Usage:
    python compare.py <baseline_label> <new_label>
    python compare.py run-20260307-120000 run-20260307-140000
"""

import argparse
import json
import sys
from pathlib import Path


def load_run_meta(label: str) -> dict:
    path = Path("runs") / f"{label}.json"
    if not path.exists():
        print(f"Error: Run metadata not found at {path}")
        print("Available runs:")
        runs_dir = Path("runs")
        if runs_dir.exists():
            for f in sorted(runs_dir.glob("*.json")):
                print(f"  {f.stem}")
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def aggregate_metrics(run_meta: dict) -> dict[str, list]:
    """Aggregate all metrics across scenario runs into {check_name: [values]}."""
    aggregated = {}
    for _run_name, metrics in run_meta.get("metrics", {}).items():
        for check_name, value in metrics.items():
            if check_name not in aggregated:
                aggregated[check_name] = []
            aggregated[check_name].append(value)
    return aggregated


def summarize(values: list) -> tuple[str, float | None]:
    """Compute aggregate display string and numeric value."""
    numeric = [v for v in values if isinstance(v, (int, float))]
    if numeric:
        avg = sum(numeric) / len(numeric)
        return f"{avg:.2f}", avg
    else:
        passed = sum(1 for v in values if v is True or v == "pass" or v == "true")
        total = len(values)
        rate = passed / total if total > 0 else 0
        return f"{passed}/{total} ({rate:.0%})", rate


def main():
    parser = argparse.ArgumentParser(description="Compare two benchmark runs")
    parser.add_argument("baseline", help="Label of the baseline run")
    parser.add_argument("new", help="Label of the new run")
    args = parser.parse_args()

    baseline_meta = load_run_meta(args.baseline)
    new_meta = load_run_meta(args.new)

    print(f"Comparing:")
    print(f"  Baseline: {args.baseline} (model={baseline_meta['model']})")
    print(f"  New:      {args.new} (model={new_meta['model']})")
    print()

    baseline_agg = aggregate_metrics(baseline_meta)
    new_agg = aggregate_metrics(new_meta)

    all_checks = sorted(set(list(baseline_agg.keys()) + list(new_agg.keys())))

    header = f"{'Check':<40} {'Baseline':<15} {'New':<15} {'Delta':<10}"
    print(header)
    print("-" * len(header))

    improvements = 0
    regressions = 0

    for check in all_checks:
        b_values = baseline_agg.get(check, [])
        n_values = new_agg.get(check, [])

        b_display, b_num = summarize(b_values) if b_values else ("N/A", None)
        n_display, n_num = summarize(n_values) if n_values else ("N/A", None)

        if b_num is not None and n_num is not None:
            delta = n_num - b_num
            if delta > 0.01:
                delta_str = f"+{delta:.2f} ^"
                improvements += 1
            elif delta < -0.01:
                delta_str = f"{delta:.2f} v"
                regressions += 1
            else:
                delta_str = "="
        else:
            delta_str = "N/A"

        print(f"{check:<40} {b_display:<15} {n_display:<15} {delta_str:<10}")

    print()
    unchanged = len(all_checks) - improvements - regressions
    print(f"Summary: {improvements} improvements, {regressions} regressions, {unchanged} unchanged")

    if regressions > 0:
        print("\nWarning: regressions detected. Review before applying changes.")
    elif improvements > 0:
        print("\nAll checks stable or improved. Safe to apply changes.")


if __name__ == "__main__":
    main()
