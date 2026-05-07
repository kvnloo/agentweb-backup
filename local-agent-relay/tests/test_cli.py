import io
import unittest
from unittest.mock import patch

from codex_relay.cli import _read_task


class CliTests(unittest.TestCase):
    def test_read_task_from_argument(self):
        self.assertEqual(_read_task("do work"), "do work")

    def test_read_task_from_stdin(self):
        with patch("sys.stdin", io.StringIO("do stdin work\n")):
            self.assertEqual(_read_task("-"), "do stdin work")

    def test_read_task_rejects_empty(self):
        with self.assertRaises(SystemExit):
            _read_task("  ")


if __name__ == "__main__":
    unittest.main()

