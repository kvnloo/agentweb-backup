import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_relay.config import CodexConfig
from codex_relay.runner import MACOS_CODEX_APP_BINARY, CodexRunner, _augment_task_with_browser_context, _exec_env, _resolve_binary
from codex_relay.sessions import SessionStore


class RunnerTests(unittest.TestCase):
    def test_dry_run_does_not_execute(self):
        runner = CodexRunner(CodexConfig(binary="/bin/echo", cwd="."))
        result = runner.run("do work", dry_run=True)

        self.assertTrue(result.ok)
        self.assertIn("Dry run", result.final_message)
        self.assertIn("do work", result.final_message)

    def test_resolve_binary_uses_macos_app_fallback(self):
        def fake_which(binary):
            if binary == MACOS_CODEX_APP_BINARY:
                return MACOS_CODEX_APP_BINARY
            return None

        with patch("codex_relay.runner.shutil.which", fake_which):
            self.assertEqual(_resolve_binary("codex"), MACOS_CODEX_APP_BINARY)

    def test_build_command_resumes_codex_session_id(self):
        runner = CodexRunner(
            CodexConfig(
                binary="/bin/echo",
                cwd="/repo",
                session_ref="12345678-1234-1234-1234-123456789abc",
            )
        )

        command = runner._build_command()

        self.assertIn("resume", command)
        self.assertIn("12345678-1234-1234-1234-123456789abc", command)
        self.assertNotIn("--sandbox", command)

    def test_build_command_resumes_codex_thread_title(self):
        runner = CodexRunner(
            CodexConfig(
                binary="/bin/echo",
                cwd="/repo",
                session_ref="LinkedIn research",
            )
        )

        command = runner._build_command()

        self.assertIn("resume", command)
        self.assertIn("LinkedIn research", command)
        self.assertNotIn("--sandbox", command)

    def test_build_command_new_session_ignores_session_ref(self):
        runner = CodexRunner(
            CodexConfig(
                binary="/bin/echo",
                cwd="/repo",
                session_ref="12345678-1234-1234-1234-123456789abc",
                new_session=True,
            )
        )

        command = runner._build_command()

        self.assertNotIn("resume", command)
        self.assertIn("--sandbox", command)

    def test_build_command_resumes_alias_to_codex_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            store_path = Path(tmp) / "sessions.json"
            SessionStore(store_path).set_alias("main", "12345678-1234-1234-1234-123456789abc", "/repo")
            runner = CodexRunner(
                CodexConfig(
                    binary="/bin/echo",
                    cwd="/repo",
                    session_alias="main",
                    session_store_path=str(store_path),
                )
            )

            command = runner._build_command()

            self.assertIn("resume", command)
            self.assertIn("12345678-1234-1234-1234-123456789abc", command)

    def test_browser_tool_path_is_injected_into_prompt(self):
        task = _augment_task_with_browser_context(
            "read the current browser",
            CodexConfig(
                cwd="/repo",
                browser_tool_path="/repo/.venv/bin/codex-relay-browser",
            ),
        )

        self.assertIn("<browser_tools>", task)
        self.assertIn("/repo/.venv/bin/codex-relay-browser", task)
        self.assertIn("Do not use Computer Use", task)

    def test_browser_tool_dir_is_added_to_exec_path(self):
        env = _exec_env(CodexConfig(cwd="/repo", browser_tool_path="/repo/.venv/bin/codex-relay-browser"))

        self.assertTrue(env["PATH"].startswith("/repo/.venv/bin"))


if __name__ == "__main__":
    unittest.main()
