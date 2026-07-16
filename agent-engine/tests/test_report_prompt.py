#!/usr/bin/env python3
"""Unit tests for the deep-research report prompt builder (ENG-351).

Dependency-light: imports only report_prompt (no autogen/langchain/network), so
the inline-source-citation guidance baked into the isDeepResearch task's HTML
report prompt can be verified offline.
"""

import sys
import unittest
from pathlib import Path

# Add parent directory to path to import report_prompt
sys.path.append(str(Path(__file__).parent.parent))

from report_prompt import build_report_format_prompt, INLINE_CITATION_INSTRUCTION


class TestReportPromptInlineCitations(unittest.TestCase):
    def setUp(self):
        self.prompt = build_report_format_prompt(
            "global CRM software market size",
            "2024 market: $101B (Grand View Research)",
        )

    def test_inline_citation_instruction_is_present(self):
        # The ENG-351 instruction must be embedded in the report prompt.
        self.assertIn(INLINE_CITATION_INSTRUCTION, self.prompt)
        self.assertIn("10. Cite the source of every quoted number", self.prompt)

    def test_requires_source_inline_next_to_the_figure(self):
        self.assertIn("INLINE", INLINE_CITATION_INSTRUCTION)
        self.assertIn("immediately next to the figure it supports", INLINE_CITATION_INSTRUCTION)

    def test_forbids_bottom_only_references_section(self):
        self.assertIn(
            "rather than collecting sources only in a separate references section",
            INLINE_CITATION_INSTRUCTION,
        )

    def test_references_claude_gemini_benchmark_style(self):
        self.assertIn("Claude/Gemini inline-citation style", INLINE_CITATION_INSTRUCTION)

    def test_forbids_fabricating_a_source(self):
        self.assertIn("do not fabricate one", INLINE_CITATION_INSTRUCTION)

    def test_prompt_still_carries_query_and_log(self):
        # Guard against a regression that drops the interpolated inputs.
        self.assertIn("global CRM software market size", self.prompt)
        self.assertIn("2024 market: $101B (Grand View Research)", self.prompt)
        self.assertIn("professional research report generator", self.prompt)


if __name__ == "__main__":
    unittest.main()
