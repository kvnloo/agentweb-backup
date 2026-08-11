#!/usr/bin/env python3
"""Guard test for retiring the stale Veo video model ID from web_agent.py.

web_agent.py hardcoded model="veo-3.0-generate-preview" for Google Veo video
generation. That model ID is retired -- a live video-gen task hit an
uncaught 404 NOT_FOUND from the Veo API (ENG-1070), never reproduced
earlier because prior manual testing exercised the kling-v2.1-std path
instead of this Veo default. The backend (videoGeneration.ts,
agentModeService.ts, llmPricing.ts, emma/tools.ts) had already migrated to
veo-3.1-generate-preview; web_agent.py was the only place still on the
retired ID. This asserts the stale ID does not regress back in and the
live one is used at both actual generate_videos() call sites.
"""
import os
import unittest

AGENT_ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STALE_MODEL = "veo-3.0-generate-preview"
CURRENT_MODEL = "veo-3.1-generate-preview"


class TestNoStaleVeoModelReferences(unittest.TestCase):
    """Source guards: the retired Veo model ID must not come back."""

    def _read(self, rel_path):
        with open(os.path.join(AGENT_ENGINE_DIR, rel_path), "r") as f:
            return f.read()

    def test_web_agent_has_no_stale_veo_model_string(self):
        src = self._read("web_agent.py")
        self.assertNotIn(
            STALE_MODEL, src,
            "web_agent.py regressed to the retired Veo model ID "
            f"'{STALE_MODEL}' (404 NOT_FOUND on the live API, ENG-1070)",
        )

    def test_web_agent_generate_videos_calls_use_current_model(self):
        src = self._read("web_agent.py")
        occurrences = src.count(f'model="{CURRENT_MODEL}"')
        self.assertEqual(
            occurrences, 2,
            f"expected both generate_videos() calls to pass model=\"{CURRENT_MODEL}\" "
            f"(image-to-video and text-to-video branches), found {occurrences}",
        )

    def test_web_agent_default_video_model_fallback_uses_current_model(self):
        src = self._read("web_agent.py")
        self.assertIn(
            f'self.video_model or "{CURRENT_MODEL}"', src,
            "the default video_model fallback must use the live Veo model ID",
        )


if __name__ == "__main__":
    unittest.main()
