#!/usr/bin/env python3
"""ENG-1823: unit tests for parse_web_agent_cli_result.

Intentionally dependency-free (no browser_use / playwright / asyncio) so it
runs under plain Python.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from web_agent_cli_result import parse_web_agent_cli_result


class TestParseWebAgentCliResult(unittest.TestCase):
    def test_success_at_returncode_zero_parses_stdout(self):
        result_dict = {"success": True, "summary": "did the thing", "llmName": "x"}
        stdout = json.dumps(result_dict).encode()
        parsed = parse_web_agent_cli_result(stdout, b"", 0, "log.txt", "x")
        self.assertEqual(parsed, result_dict)

    def test_reported_failure_at_returncode_one_still_parses_stdout(self):
        # The exact ENG-1823 regression: web_agent.py's own sys.exit(0 if
        # result["success"] else 1) means a correctly-reported failure now
        # exits 1, but still prints a complete result dict first -- that
        # dict, and its real error message, must not be discarded in favor
        # of a generic stderr-based error.
        result_dict = {
            "success": False,
            "error": "No real action was performed yet...",
            "llmName": "x",
        }
        stdout = json.dumps(result_dict).encode()
        parsed = parse_web_agent_cli_result(stdout, b"some noisy stderr log lines", 1, "log.txt", "x")
        self.assertEqual(parsed, result_dict)

    def test_genuine_crash_falls_back_to_stderr_message(self):
        parsed = parse_web_agent_cli_result(b"", b"Traceback: boom", 1, "log.txt", "x")
        self.assertFalse(parsed["success"])
        self.assertIn("Process error:", parsed["error"])
        self.assertIn("Traceback: boom", parsed["error"])
        self.assertEqual(parsed["llmName"], "x")

    def test_genuine_crash_with_no_stderr_reports_unknown_error(self):
        parsed = parse_web_agent_cli_result(b"", b"", 1, "log.txt", "x")
        self.assertFalse(parsed["success"])
        self.assertIn("Unknown error", parsed["error"])

    def test_zero_exit_with_no_valid_json_reports_missing_output(self):
        parsed = parse_web_agent_cli_result(b"not json at all", b"", 0, "log.txt", "x")
        self.assertFalse(parsed["success"])
        self.assertIn("No valid JSON output found", parsed["error"])

    def test_picks_last_valid_json_line_with_success_key(self):
        stdout = b'{"some": "log line"}\n{"success": true, "summary": "final"}\n'
        parsed = parse_web_agent_cli_result(stdout, b"", 0, "log.txt", "x")
        self.assertEqual(parsed, {"success": True, "summary": "final"})

    def test_undecodable_stdout_degrades_to_parse_error(self):
        parsed = parse_web_agent_cli_result(b"\xff\xfe not valid utf-8", b"", 1, "log.txt", "x")
        self.assertFalse(parsed["success"])
        self.assertIn("Failed to parse output", parsed["error"])


if __name__ == "__main__":
    unittest.main()
