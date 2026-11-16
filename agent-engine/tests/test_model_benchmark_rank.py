import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from model_benchmark_rank import rank, to_markdown  # noqa: E402


def row(model, task_type, n, **metrics):
    base = {
        "model": model,
        "task_type": task_type,
        "n": str(n),
        "task_completion_rate": "",
        "judge_quality_score_mean": "",
        "tool_call_error_rate": "",
        "human_nudges_per_task": "",
        "user_frustration_rate": "",
        "cost_per_completed_task_usd": "",
    }
    base.update({k: str(v) for k, v in metrics.items()})
    return base


def test_better_model_ranks_first_with_formula_weights():
    rows = [
        row("a", "research", 20, task_completion_rate=0.9, tool_call_error_rate=0.1),
        row("b", "research", 20, task_completion_rate=0.5, tool_call_error_rate=0.3),
    ]
    result = rank(rows)
    ranked = result["task_types"]["research"]
    # two models: z = +1/-1 per metric. a: 0.30*1 - 0.15*(-1) = 0.45
    assert [r["model"] for r in ranked] == ["a", "b"]
    assert ranked[0]["score"] == 0.45
    assert ranked[1]["score"] == -0.45


def test_buckets_below_min_n_and_overall_rows_excluded():
    rows = [
        row("a", "OVERALL", 100, task_completion_rate=1.0),
        row("a", "research", 14, task_completion_rate=1.0),
        row("b", "research", 20, task_completion_rate=0.1),
        row("c", "research", 20, task_completion_rate=0.2),
    ]
    result = rank(rows)
    assert [r["model"] for r in result["task_types"]["research"]] == ["c", "b"]
    assert "OVERALL" not in result["task_types"]


def test_single_model_task_type_is_not_ranked():
    result = rank([row("a", "seo", 50, task_completion_rate=0.8)])
    assert result["task_types"] == {}
    assert result["models"] == []
    assert "nothing to rank" in to_markdown(result)


def test_missing_metric_and_zero_spread_are_neutral():
    rows = [
        row("a", "t", 20, judge_quality_score_mean=4.0, user_frustration_rate=0.1),
        row("b", "t", 20, judge_quality_score_mean="n/a", user_frustration_rate=0.1),
        row("c", "t", 20, judge_quality_score_mean=2.0, user_frustration_rate=0.1),
    ]
    scores = {r["model"]: r["score"] for r in rank(rows)["task_types"]["t"]}
    assert scores == {"a": 0.2, "b": 0.0, "c": -0.2}


def test_model_score_is_n_weighted_across_task_types():
    rows = [
        row("a", "t1", 30, task_completion_rate=1.0),
        row("b", "t1", 30, task_completion_rate=0.0),
        row("a", "t2", 10 + 5, task_completion_rate=0.0),
        row("b", "t2", 15, task_completion_rate=1.0),
    ]
    models = {m["model"]: m for m in rank(rows)["models"]}
    # a: (0.30*30 + -0.30*15) / 45 = 0.1
    assert models["a"]["score"] == 0.1
    assert models["b"]["score"] == -0.1
    assert models["a"]["n"] == 45
