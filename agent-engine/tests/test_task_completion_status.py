#!/usr/bin/env python3
"""ENG-1823: unit tests for the is_done()/is_successful() split.

Intentionally dependency-free (no browser_use / playwright) so it runs under
plain Python — the browser run's history is duck-typed via a MagicMock that
only exposes ``is_done()``/``is_successful()``, matching browser_use's real
``AgentHistoryList``.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from task_completion_status import determine_task_completion_status


def _result(is_done, is_successful):
    r = MagicMock()
    r.is_done.return_value = is_done
    r.is_successful.return_value = is_successful
    return r


class TestDetermineTaskCompletionStatus(unittest.TestCase):
    def test_done_and_successful_reports_both_true(self):
        task_is_done, task_succeeded = determine_task_completion_status(_result(True, True))
        self.assertTrue(task_is_done)
        self.assertTrue(task_succeeded)

    def test_done_but_reported_failed_is_the_eng1823_bug(self):
        # The agent's own `done` action said success=False -- this must NOT
        # be reported as a success, which is exactly what the pre-fix
        # is_done()-only check got wrong.
        task_is_done, task_succeeded = determine_task_completion_status(_result(True, False))
        self.assertTrue(task_is_done)
        self.assertFalse(task_succeeded)

    def test_not_done_is_never_reported_as_succeeded(self):
        # Hit the step/time limit without ever calling `done` -- is_successful()
        # would return None here per browser-use's real semantics; must not be
        # mistaken for success either way.
        task_is_done, task_succeeded = determine_task_completion_status(_result(False, None))
        self.assertFalse(task_is_done)
        self.assertFalse(task_succeeded)

    def test_task_succeeded_is_never_true_without_task_is_done(self):
        # Defensive: even a duck-typed result that (incorrectly) returns a
        # truthy is_successful() while is_done() is False must not leak
        # through as a success -- task_is_done gates task_succeeded.
        task_is_done, task_succeeded = determine_task_completion_status(_result(False, True))
        self.assertFalse(task_is_done)
        self.assertFalse(task_succeeded)

    def test_done_with_unset_success_is_not_reported_as_succeeded(self):
        # Structurally unreachable today via the standard `done` action --
        # confirmed against the real installed browser_use source that
        # DoneAction.success is a required bool field with no default, so
        # is_done()==True always pairs with a real True/False, never None.
        # Still worth guarding defensively: determine_task_completion_status
        # is a general, reusable function, and a hypothetical future
        # Controller built with an output_model whose own `success` field
        # carries a default (unlike DoneAction's) would make this reachable
        # -- `is True` must fail closed on None just as it does on False.
        task_is_done, task_succeeded = determine_task_completion_status(_result(True, None))
        self.assertTrue(task_is_done)
        self.assertFalse(task_succeeded)


if __name__ == "__main__":
    unittest.main()
