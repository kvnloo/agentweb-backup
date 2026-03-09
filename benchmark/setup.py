#!/usr/bin/env python3
"""One-time setup: create all Okareo resources (scenarios, drivers, checks, targets).

Usage:
    python setup.py                          # Create all resources with default model
    python setup.py --model claude-sonnet-4-5  # Create target for a specific model
"""

import argparse
import sys
from dotenv import load_dotenv

load_dotenv()

from lib.okareo_setup import (
    get_okareo_client,
    create_all_scenarios,
    create_all_drivers,
    create_all_checks,
    create_target,
    DEFAULT_MODEL,
)


def main():
    parser = argparse.ArgumentParser(description="Set up Okareo benchmark resources")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"LLM model ID for the target (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--skip-scenarios",
        action="store_true",
        help="Skip scenario creation (if already created)",
    )
    parser.add_argument(
        "--skip-drivers",
        action="store_true",
        help="Skip driver creation (if already created)",
    )
    parser.add_argument(
        "--skip-checks",
        action="store_true",
        help="Skip check creation (if already created)",
    )
    parser.add_argument(
        "--skip-target",
        action="store_true",
        help="Skip target creation",
    )
    args = parser.parse_args()

    okareo = get_okareo_client()
    print("Connected to Okareo.\n")

    if not args.skip_scenarios:
        print("Creating scenarios...")
        create_all_scenarios(okareo)
        print()

    if not args.skip_drivers:
        print("Creating drivers...")
        create_all_drivers(okareo)
        print()

    if not args.skip_checks:
        print("Creating custom checks...")
        create_all_checks(okareo)
        print()

    if not args.skip_target:
        print("Creating target...")
        create_target(okareo, model=args.model, name_suffix=args.model)
        print()

    print("Setup complete.")


if __name__ == "__main__":
    main()
