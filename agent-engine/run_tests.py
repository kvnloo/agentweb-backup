#!/usr/bin/env python3
"""
Test runner for the agent-engine test suite.
This script provides an easy way to run different categories of tests.
"""

import sys
import os
import subprocess
import argparse
from pathlib import Path

def run_command(cmd, description):
    """Run a command and return the result."""
    print(f"\n{'='*60}")
    print(f"Running: {description}")
    print(f"Command: {' '.join(cmd)}")
    print(f"{'='*60}")
    
    try:
        result = subprocess.run(cmd, check=True, capture_output=False)
        print(f"✅ {description} - PASSED")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ {description} - FAILED (exit code: {e.returncode})")
        return False

def run_all_tests():
    """Run all tests in the tests directory."""
    print("Running all tests...")
    
    # Run tests that don't require external dependencies first
    standalone_tests = [
        "tests/test_validate_content_format_standalone.py",
        "tests/test_browser_use_integration.py::TestBrowserUseIntegration::test_action_result_creation",
        "tests/test_browser_use_integration.py::TestBrowserUseIntegration::test_action_result_with_metadata",
        "tests/test_memory_fix_comprehensive.py",
        "tests/test_azure_openai_with_memory_fix.py",
    ]
    
    success_count = 0
    total_count = len(standalone_tests)
    
    for test in standalone_tests:
        if run_command([sys.executable, "-m", "unittest", test, "-v"], f"Test: {test}"):
            success_count += 1
    
    print(f"\n{'='*60}")
    print(f"Test Summary: {success_count}/{total_count} tests passed")
    print(f"{'='*60}")
    
    return success_count == total_count

def run_browser_use_tests():
    """Run browser-use specific tests."""
    print("Running browser-use integration tests...")
    
    tests = [
        "tests/test_browser_use_integration.py::TestBrowserUseIntegration::test_action_result_creation",
        "tests/test_browser_use_integration.py::TestBrowserUseIntegration::test_action_result_with_metadata",
        "tests/test_browser_use_integration.py::TestBrowserUseErrorHandling::test_action_result_error_handling",
        "tests/test_browser_use_integration.py::TestBrowserUseErrorHandling::test_action_result_validation",
    ]
    
    success_count = 0
    total_count = len(tests)
    
    for test in tests:
        if run_command([sys.executable, "-m", "unittest", test, "-v"], f"Test: {test}"):
            success_count += 1
    
    print(f"\n{'='*60}")
    print(f"Browser-Use Test Summary: {success_count}/{total_count} tests passed")
    print(f"{'='*60}")
    
    return success_count == total_count

def run_core_tests():
    """Run core functionality tests."""
    print("Running core functionality tests...")
    
    tests = [
        "tests/test_validate_content_format_standalone.py",
        "tests/test_task_monitor.py",
        "tests/test_task_utils.py",
    ]
    
    success_count = 0
    total_count = len(tests)
    
    for test in tests:
        if run_command([sys.executable, "-m", "unittest", test, "-v"], f"Test: {test}"):
            success_count += 1
    
    print(f"\n{'='*60}")
    print(f"Core Test Summary: {success_count}/{total_count} tests passed")
    print(f"{'='*60}")
    
    return success_count == total_count

def run_verification():
    """Run the browser-use upgrade verification."""
    print("Running browser-use upgrade verification...")
    
    return run_command([sys.executable, "tests/verify_browser_use_upgrade.py"], "Browser-Use Upgrade Verification")

def main():
    """Main test runner function."""
    parser = argparse.ArgumentParser(description="Agent Engine Test Runner")
    parser.add_argument("--category", choices=["all", "browser-use", "core", "verification"], 
                       default="all", help="Test category to run")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    
    args = parser.parse_args()
    
    # Change to the agent-engine directory
    script_dir = Path(__file__).parent
    os.chdir(script_dir)
    
    print("Agent Engine Test Runner")
    print("=" * 60)
    print(f"Working directory: {os.getcwd()}")
    print(f"Python executable: {sys.executable}")
    print(f"Test category: {args.category}")
    print("=" * 60)
    
    success = False
    
    if args.category == "all":
        success = run_all_tests()
    elif args.category == "browser-use":
        success = run_browser_use_tests()
    elif args.category == "core":
        success = run_core_tests()
    elif args.category == "verification":
        success = run_verification()
    
    if success:
        print("\n🎉 All tests completed successfully!")
        sys.exit(0)
    else:
        print("\n❌ Some tests failed. Please check the output above.")
        sys.exit(1)

if __name__ == "__main__":
    main()