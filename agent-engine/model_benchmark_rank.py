#!/usr/bin/env python3
"""Composite model ranking for the Agent Mode model benchmark (ENG-1710 AC3).

Reads the per-(model, task_type) aggregate CSV produced by the benchmark run
(``results.csv``) and emits the z-score composite ranking defined in the
benchmark's scoring.md. Read-only: no AWS/DynamoDB access, no customer data.

Formula (within task type, buckets with n >= MIN_N only):

    z(metric, m, t) = (metric(m,t) - mean_over_models) / stdev_over_models
    CompositeScore(m,t) = 0.30 z(task_completion_rate)
                        + 0.20 z(judge_quality_score_mean)
                        - 0.15 z(tool_call_error_rate)
                        - 0.15 z(human_nudges_per_task)
                        - 0.10 z(user_frustration_rate)
                        - 0.10 z(cost_per_completed_task_usd)
    ModelScore(m) = n-weighted mean of CompositeScore(m,t) over qualifying t

Implementation choices not fixed by scoring.md (documented so they are reviewable):
- stdev is the population stdev across qualifying models in that task type.
- A task type needs >= 2 qualifying models; otherwise there is nothing to compare
  against and it is excluded.
- A missing metric value, or a metric with zero spread, contributes z = 0
  (neutral) rather than dropping the whole bucket.
- The OVERALL rows are ignored; ranking is never pooled across task types.

Usage: python3 model_benchmark_rank.py results.csv [--min-n 15] [--json]
"""

import argparse
import csv
import json
import statistics
import sys
from collections import defaultdict

MIN_N = 15

WEIGHTS = {
    "task_completion_rate": 0.30,
    "judge_quality_score_mean": 0.20,
    "tool_call_error_rate": -0.15,
    "human_nudges_per_task": -0.15,
    "user_frustration_rate": -0.10,
    "cost_per_completed_task_usd": -0.10,
}


def _num(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    value = str(value).strip()
    if value == "" or value.lower() in {"n/a", "none", "nan"}:
        return None
    return float(value)


def load_rows(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def rank(rows, min_n=MIN_N):
    """Return {"task_types": {t: [{model, n, score}...]}, "models": [{model, score, n, task_types}...]}."""
    by_task = defaultdict(list)
    for row in rows:
        task_type = row.get("task_type")
        if not task_type or task_type == "OVERALL" or task_type == "__overall__":
            continue
        n = int(_num(row.get("n")) or 0)
        if n < min_n:
            continue
        by_task[task_type].append({**row, "_n": n})

    task_results = {}
    model_acc = defaultdict(lambda: {"weighted": 0.0, "n": 0, "task_types": []})
    for task_type in sorted(by_task):
        bucket = by_task[task_type]
        if len(bucket) < 2:
            continue
        scores = {r["model"]: 0.0 for r in bucket}
        for metric, weight in WEIGHTS.items():
            values = {r["model"]: _num(r.get(metric)) for r in bucket}
            present = [v for v in values.values() if v is not None]
            if len(present) < 2:
                continue
            mean = statistics.fmean(present)
            stdev = statistics.pstdev(present)
            if stdev == 0:
                continue
            for model, v in values.items():
                if v is not None:
                    scores[model] += weight * (v - mean) / stdev
        ranked = sorted(
            ({"model": r["model"], "n": r["_n"], "score": round(scores[r["model"]], 4)} for r in bucket),
            key=lambda x: (-x["score"], x["model"]),
        )
        task_results[task_type] = ranked
        for entry in ranked:
            acc = model_acc[entry["model"]]
            acc["weighted"] += entry["score"] * entry["n"]
            acc["n"] += entry["n"]
            acc["task_types"].append(task_type)

    models = sorted(
        (
            {"model": m, "score": round(a["weighted"] / a["n"], 4), "n": a["n"], "task_types": a["task_types"]}
            for m, a in model_acc.items()
        ),
        key=lambda x: (-x["score"], x["model"]),
    )
    return {"min_n": min_n, "task_types": task_results, "models": models}


def to_markdown(result):
    lines = [f"# Model composite ranking (MIN_N={result['min_n']})", "", "## Overall", "",
             "| rank | model | score | n | task types |", "|---|---|---|---|---|"]
    for i, m in enumerate(result["models"], 1):
        lines.append(f"| {i} | {m['model']} | {m['score']:.3f} | {m['n']} | {', '.join(m['task_types'])} |")
    for task_type, ranked in result["task_types"].items():
        lines += ["", f"## {task_type}", "", "| rank | model | score | n |", "|---|---|---|---|"]
        for i, r in enumerate(ranked, 1):
            lines.append(f"| {i} | {r['model']} | {r['score']:.3f} | {r['n']} |")
    if not result["models"]:
        lines += ["", "No task type had >= 2 models with n >= MIN_N; nothing to rank."]
    return "\n".join(lines) + "\n"


def main(argv=None):
    p = argparse.ArgumentParser(description="Composite model ranking for the Agent Mode model benchmark.")
    p.add_argument("results_csv")
    p.add_argument("--min-n", type=int, default=MIN_N)
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    result = rank(load_rows(args.results_csv), min_n=args.min_n)
    sys.stdout.write(json.dumps(result, indent=2) + "\n" if args.json else to_markdown(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
