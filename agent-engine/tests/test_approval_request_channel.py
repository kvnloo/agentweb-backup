"""ENG-273: an approval request must not require a Slack channel.

Slack and WhatsApp are separate features and a customer connects one of them. A task
with a Slack channel keeps using the Slack endpoint; a task without one is sent to the
channel-neutral endpoint instead of being skipped.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# slack_utils pulls in dotenv and task_utils (which in turn needs boto3, aiohttp and
# browser_use). None of that is exercised here, so where the engine's dependencies are
# not installed the two imports are stubbed; where they are, the real modules are used.
for _name, _attrs in (("dotenv", {"load_dotenv": lambda *a, **k: None}),
                      ("task_utils", {"create_jwt_token": lambda *_a, **_k: "jwt"})):
    try:
        __import__(_name)
    except Exception:  # ImportError, or a transitive dependency failing to load
        _stub = MagicMock()
        for _k, _v in _attrs.items():
            setattr(_stub, _k, _v)
        sys.modules[_name] = _stub

import slack_utils  # noqa: E402


def _call(slack_channel):
    return slack_utils.send_task_approval_request(
        task_id="task-1",
        task_name="Weekly report",
        execution_id="exec-1",
        asset_url="https://assets.example.com/r.html",
        filename="r.html",
        asset_type="html",
        slack_channel=slack_channel,
        user_id="user-1",
    )


def _response(status, body=None):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = body or {}
    r.text = str(body)
    return r


@patch.object(slack_utils, "create_jwt_token", return_value="jwt")
class ApprovalRequestChannelTest(unittest.TestCase):
    def test_slack_task_uses_the_slack_endpoint_unchanged(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(200, {"success": True})) as post:
            self.assertTrue(_call("C0APPROVALS"))
        url = post.call_args[0][0]
        body = post.call_args[1]["json"]
        self.assertTrue(url.endswith("/api/slack/send-approval"))
        self.assertEqual(body["channel"], "C0APPROVALS")

    def test_task_without_slack_uses_the_neutral_endpoint(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(200, {"success": True})) as post:
            self.assertTrue(_call(None))
        url = post.call_args[0][0]
        body = post.call_args[1]["json"]
        self.assertTrue(url.endswith("/api/approval-requests"))
        self.assertNotIn("channel", body)
        self.assertEqual(body["assetUrl"], "https://assets.example.com/r.html")

    def test_no_connected_channel_is_a_clean_false_not_an_error(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(409, {"code": "no_channel"})):
            with self.assertLogs(slack_utils.logger, level="INFO") as logs:
                self.assertFalse(_call(None))
        self.assertFalse(any(r.levelname == "ERROR" for r in logs.records))

    def test_backend_failure_is_false(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(500, {})):
            self.assertFalse(_call(None))


if __name__ == "__main__":
    unittest.main()
