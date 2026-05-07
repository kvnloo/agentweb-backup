import unittest

from codex_relay.commands import extract_task, is_allowed_sender


class CommandTests(unittest.TestCase):
    def test_extracts_from_subject(self):
        self.assertEqual(extract_task("codex: fix tests", "", "codex:"), "fix tests")

    def test_extracts_from_body(self):
        self.assertEqual(extract_task("hello", "codex: review diff", "codex:"), "review diff")

    def test_rejects_missing_prefix(self):
        self.assertIsNone(extract_task("hello", "review diff", "codex:"))

    def test_sender_allowlist_is_case_insensitive(self):
        self.assertTrue(is_allowed_sender("ME@EXAMPLE.COM", ("me@example.com",)))


if __name__ == "__main__":
    unittest.main()

