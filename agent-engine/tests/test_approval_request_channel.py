"""ENG-273: an approval request must not require a Slack channel, and must not fail open.

Slack and WhatsApp are separate features and a customer connects one of them. A task with a
Slack channel keeps using `send_task_approval_request` and the Slack endpoint, untouched. A
task without one asks on the customer's connected channel through a channel-neutral
endpoint, and the three possible outcomes are kept apart because the caller treats them
differently.
"""
import os
import re
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


_OUR_404 = "<pre>Cannot POST /api/approval-requests</pre>"


def _response(status, body=None, text=""):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = body if body is not None else {}
    r.text = text or str(body)
    return r


def _ask(**overrides):
    args = dict(task_id="task-1", execution_id="exec-1",
                asset_url="https://assets.example.com/r.html", filename="r.html",
                asset_type="html", user_id="user-1")
    args.update(overrides)
    return slack_utils.request_task_approval_without_slack(**args)


@patch.object(slack_utils, "create_jwt_token", return_value="jwt")
class WithoutSlackTest(unittest.TestCase):
    def test_posts_to_the_neutral_endpoint_with_no_slack_fields(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(200, {"success": True})) as post:
            _ask()
        self.assertTrue(post.call_args[0][0].endswith("/api/approval-requests"))
        body = post.call_args[1]["json"]
        self.assertNotIn("channel", body)
        self.assertNotIn("channelName", body)
        self.assertEqual(body["assetUrl"], "https://assets.example.com/r.html")

    def test_success_is_sent(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(200, {"success": True})):
            self.assertEqual(_ask(), slack_utils.APPROVAL_SENT)

    def test_no_connected_channel_is_no_channel_and_not_an_error(self, _jwt):
        resp = _response(409, {"code": "no_channel"})
        with patch.object(slack_utils.requests, "post", return_value=resp):
            with self.assertLogs(slack_utils.logger, level="INFO") as logs:
                self.assertEqual(_ask(), slack_utils.APPROVAL_NO_CHANNEL)
        self.assertFalse(any(r.levelname == "ERROR" for r in logs.records))

    def test_a_failed_send_to_a_reachable_customer_is_FAILED_not_no_channel(self, _jwt):
        # HTTP 502 delivery_failed: the account HAS a channel and the send failed. Reading
        # that as "no channel" would let unreviewed output through to subscribers.
        resp = _response(502, {"code": "delivery_failed"})
        with patch.object(slack_utils.requests, "post", return_value=resp):
            with self.assertLogs(slack_utils.logger, level="ERROR"):
                self.assertEqual(_ask(), slack_utils.APPROVAL_FAILED)

    def test_an_endpoint_that_does_not_exist_yet_is_no_channel_not_failed(self, _jwt):
        # The engine can be deployed before the backend. A 404 must not hold the results of
        # every approval-required task that has no Slack channel until the backend catches up.
        with patch.object(slack_utils.requests, "post", return_value=_response(404, {}, _OUR_404)):
            with self.assertLogs(slack_utils.logger, level="WARNING"):
                self.assertEqual(_ask(), slack_utils.APPROVAL_NO_CHANNEL)

    def test_a_404_that_is_not_our_missing_route_is_failed_and_holds(self, _jwt):
        # A proxy, a wrong BACKEND_URL or a rolled-back route table also answer 404. That is not
        # the backend saying nobody can be asked, so unreviewed output must not be released.
        for body in ("", "<html>404 Not Found nginx</html>", '{"error":"Documentation not found"}'):
            with patch.object(slack_utils.requests, "post", return_value=_response(404, {}, body)):
                with self.assertLogs(slack_utils.logger, level="ERROR"):
                    outcome = _ask()
            self.assertEqual(outcome, slack_utils.APPROVAL_FAILED)
            self.assertTrue(slack_utils.should_hold_results_for_approval(True, None, outcome))

    def test_that_404_is_released_by_the_hold_rule(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(404, {}, _OUR_404)):
            outcome = _ask()
        self.assertFalse(slack_utils.should_hold_results_for_approval(True, None, outcome))

    def test_a_409_that_is_not_no_channel_is_failed(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(409, {"code": "something_else"})):
            self.assertEqual(_ask(), slack_utils.APPROVAL_FAILED)

    def test_a_409_with_an_unreadable_body_is_failed(self, _jwt):
        resp = _response(409)
        resp.json.side_effect = ValueError("not json")
        with patch.object(slack_utils.requests, "post", return_value=resp):
            self.assertEqual(_ask(), slack_utils.APPROVAL_FAILED)

    def test_server_error_is_failed(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(500, {})):
            self.assertEqual(_ask(), slack_utils.APPROVAL_FAILED)

    def test_a_200_without_success_is_failed(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(200, {"success": False})):
            self.assertEqual(_ask(), slack_utils.APPROVAL_FAILED)

    def test_a_network_error_is_failed_and_does_not_raise(self, _jwt):
        with patch.object(slack_utils.requests, "post", side_effect=OSError("connection reset")):
            self.assertEqual(_ask(), slack_utils.APPROVAL_FAILED)


class NoTokenTest(unittest.TestCase):
    def test_a_missing_token_is_failed_without_calling_the_backend(self):
        with patch.object(slack_utils, "create_jwt_token", return_value=None), \
             patch.object(slack_utils.requests, "post") as post:
            self.assertEqual(_ask(), slack_utils.APPROVAL_FAILED)
        post.assert_not_called()


class SlackPathUnchangedTest(unittest.TestCase):
    """The Slack function must behave exactly as before — it is the path Slack customers use."""

    @patch.object(slack_utils, "create_jwt_token", return_value="jwt")
    def test_still_posts_to_the_slack_endpoint_with_the_channel(self, _jwt):
        with patch.object(slack_utils.requests, "post", return_value=_response(200, {"success": True})) as post:
            ok = slack_utils.send_task_approval_request(
                "task-1", "Weekly report", "exec-1", "https://assets.example.com/r.html",
                "r.html", "html", "C0APPROVALS", "user-1")
        self.assertTrue(ok)
        self.assertTrue(post.call_args[0][0].endswith("/api/slack/send-approval"))
        self.assertEqual(post.call_args[1]["json"]["channel"], "C0APPROVALS")


class HoldRuleTest(unittest.TestCase):
    """Whether subscribers are emailed while approval is pending."""

    hold = staticmethod(slack_utils.should_hold_results_for_approval)

    def test_a_task_that_does_not_need_approval_is_never_held(self):
        for slack in ("C1", None):
            for outcome in (None, slack_utils.APPROVAL_SENT, slack_utils.APPROVAL_FAILED):
                self.assertFalse(self.hold(False, slack, outcome))
        self.assertFalse(self.hold(None, "C1", None))

    def test_a_slack_task_is_held_whatever_happened_to_the_post(self):
        # Unchanged from before WhatsApp existed.
        for outcome in (None, slack_utils.APPROVAL_SENT, slack_utils.APPROVAL_FAILED, slack_utils.APPROVAL_NO_CHANNEL):
            self.assertTrue(self.hold(True, "C0APPROVALS", outcome))

    def test_a_request_that_was_sent_holds_the_results(self):
        self.assertTrue(self.hold(True, None, slack_utils.APPROVAL_SENT))

    def test_a_request_that_FAILED_to_a_reachable_customer_holds_the_results(self):
        # The case this exists for: otherwise unreviewed output goes to subscribers.
        self.assertTrue(self.hold(True, None, slack_utils.APPROVAL_FAILED))

    def test_a_customer_with_no_channel_at_all_is_released_as_before(self):
        self.assertFalse(self.hold(True, None, slack_utils.APPROVAL_NO_CHANNEL))

    def test_nothing_attempted_is_released_as_before(self):
        self.assertFalse(self.hold(True, None, None))


class MonitorWiringTest(unittest.TestCase):
    """The monitor must actually use the rule, not a private copy of it."""

    def test_uses_the_shared_hold_rule(self):
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "task_monitor.py")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("should_hold_results_for_approval(requires_approval, slack_channel, approval_outcome_without_slack)", src)
        self.assertNotIn("approval_sent_without_slack", src)

    def test_never_assumes_an_approval_was_sent(self):
        # The email-friendly revision only posts its own approval when the execution has a
        # Slack channel. Assuming it asked for everyone else held results with no approval
        # request in existence and nobody able to release them.
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "task_monitor.py")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        # An ASSIGNMENT of APPROVAL_SENT (not the comparison `== APPROVAL_SENT`) would mean the
        # monitor decided an approval existed without asking.
        self.assertIsNone(re.search(r"(?<![=!<>])=\s*APPROVAL_SENT\b", src))


if __name__ == "__main__":
    unittest.main()
