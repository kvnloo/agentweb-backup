#!/usr/bin/env python3
"""ENG-859: unit tests for the partial-extraction salvage helper.

These are intentionally dependency-free (no browser_use / playwright) so they run
under plain Python — the browser run's history is duck-typed via a MagicMock that
only exposes `extracted_content()`.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from partial_extraction import collect_partial_extraction, build_incomplete_run_message


def _result(content):
    r = MagicMock()
    r.extracted_content.return_value = content
    return r


class TestCollectPartialExtraction(unittest.TestCase):
    def test_list_of_strings_is_joined(self):
        r = _result(["Impressions: 1,200", "Engagements: 88"])
        self.assertEqual(collect_partial_extraction(r), "Impressions: 1,200\n\nEngagements: 88")

    def test_empty_list_returns_none(self):
        self.assertIsNone(collect_partial_extraction(_result([])))

    def test_none_content_returns_none(self):
        self.assertIsNone(collect_partial_extraction(_result(None)))

    def test_whitespace_and_none_entries_are_filtered(self):
        r = _result(["  ", None, "real data", ""])
        self.assertEqual(collect_partial_extraction(r), "real data")

    def test_single_string_content(self):
        self.assertEqual(collect_partial_extraction(_result("just one blob")), "just one blob")

    def test_extracted_content_raising_degrades_to_none(self):
        r = MagicMock()
        r.extracted_content.side_effect = RuntimeError("history gone")
        self.assertIsNone(collect_partial_extraction(r))

    def test_oversized_content_is_truncated(self):
        out = collect_partial_extraction(_result(["x" * 30000]))
        self.assertIsNotNone(out)
        self.assertLessEqual(len(out), 20100)
        self.assertIn("truncated", out)


class TestBuildIncompleteRunMessage(unittest.TestCase):
    def test_empty_partial_returns_none(self):
        self.assertIsNone(build_incomplete_run_message(None))
        self.assertIsNone(build_incomplete_run_message(""))

    def test_wraps_partial_data_with_continue_guidance(self):
        msg = build_incomplete_run_message("DATA-123")
        self.assertIn("DATA-123", msg)
        self.assertIn("Partial results", msg)
        self.assertIn("continue", msg)
        # It must NOT tell the user to start over from scratch.
        self.assertNotIn("start over", msg.lower().replace("starting over", ""))


if __name__ == "__main__":
    unittest.main()
