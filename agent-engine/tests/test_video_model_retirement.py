#!/usr/bin/env python3
"""Behavioral + guard tests for retiring the stale Veo video model ID from web_agent.py.

web_agent.py hardcoded model="veo-3.0-generate-preview" for Google Veo video
generation. That model ID is retired -- a live video-gen task hit an
uncaught 404 NOT_FOUND from the Veo API (ENG-1070), never reproduced
earlier because prior manual testing exercised the kling-v2.1-std path
instead of this Veo default. The backend (videoGeneration.ts,
agentModeService.ts, llmPricing.ts, emma/tools.ts) had already migrated to
veo-3.1-generate-preview; web_agent.py was the only place still on the
retired ID.

The fix also extracted the previously-duplicated model ID and config-dict
construction (repeated once per branch: image-to-video, text-to-video) into
a single VEO_MODEL_ID constant and a pure build_veo_config_params() helper,
so a future Google retirement only needs updating in one place. Both are
dependency-free (no browser_use/langchain/pydantic/boto3 import needed),
which is what makes them directly unit-testable here: web_agent.py's
top-level imports pull in the full agent-engine conda environment
(browser-use, langchain-aws, playwright deps, ...), none of which is
installed in this stripped-down CI/dev box (no conda, no pip even).
Rather than hand-mock that whole chain -- fragile, and liable to pass for
the wrong reasons -- these tests extract just the two new definitions via
ast and exec them in isolation, so they run against the actual source text
of the fix, not a reimplementation of it.
"""
import os
import unittest
from typing import Optional

AGENT_ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STALE_MODEL = "veo-3.0-generate-preview"
CURRENT_MODEL = "veo-3.1-generate-preview"

# web_agent.py as a whole requires Python 3.12+ (an unrelated pre-existing
# f-string uses a backslash in the expression part, invalid before 3.12) and
# a full conda environment (browser-use, langchain-aws, boto3, ...) neither
# of which is available in this stripped-down box. VEO_MODEL_ID and
# build_veo_config_params are self-contained and 3.9-compatible, so rather
# than parse/import the whole module, extract just this line range (the
# block runs from the VEO_MODEL_ID assignment up to, but not including, the
# next top-level definition) and exec it in isolation -- tests the actual
# source text of the fix, not a reimplementation of it.
_START_MARKER = 'VEO_MODEL_ID = "veo-3.1-generate-preview"'
_END_MARKER = "class LogFilterThread(threading.Thread):"


def _load_web_agent_video_helpers():
    path = os.path.join(AGENT_ENGINE_DIR, "web_agent.py")
    with open(path, "r") as f:
        source = f.read()

    start = source.find(_START_MARKER)
    end = source.find(_END_MARKER)
    if start == -1 or end == -1 or end <= start:
        raise AssertionError(
            "web_agent.py no longer has the expected VEO_MODEL_ID / "
            "build_veo_config_params block in its usual location "
            "(ENG-1070 extraction refactor was reverted, renamed, or moved)"
        )

    snippet = source[start:end]
    namespace = {"Optional": Optional}
    exec(compile(snippet, filename=f"{path} (VEO_MODEL_ID slice)", mode="exec"), namespace)

    for name in ("VEO_MODEL_ID", "build_veo_config_params"):
        if name not in namespace:
            raise AssertionError(f"web_agent.py no longer defines {name} in the expected location")
    return namespace


class TestVeoConfigParamsBehavior(unittest.TestCase):
    """Behavioral coverage for build_veo_config_params(), extracted from the real source."""

    @classmethod
    def setUpClass(cls):
        ns = _load_web_agent_video_helpers()
        cls.VEO_MODEL_ID = ns["VEO_MODEL_ID"]
        cls.build_veo_config_params = staticmethod(ns["build_veo_config_params"])

    def test_uses_the_live_model_id_not_the_retired_one(self):
        """Successful-path fact: the constant must be the live ID."""
        self.assertEqual(self.VEO_MODEL_ID, CURRENT_MODEL)
        self.assertNotEqual(self.VEO_MODEL_ID, STALE_MODEL)

    def test_default_call_with_no_negative_prompt(self):
        """Successful generation path: no negative_prompt -> just aspect_ratio + count."""
        params = self.build_veo_config_params()
        self.assertEqual(params, {"aspect_ratio": "16:9", "number_of_videos": 1})

    def test_with_a_real_negative_prompt(self):
        """Boundary: a truthy negative_prompt is included verbatim."""
        params = self.build_veo_config_params("no text overlays")
        self.assertEqual(
            params,
            {"aspect_ratio": "16:9", "number_of_videos": 1, "negative_prompt": "no text overlays"},
        )

    def test_explicit_none_negative_prompt_is_omitted(self):
        """Invalid/edge input: explicit None must not add a None-valued key."""
        params = self.build_veo_config_params(None)
        self.assertNotIn("negative_prompt", params)

    def test_empty_string_negative_prompt_is_omitted(self):
        """Boundary: an empty string is falsy and must not add an empty key
        (this mirrors the source's `if params.negative_prompt:` truthy check --
        an empty string would otherwise silently pass a blank constraint to the API)."""
        params = self.build_veo_config_params("")
        self.assertNotIn("negative_prompt", params)

    def test_whitespace_only_negative_prompt_is_included(self):
        """Boundary: whitespace-only is truthy in Python, so (matching the
        source's exact truthy check, not stricter validation this fix doesn't
        add) it is passed through rather than silently dropped."""
        params = self.build_veo_config_params("   ")
        self.assertEqual(params.get("negative_prompt"), "   ")

    def test_aspect_ratio_and_count_are_always_present_and_fixed(self):
        """Aspect ratio and video count are Veo 3's fixed constraints, not
        caller-configurable -- must hold regardless of negative_prompt."""
        for negative_prompt in (None, "", "avoid X"):
            params = self.build_veo_config_params(negative_prompt)
            self.assertEqual(params["aspect_ratio"], "16:9")
            self.assertEqual(params["number_of_videos"], 1)


class TestNoStaleVeoModelReferences(unittest.TestCase):
    """Source guards: the retired Veo model ID must not come back, and both
    generate_videos() call sites and the default fallback must reference the
    single VEO_MODEL_ID constant rather than duplicating the literal."""

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

    def test_web_agent_generate_videos_calls_use_the_shared_constant(self):
        src = self._read("web_agent.py")
        occurrences = src.count("model=VEO_MODEL_ID")
        self.assertEqual(
            occurrences, 2,
            "expected both generate_videos() calls (image-to-video and "
            f"text-to-video branches) to pass model=VEO_MODEL_ID, found {occurrences}",
        )

    def test_web_agent_default_video_model_fallback_uses_the_shared_constant(self):
        src = self._read("web_agent.py")
        self.assertIn(
            "self.video_model or VEO_MODEL_ID", src,
            "the default video_model fallback must reference VEO_MODEL_ID, "
            "not a duplicated literal",
        )


if __name__ == "__main__":
    unittest.main()
