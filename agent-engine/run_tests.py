#!/usr/bin/env python3
import unittest
import sys
from pathlib import Path

def run_tests():
    """Run all tests in the tests directory"""
    # Get the tests directory
    tests_dir = Path(__file__).parent / 'tests'
    
    # Discover and run tests
    loader = unittest.TestLoader()
    suite = loader.discover(str(tests_dir))
    
    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    # Return exit code based on test results
    return 0 if result.wasSuccessful() else 1

if __name__ == '__main__':
    sys.exit(run_tests()) 