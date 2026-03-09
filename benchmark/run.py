#!/usr/bin/env python3
"""Run benchmark simulations against the staging AgentWeb backend.

Usage:
    python run.py                                           # Run all scenarios with defaults
    python run.py --scenario onboarding                     # Run a single scenario
    python run.py --model anthropic.claude-sonnet-4-20250514  # Specify model
    python run.py --driver power_user                       # Use a specific driver
    python run.py --max-turns 8                             # Override max turns
    python run.py --scenario onboarding --driver new_user   # Specific combination
"""

import argparse
import json
import os
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

from lib.okareo_setup import (
    get_okareo_client,
    create_target,
    create_all_scenarios,
    get_all_check_names,
    SCENARIO_NAMES,
    DRIVER_NAMES,
    DEFAULT_MODEL,
    BUILTIN_CHECKS,
    CUSTOM_CHECKS,
)

# Default driver-scenario pairings (which driver fits which scenario best)
DRIVER_SCENARIO_MAP = {
    "onboarding": "new_user",
    "content_creation": "power_user",
    "lead_management": "technical_user",
    "seo_research": "technical_user",
    "gtm_planning": "power_user",
    "knowledge_base": "confused_user",
    "edge_cases": "adversarial_user",
    "multi_step": "power_user",
}


def run_single_simulation(
    okareo,
    scenario_name: str,
    scenario_obj,
    driver_name: str,
    model: str,
    max_turns: int,
    checks: list[str],
    run_label: str,
):
    """Run a single simulation and return the TestRunItem."""
    target_name = f"emma-staging-{model}"
    full_driver = f"emma-{driver_name}"
    sim_name = f"{run_label}/{scenario_name}/{driver_name}"

    print(f"  Running: {scenario_name} + {driver_name} (max {max_turns} turns)...")

    result = okareo.run_simulation(
        name=sim_name,
        scenario=scenario_obj,
        target=target_name,
        driver=full_driver,
        checks=checks,
        max_turns=max_turns,
        first_turn="driver",
    )

    print(f"    Done. Test run ID: {result.id}")
    return result


def extract_metrics(test_run) -> dict:
    """Extract check scores from a TestRunItem's model_metrics."""
    metrics = {}
    if hasattr(test_run, 'model_metrics') and test_run.model_metrics:
        mm = test_run.model_metrics
        # model_metrics can be a dict or object with additional_properties
        if isinstance(mm, dict):
            metrics = mm
        elif hasattr(mm, 'additional_properties'):
            metrics = mm.additional_properties
        elif hasattr(mm, '__dict__'):
            metrics = {k: v for k, v in mm.__dict__.items() if not k.startswith('_')}
    return metrics


def display_results(test_runs: list):
    """Display results from completed simulation runs."""
    print("\n" + "=" * 70)
    print("BENCHMARK RESULTS")
    print("=" * 70)

    all_metrics = {}

    for run in test_runs:
        run_name = run.name if hasattr(run, 'name') else str(run.id)
        print(f"\n--- {run_name} ---")

        metrics = extract_metrics(run)
        for check_name, value in metrics.items():
            if check_name not in all_metrics:
                all_metrics[check_name] = []
            all_metrics[check_name].append(value)
            print(f"  {check_name}: {value}")

        if hasattr(run, 'app_link') and run.app_link:
            print(f"  View: {run.app_link}")

    # Aggregate summary
    if all_metrics:
        print(f"\n{'=' * 70}")
        print("AGGREGATE SUMMARY")
        print(f"{'=' * 70}")
        for check_name, values in sorted(all_metrics.items()):
            numeric = [v for v in values if isinstance(v, (int, float))]
            if numeric:
                avg = sum(numeric) / len(numeric)
                print(f"  {check_name}: avg={avg:.2f} (n={len(numeric)})")
            else:
                pass_count = sum(1 for v in values if v is True or v == "pass" or v == "true")
                total = len(values)
                print(f"  {check_name}: {pass_count}/{total} passed")


def serialize_metrics(test_runs: list) -> dict:
    """Convert test run metrics to a JSON-serializable dict keyed by run name."""
    result = {}
    for run in test_runs:
        name = run.name if hasattr(run, 'name') else str(run.id)
        result[name] = extract_metrics(run)
    return result


def main():
    parser = argparse.ArgumentParser(description="Run Emma benchmark simulations")
    parser.add_argument(
        "--scenario",
        choices=SCENARIO_NAMES,
        help="Run a single scenario (default: all)",
    )
    parser.add_argument(
        "--driver",
        choices=DRIVER_NAMES,
        help="Use a specific driver for all scenarios (default: auto-select)",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"LLM model ID (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=5,
        help="Maximum conversation turns per simulation (default: 5)",
    )
    parser.add_argument(
        "--label",
        default=None,
        help="Run label for identification (default: timestamp)",
    )
    parser.add_argument(
        "--checks-only",
        choices=["builtin", "custom", "all"],
        default="all",
        help="Which checks to run (default: all)",
    )
    parser.add_argument(
        "--ensure-target",
        action="store_true",
        help="Create/update the target before running (useful if token expired)",
    )
    args = parser.parse_args()

    okareo = get_okareo_client()
    print(f"Connected to Okareo. Model: {args.model}\n")

    # Ensure target exists
    if args.ensure_target:
        print("Ensuring target exists...")
        create_target(okareo, model=args.model, name_suffix=args.model)
        print()

    # Determine which checks to use
    if args.checks_only == "builtin":
        checks = BUILTIN_CHECKS
    elif args.checks_only == "custom":
        checks = [f"emma-{name}" for name in CUSTOM_CHECKS]
    else:
        checks = get_all_check_names()

    # Determine run label
    run_label = args.label or datetime.now().strftime("run-%Y%m%d-%H%M%S")

    # Determine scenarios to run
    scenario_names = [args.scenario] if args.scenario else SCENARIO_NAMES

    # Create/retrieve scenario objects (Okareo needs objects, not just names)
    print("Creating scenario sets...")
    all_scenario_objs = create_all_scenarios(okareo)

    print(f"\nRunning {len(scenario_names)} scenario(s) with label: {run_label}")
    print(f"Checks: {len(checks)} total\n")

    test_runs = []
    for scenario_name in scenario_names:
        driver_name = args.driver or DRIVER_SCENARIO_MAP.get(scenario_name, "power_user")
        result = run_single_simulation(
            okareo=okareo,
            scenario_name=scenario_name,
            scenario_obj=all_scenario_objs[scenario_name],
            driver_name=driver_name,
            model=args.model,
            max_turns=args.max_turns,
            checks=checks,
            run_label=run_label,
        )
        test_runs.append(result)

    # Display results
    display_results(test_runs)

    # Save run metadata for compare.py
    test_run_ids = [str(r.id) for r in test_runs]
    meta = {
        "label": run_label,
        "model": args.model,
        "timestamp": datetime.now().isoformat(),
        "test_run_ids": test_run_ids,
        "scenarios": scenarios,
        "metrics": serialize_metrics(test_runs),
    }
    os.makedirs("runs", exist_ok=True)
    meta_path = f"runs/{run_label}.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2, default=str)
    print(f"\nRun metadata saved to {meta_path}")


if __name__ == "__main__":
    main()
