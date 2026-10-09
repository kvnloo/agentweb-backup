#!/usr/bin/env python3
"""Behavioral + guard tests for the Google video model used by web_agent.py,
and for a related scoping bug (ENG-1122).

History: web_agent.py once hardcoded the retired "veo-3.0-generate-preview"
(404 NOT_FOUND, ENG-1070) and was moved to veo-3.1-generate-preview behind a
single constant. Google then shut down every Veo preview model on 2026-10-22;
the replacement, gemini-omni-1.1-flash, is served ONLY by the Gemini
Interactions API (POST /v1beta/interactions), synchronously returning the clip
as base64 in steps[].content[]. web_agent.py now builds that request with the
pure helper build_omni_interaction_body() and parses the response with
extract_omni_video_base64(). Retired Veo ids stored on old tasks are accepted
and resolve to the Omni model.

The helpers are dependency-free (no browser_use/langchain/pydantic/boto3
import needed), which is what makes them directly unit-testable here:
web_agent.py's top-level imports pull in the full agent-engine conda
environment, none of which is installed in this stripped-down box. Rather
than hand-mock that whole chain, these tests extract just the helper block
via a line-range slice of the real source and exec it in isolation.

ENG-1122: a redundant `import time` inside one branch of
generate_short_video statically made `time` local to the *entire* enclosing
closure per Python's scoping rules, breaking every other branch's use of it.
The guard below keeps any such local re-binding from coming back.
"""
import base64
import os
import unittest
from typing import Optional

AGENT_ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CURRENT_MODEL = "gemini-omni-1.1-flash"
RETIRED_MODELS = (
    "veo-3.1-generate-preview",
    "veo-3.1-fast-generate-preview",
    "veo-3-generate-preview",
    "veo-3.0-generate-preview",
)

# web_agent.py as a whole requires Python 3.12+ and a full conda environment.
# The helper block is self-contained, so extract just this line range (from
# the OMNI_VIDEO_MODEL_ID assignment up to, but not including, the next
# top-level definition) and exec it in isolation -- tests the actual source
# text, not a reimplementation of it.
_START_MARKER = 'OMNI_VIDEO_MODEL_ID = "gemini-omni-1.1-flash"'
_END_MARKER = "class LogFilterThread(threading.Thread):"
_HELPERS = (
    "OMNI_VIDEO_MODEL_ID",
    "GEMINI_INTERACTIONS_URL",
    "LEGACY_GOOGLE_VIDEO_MODEL_IDS",
    "build_omni_interaction_body",
    "extract_omni_video_base64",
)


def _load_web_agent_video_helpers():
    path = os.path.join(AGENT_ENGINE_DIR, "web_agent.py")
    with open(path, "r") as f:
        source = f.read()

    start = source.find(_START_MARKER)
    end = source.find(_END_MARKER)
    if start == -1 or end == -1 or end <= start:
        raise AssertionError(
            "web_agent.py no longer has the expected OMNI_VIDEO_MODEL_ID helper "
            "block in its usual location (renamed or moved)"
        )

    snippet = source[start:end]
    namespace = {"Optional": Optional}
    exec(compile(snippet, filename=f"{path} (OMNI_VIDEO_MODEL_ID slice)", mode="exec"), namespace)

    for name in _HELPERS:
        if name not in namespace:
            raise AssertionError(f"web_agent.py no longer defines {name} in the expected location")
    return namespace


def _read_generate_short_video_closure():
    """Return the source lines spanning the generate_short_video closure body,
    from its decorator line through (but excluding) the next sibling statement
    in the enclosing method."""
    path = os.path.join(AGENT_ENGINE_DIR, "web_agent.py")
    with open(path, "r") as f:
        lines = f.readlines()

    start_idx = end_idx = None
    for i, line in enumerate(lines):
        if "async def generate_short_video(" in line:
            start_idx = i
        elif start_idx is not None and "if self.update_lead_list:" in line:
            end_idx = i
            break

    if start_idx is None or end_idx is None:
        raise AssertionError(
            "Could not locate the generate_short_video closure boundaries in "
            "web_agent.py -- the function or its known trailing sibling "
            "statement was renamed or restructured"
        )
    return "".join(lines[start_idx:end_idx])


class TestOmniInteractionBody(unittest.TestCase):
    """Behavioral coverage for the Interactions API request built by web_agent.py."""

    @classmethod
    def setUpClass(cls):
        ns = _load_web_agent_video_helpers()
        cls.ns = ns
        cls.build = staticmethod(ns["build_omni_interaction_body"])
        cls.extract = staticmethod(ns["extract_omni_video_base64"])

    def test_model_and_endpoint_are_the_live_omni_interactions_api(self):
        self.assertEqual(self.ns["OMNI_VIDEO_MODEL_ID"], CURRENT_MODEL)
        self.assertEqual(
            self.ns["GEMINI_INTERACTIONS_URL"],
            "https://generativelanguage.googleapis.com/v1beta/interactions",
        )

    def test_retired_veo_ids_are_listed_as_legacy_aliases(self):
        self.assertEqual(set(self.ns["LEGACY_GOOGLE_VIDEO_MODEL_IDS"]), set(RETIRED_MODELS))

    def test_text_to_video_sends_the_prompt_as_a_plain_string(self):
        body = self.build("a cat surfing")
        self.assertEqual(body, {
            "model": CURRENT_MODEL,
            "input": "a cat surfing",
            "response_format": {"type": "video", "aspect_ratio": "16:9", "resolution": "720p"},
        })

    def test_image_to_video_sends_the_image_part_before_the_text_part(self):
        body = self.build("animate it", image_b64="QUJD", image_mime_type="image/png")
        self.assertEqual(body["input"], [
            {"type": "image", "data": "QUJD", "mime_type": "image/png"},
            {"type": "text", "text": "animate it"},
        ])

    def test_image_without_mime_type_defaults_to_jpeg(self):
        body = self.build("x", image_b64="QUJD")
        self.assertEqual(body["input"][0]["mime_type"], "image/jpeg")

    def test_negative_prompt_is_folded_into_the_text(self):
        self.assertEqual(self.build("a beach", negative_prompt="no people")["input"],
                         "a beach\n\nAvoid: no people")

    def test_empty_negative_prompt_is_ignored(self):
        self.assertEqual(self.build("a beach", negative_prompt="")["input"], "a beach")

    def test_extracts_base64_video_from_completed_steps(self):
        data = base64.b64encode(b"mp4-bytes").decode()
        response = {
            "id": "i1", "status": "completed",
            "steps": [
                {"type": "thought", "content": [{"type": "text", "text": "planning"}]},
                {"type": "model_output", "content": [{"type": "video", "mime_type": "video/mp4", "data": data}]},
            ],
        }
        self.assertEqual(self.extract(response), data)

    def test_returns_none_when_not_completed_or_no_video(self):
        self.assertIsNone(self.extract({"status": "failed", "steps": []}))
        self.assertIsNone(self.extract({"status": "completed", "steps": [{"content": [{"type": "text", "text": "no"}]}]}))
        self.assertIsNone(self.extract({"status": "completed"}))
        self.assertIsNone(self.extract(None))


class TestNoRetiredGoogleVideoModelCalls(unittest.TestCase):
    """Source guards: no retired Veo id may be called, the SDK generate_videos
    path must not come back, and the default resolves to the Omni constant."""

    def _read(self, rel_path):
        with open(os.path.join(AGENT_ENGINE_DIR, rel_path), "r") as f:
            return f.read()

    def test_retired_ids_appear_only_in_the_legacy_alias_tuple(self):
        src = self._read("web_agent.py")
        for model in RETIRED_MODELS:
            with self.subTest(model=model):
                self.assertEqual(src.count(f'"{model}"'), 1,
                                 f"{model} must only appear in LEGACY_GOOGLE_VIDEO_MODEL_IDS")

    def test_sdk_generate_videos_path_is_gone(self):
        self.assertNotIn("generate_videos(", self._read("web_agent.py"))

    def test_default_and_legacy_ids_resolve_to_the_omni_constant(self):
        src = self._read("web_agent.py")
        self.assertIn("self.video_model or OMNI_VIDEO_MODEL_ID", src)
        self.assertIn("if video_model in LEGACY_GOOGLE_VIDEO_MODEL_IDS:", src)


def _find_locally_bound_names(closure_src):
    """Walk the closure's real AST (not a text search -- Greptile P2, ENG-1122:
    a substring search on `import {name}` both false-positives on comments/
    strings mentioning it and false-negatives on other binding forms, e.g.
    `from time import sleep as time` or a plain `time = ...` assignment,
    that would equally poison the enclosing function's scope for that name)
    and return the set of names bound anywhere within it via Import,
    ImportFrom (including aliases), or a plain assignment target -- i.e.
    every mechanism that makes Python treat a name as local to the whole
    function, not just the specific branch containing the statement.

    Parses via a synthetic `if True:` wrapper rather than importing the
    module directly, since web_agent.py as a whole requires Python 3.12+
    (an unrelated pre-existing f-string elsewhere in the file) and a full
    conda environment (browser-use, langchain-aws, ...), neither available
    in this stripped-down box. The closure itself needs neither.
    """
    import ast

    tree = ast.parse("if True:\n" + closure_src, filename="<generate_short_video closure>")
    bound = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                bound.add(alias.asname or alias.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    bound.add(target.id)
    return bound


class TestNoRedundantLocalImportsInVideoClosure(unittest.TestCase):
    """ENG-1122 guard: no branch inside generate_short_video may locally
    bind (import, import-as, or assign) a name that's already imported at
    module level. Python scopes a name as local to the *whole* enclosing
    function the moment any local binding of that name appears anywhere in
    its body -- even in a branch that never executes on a given code path --
    so a redundant local import here silently breaks every other branch's
    use of the same name. This regressed once already (time, inside the
    unrelated kling-v2.1-std branch, broke the then-Veo branch's time.sleep()
    polling loop)."""

    # Names already available module-wide in web_agent.py (see its top-level
    # imports) that must never be locally re-bound inside this closure.
    MODULE_LEVEL_NAMES = ("time", "json", "requests", "uuid")

    def setUp(self):
        self.closure_src = _read_generate_short_video_closure()
        self.locally_bound = _find_locally_bound_names(self.closure_src)

    def test_closure_boundaries_are_found(self):
        self.assertIn("async def generate_short_video(", self.closure_src)

    def test_no_redundant_local_bindings_of_module_level_names(self):
        for name in self.MODULE_LEVEL_NAMES:
            with self.subTest(name=name):
                self.assertNotIn(
                    name, self.locally_bound,
                    f"generate_short_video locally re-binds '{name}' (import, "
                    "import-as, or assignment), which is already available at "
                    "module level -- this poisons the whole closure's scope "
                    "for that name (ENG-1122), even in branches that never "
                    "execute the local binding",
                )

    def test_a_comment_mentioning_an_import_does_not_false_positive(self):
        """The AST walk must ignore text inside comments/docstrings -- a
        substring search would incorrectly flag this. Indented to match how
        _read_generate_short_video_closure() returns real extracted source
        (still at its original nesting depth), which the `if True:` wrapper
        in _find_locally_bound_names() expects."""
        fake_closure = (
            "    async def generate_short_video(params):\n"
            "        # note: time is already imported at module level, not 'import time' here\n"
            '        """docstring mentioning import time for illustration"""\n'
            "        return time.sleep(1)\n"
        )
        self.assertNotIn("time", _find_locally_bound_names(fake_closure))

    def test_import_as_aliasing_the_target_name_is_detected(self):
        """A binding form the old substring check would have missed entirely."""
        fake_closure = (
            "    async def generate_short_video(params):\n"
            "        if False:\n"
            "            from datetime import datetime as time\n"
            "        return time.sleep(1)\n"
        )
        self.assertIn("time", _find_locally_bound_names(fake_closure))

    def test_plain_assignment_to_the_target_name_is_detected(self):
        """A binding form the old substring check would have missed entirely."""
        fake_closure = (
            "    async def generate_short_video(params):\n"
            "        if False:\n"
            "            time = get_some_other_thing()\n"
            "        return time.sleep(1)\n"
        )
        self.assertIn("time", _find_locally_bound_names(fake_closure))

    def test_time_sleep_is_still_called_in_the_closure(self):
        """Guard the guard: confirm the assertion above isn't vacuously true
        because every polling loop using `time` was removed."""
        self.assertIn("time.sleep(", self.closure_src)

if __name__ == "__main__":
    unittest.main()
