#!/usr/bin/env python3
"""ENG-1828: unit tests for describe_populated_actions.

Intentionally dependency-free (no browser_use / playwright) so it runs under
plain Python -- the ActionModel is duck-typed via a MagicMock that only
exposes model_dump(exclude_unset=True), matching the exact call
Controller.act() makes.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from strict_action_controller import describe_populated_actions


def _action(**fields):
    m = MagicMock()
    m.model_dump.return_value = fields
    return m


class TestDescribePopulatedActions(unittest.TestCase):
    def test_single_populated_field_counts_as_one(self):
        count, names = describe_populated_actions(_action(done=None, go_to_url={"url": "https://example.com"}))
        self.assertEqual(count, 1)
        self.assertEqual(names, ["go_to_url"])

    def test_kitchen_sink_multi_field_response_counts_correctly(self):
        # The exact shape observed 5x in production: done first (always
        # registered first in Controller.__init__), several others also
        # populated.
        count, names = describe_populated_actions(_action(
            done={"text": "fabricated", "success": True},
            search_google={"query": "x"},
            go_to_url={"url": "https://example.com"},
            write_file=None,
        ))
        self.assertEqual(count, 3)
        self.assertEqual(names, ["done", "search_google", "go_to_url"])

    def test_zero_populated_fields_counts_as_zero(self):
        # Deliberately not rejected by StrictActionController -- see its
        # docstring -- but the counting function itself must still report
        # this accurately.
        count, names = describe_populated_actions(_action(done=None, go_to_url=None))
        self.assertEqual(count, 0)
        self.assertEqual(names, [])

    def test_calls_model_dump_with_exclude_unset(self):
        action = _action(done=None)
        describe_populated_actions(action)
        action.model_dump.assert_called_once_with(exclude_unset=True)


if __name__ == "__main__":
    unittest.main()
