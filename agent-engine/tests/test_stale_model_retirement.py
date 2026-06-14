#!/usr/bin/env python3
"""Guard tests for retiring stale LLM models from live agent-engine paths.

Two internal utility paths used to pin year-old models:
  - check_new_information() (recurring/scheduled task diffing) -> o1-mini
  - the knowledge-base-update step in task_monitor -> gpt-4.1

Both are moved up to the current Azure GPT-5 deployment wired in this repo:
`gpt-5-chat` via get_azure_openai_llm3 (the same deployment already serving the
production model dropdown's gpt-5-chat entry). These tests assert the live paths
use the current constructor and that the stale call sites do not regress back in.
"""
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import task_utils

AGENT_ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CURRENT_AZURE_GPT5 = "gpt-5-chat"


class TestCheckNewInformationModel(unittest.TestCase):
    """check_new_information() must use the current model, not o1-mini."""

    def _run_with_content(self, content):
        with patch("task_utils.get_azure_openai_llm3") as m3, \
             patch("task_utils.get_azure_openai_llm_o1") as mo1:
            m3.return_value.invoke.return_value.content = content
            result = task_utils.check_new_information("previous output", "current output")
            return result, m3, mo1

    def test_uses_current_gpt5_constructor(self):
        """It builds the LLM via get_azure_openai_llm3('gpt-5-chat')."""
        _, m3, _ = self._run_with_content("YES\nNew pricing detected")
        m3.assert_called_once_with(CURRENT_AZURE_GPT5)

    def test_does_not_use_o1_mini_constructor(self):
        """The stale o1-mini constructor is never called."""
        _, _, mo1 = self._run_with_content("YES\nNew pricing detected")
        self.assertFalse(mo1.called, "check_new_information must not call get_azure_openai_llm_o1")

    def test_parses_new_info_response(self):
        """Happy path: a YES response is parsed into (True, summary)."""
        (has_new, summary), _, _ = self._run_with_content("YES\nNew pricing detected")
        self.assertTrue(has_new)
        self.assertEqual(summary, "New pricing detected")

    def test_parses_no_new_info_response(self):
        """A NO_NEW_INFO response yields (False, None)."""
        (has_new, summary), _, _ = self._run_with_content("NO\nNO_NEW_INFO")
        self.assertFalse(has_new)
        self.assertIsNone(summary)


class TestNoStaleModelCallSites(unittest.TestCase):
    """Source guards: the retired stale call sites must not come back."""

    def _read(self, rel_path):
        with open(os.path.join(AGENT_ENGINE_DIR, rel_path), "r") as f:
            return f.read()

    def test_task_utils_has_no_o1_mini_call(self):
        src = self._read("task_utils.py")
        self.assertNotIn(
            "get_azure_openai_llm_o1('o1-mini')", src,
            "check_new_information regressed to the stale o1-mini model",
        )

    def test_task_monitor_kb_update_has_no_gpt41_call(self):
        src = self._read("task_monitor.py")
        self.assertNotIn(
            "get_azure_openai_llm2('gpt-4.1')", src,
            "knowledge-base update regressed to the stale gpt-4.1 model",
        )


if __name__ == "__main__":
    unittest.main()
