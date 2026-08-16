#!/usr/bin/env python3
"""Unit tests for usage_reporter (Ship 1 shadow metering).

These tests are dependency-light: they do not require langchain or a network.
HTTP and JWT creation are stubbed so metering can be verified offline.
"""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

# Add parent directory to path to import usage_reporter
sys.path.append(str(Path(__file__).parent.parent))

from usage_reporter import (
    UsageReporter,
    UsageCallbackHandler,
    attach_usage_callback,
    extract_usage_from_llm_result,
    parse_full_llm_name,
)


def _fake_llm_result(usage_metadata=None, llm_output=None):
    """Build a minimal LLMResult-shaped object."""
    message = SimpleNamespace(usage_metadata=usage_metadata)
    generation = SimpleNamespace(message=message)
    return SimpleNamespace(generations=[[generation]], llm_output=llm_output)


class TestParseFullLlmName(unittest.TestCase):
    def test_valid_triplet(self):
        self.assertEqual(
            parse_full_llm_name("azure->openai->gpt-4o"), ("openai", "gpt-4o")
        )
        self.assertEqual(
            parse_full_llm_name("aws->Anthropic->anthropic.claude-sonnet-4-6"),
            ("anthropic", "anthropic.claude-sonnet-4-6"),
        )

    def test_malformed_names_fall_back(self):
        self.assertEqual(parse_full_llm_name("gpt-4o"), ("unknown", "gpt-4o"))
        self.assertEqual(parse_full_llm_name(""), ("unknown", "unknown"))
        self.assertEqual(parse_full_llm_name(None), ("unknown", "unknown"))


class TestExtractUsage(unittest.TestCase):
    def test_usage_metadata_path(self):
        result = _fake_llm_result(
            usage_metadata={
                "input_tokens": 120,
                "output_tokens": 30,
                "input_token_details": {"cache_read": 100, "cache_creation": 5},
            }
        )
        usage = extract_usage_from_llm_result(result)
        self.assertEqual(usage["input_tokens"], 120)
        self.assertEqual(usage["output_tokens"], 30)
        self.assertEqual(usage["cache_read_tokens"], 100)
        self.assertEqual(usage["cache_write_tokens"], 5)

    def test_openai_token_usage_fallback(self):
        result = _fake_llm_result(
            llm_output={"token_usage": {"prompt_tokens": 50, "completion_tokens": 7}}
        )
        usage = extract_usage_from_llm_result(result)
        self.assertEqual(usage["input_tokens"], 50)
        self.assertEqual(usage["output_tokens"], 7)

    def test_anthropic_usage_fallback(self):
        result = _fake_llm_result(
            llm_output={
                "usage": {
                    "input_tokens": 200,
                    "output_tokens": 40,
                    "cache_read_input_tokens": 150,
                }
            }
        )
        usage = extract_usage_from_llm_result(result)
        self.assertEqual(usage["input_tokens"], 200)
        self.assertEqual(usage["output_tokens"], 40)
        self.assertEqual(usage["cache_read_tokens"], 150)

    def test_no_usage_returns_none(self):
        self.assertIsNone(extract_usage_from_llm_result(_fake_llm_result()))
        self.assertIsNone(extract_usage_from_llm_result(None))
        self.assertIsNone(extract_usage_from_llm_result(object()))


class TestUsageReporterBuffering(unittest.TestCase):
    def setUp(self):
        self.reporter = UsageReporter(
            "aws->anthropic->anthropic.claude-sonnet-4-6",
            token_factory=lambda uid: "test-token",
        )

    def test_aggregates_multiple_calls(self):
        self.reporter.add({"input_tokens": 100, "output_tokens": 20})
        self.reporter.add({"input_tokens": 50, "output_tokens": 10, "cache_read_tokens": 30})
        records = self.reporter.build_records("user-1", "task-9")
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["userId"], "user-1")
        self.assertEqual(record["taskId"], "task-9")
        self.assertEqual(record["model"], "anthropic.claude-sonnet-4-6")
        self.assertEqual(record["provider"], "anthropic")
        self.assertEqual(record["feature"], "agent_task")
        self.assertEqual(record["inputTokens"], 150)
        self.assertEqual(record["outputTokens"], 30)
        self.assertEqual(record["cacheReadTokens"], 30)

    def test_zero_usage_produces_no_records(self):
        self.assertEqual(self.reporter.build_records("user-1"), [])
        self.reporter.add({"input_tokens": 0, "output_tokens": 0})
        self.assertEqual(self.reporter.build_records("user-1"), [])

    def test_add_never_raises_on_garbage(self):
        self.reporter.add(None)
        self.reporter.add({"input_tokens": "not-a-number"})
        self.reporter.add({"input_tokens": -50, "output_tokens": 10})
        records = self.reporter.build_records("user-1")
        # Negative input coerced to 0, output of 10 still counted
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["inputTokens"], 0)
        self.assertEqual(records[0]["outputTokens"], 10)


class TestUsageReporterFlush(unittest.TestCase):
    def setUp(self):
        self.reporter = UsageReporter(
            "azure->openai->gpt-4o", token_factory=lambda uid: "test-token"
        )
        self.reporter.add({"input_tokens": 10, "output_tokens": 5})

    def test_flush_posts_batch_with_bearer_token(self):
        mock_response = MagicMock(status_code=202)
        with patch("requests.post", return_value=mock_response) as mock_post:
            ok = self.reporter.flush("user-1", "task-9")
        self.assertTrue(ok)
        args, kwargs = mock_post.call_args
        self.assertTrue(args[0].endswith("/api/internal/usage"))
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-token")
        records = kwargs["json"]["records"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["model"], "gpt-4o")
        self.assertEqual(records[0]["inputTokens"], 10)
        # Buffer cleared after a successful flush
        self.assertEqual(self.reporter.build_records("user-1"), [])

    def test_flush_swallows_network_errors(self):
        with patch("requests.post", side_effect=ConnectionError("backend down")):
            ok = self.reporter.flush("user-1", "task-9")
        self.assertFalse(ok)  # never raises

    def test_flush_handles_backend_rejection(self):
        mock_response = MagicMock(status_code=401, text="Invalid token")
        with patch("requests.post", return_value=mock_response):
            ok = self.reporter.flush("user-1", "task-9")
        self.assertFalse(ok)

    def test_flush_without_token_drops_batch_quietly(self):
        reporter = UsageReporter("azure->openai->gpt-4o", token_factory=lambda uid: None)
        reporter.add({"input_tokens": 10, "output_tokens": 5})
        with patch("requests.post") as mock_post:
            ok = reporter.flush("user-1")
        self.assertFalse(ok)
        mock_post.assert_not_called()

    def test_flush_with_empty_buffer_is_a_noop(self):
        reporter = UsageReporter("azure->openai->gpt-4o", token_factory=lambda uid: "t")
        with patch("requests.post") as mock_post:
            ok = reporter.flush("user-1")
        self.assertFalse(ok)
        mock_post.assert_not_called()

    def test_flush_includes_a_stable_report_id(self):
        # ENG-1251: a genuine per-instance nonce, distinct from content-based
        # heuristics, is what lets the backend tell a retried HTTP submission
        # (same instance, same id) apart from a genuinely new execution (a
        # new instance -- new WebAgent, new UsageReporter -- always gets a
        # new one).
        mock_response = MagicMock(status_code=202)
        with patch("requests.post", return_value=mock_response) as mock_post:
            self.reporter.flush("user-1", "task-9")
        report_id = mock_post.call_args.kwargs["json"]["reportId"]
        self.assertTrue(report_id)
        self.assertEqual(report_id, self.reporter.report_id)

    def test_report_id_is_stable_across_a_retried_flush_of_the_same_instance(self):
        # flush() only clears the buffer on success, so a caller retrying
        # flush() after a failed attempt reuses the same instance and must
        # send the identical report_id both times.
        with patch("requests.post", side_effect=ConnectionError("backend down")):
            self.reporter.flush("user-1", "task-9")
        first_id = self.reporter.report_id

        mock_response = MagicMock(status_code=202)
        with patch("requests.post", return_value=mock_response) as mock_post:
            self.reporter.flush("user-1", "task-9")
        second_id = mock_post.call_args.kwargs["json"]["reportId"]

        self.assertEqual(first_id, second_id)

    def test_two_reporter_instances_get_different_report_ids(self):
        # A distinct execution (a new WebAgent/UsageReporter) must never
        # collide with a prior one's id, even for identical measurements.
        other = UsageReporter("azure->openai->gpt-4o", token_factory=lambda uid: "test-token")
        self.assertNotEqual(self.reporter.report_id, other.report_id)


class TestCallbackHandler(unittest.TestCase):
    def test_on_llm_end_feeds_reporter(self):
        reporter = UsageReporter("google->google->gemini-3.5-flash", token_factory=lambda uid: "t")
        handler = UsageCallbackHandler(reporter)
        handler.on_llm_end(
            _fake_llm_result(usage_metadata={"input_tokens": 42, "output_tokens": 8})
        )
        records = reporter.build_records("user-1")
        self.assertEqual(records[0]["inputTokens"], 42)
        self.assertEqual(records[0]["outputTokens"], 8)

    def test_on_llm_end_never_raises(self):
        reporter = UsageReporter("google->google->gemini-3.5-flash", token_factory=lambda uid: "t")
        handler = UsageCallbackHandler(reporter)
        handler.on_llm_end(None)  # garbage input — must not raise

    def test_attach_to_plain_object(self):
        reporter = UsageReporter("azure->openai->gpt-4o", token_factory=lambda uid: "t")
        llm = SimpleNamespace(callbacks=None)
        self.assertTrue(attach_usage_callback(llm, reporter))
        self.assertEqual(len(llm.callbacks), 1)
        self.assertIsInstance(llm.callbacks[0], UsageCallbackHandler)

    def test_attach_appends_to_existing_list(self):
        reporter = UsageReporter("azure->openai->gpt-4o", token_factory=lambda uid: "t")
        sentinel = object()
        llm = SimpleNamespace(callbacks=[sentinel])
        self.assertTrue(attach_usage_callback(llm, reporter))
        self.assertEqual(llm.callbacks[0], sentinel)
        self.assertEqual(len(llm.callbacks), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
