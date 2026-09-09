#!/usr/bin/env python3
"""ENG-1828: integration tests for StrictActionController against the real
browser_use ActionModel shape.

Unlike test_describe_populated_actions.py's pure duck-typed test, this
constructs a genuine dynamically-built ActionModel class via a real
Controller's registry (Controller.registry.create_action_model()) -- the
exact same mechanism browser-use itself uses -- so it exercises the real
class shape (field order, field names) that a monkeypatched/duck-typed
object could get wrong without anyone noticing. Requires the real
browser_use package (run via the agent-engine conda env, not plain python).

Controller.act (the base class method) is stubbed for the single-populated-
field case so this stays a fast unit test -- it verifies delegation
happened with the right action, not real browser execution (that's covered
by live E2E testing, not appropriate for a unit test).
"""
import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from browser_use import Controller
from strict_action_controller import StrictActionController


def _build_action_model_cls():
    return StrictActionController().registry.create_action_model()


class TestStrictActionController(unittest.TestCase):
    def test_multi_field_response_raises_before_touching_the_browser(self):
        # Mirrors the exact shape observed 5x in production: done first
        # (always registered first in Controller.__init__), plus others.
        ActionModelCls = _build_action_model_cls()
        action = ActionModelCls(
            done={"text": "fabricated result", "success": True},
            go_to_url={"url": "https://example.com"},
        )
        controller = StrictActionController()

        async def run():
            # browser_context=None: if this ever reached the real
            # implementation it would crash on a None browser_context --
            # confirms the raise happens BEFORE any delegation, not after.
            await controller.act(action, None)

        with self.assertRaises(ValueError) as ctx:
            asyncio.run(run())
        self.assertIn("2 actions were populated simultaneously", str(ctx.exception))
        self.assertIn("done", str(ctx.exception))
        self.assertIn("go_to_url", str(ctx.exception))

    def test_single_populated_field_delegates_to_the_real_controller(self):
        ActionModelCls = _build_action_model_cls()
        action = ActionModelCls(go_to_url={"url": "https://example.com"})
        controller = StrictActionController()

        with patch.object(Controller, "act", new_callable=AsyncMock) as mock_act:
            mock_act.return_value = "sentinel-result"
            result = asyncio.run(controller.act(action, "sentinel-browser-context"))

        mock_act.assert_called_once_with(action, "sentinel-browser-context")
        self.assertEqual(result, "sentinel-result")

    def test_zero_populated_fields_also_delegates_not_rejected(self):
        # Deliberately out of scope -- see strict_action_controller.py's
        # module docstring for why.
        ActionModelCls = _build_action_model_cls()
        action = ActionModelCls()
        controller = StrictActionController()

        with patch.object(Controller, "act", new_callable=AsyncMock) as mock_act:
            mock_act.return_value = "sentinel-result"
            asyncio.run(controller.act(action, "sentinel-browser-context"))

        mock_act.assert_called_once()


if __name__ == "__main__":
    unittest.main()
