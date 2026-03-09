"""Check: Emma should install skills before using their tools.

This is an LLM-evaluated check that examines the conversation transcript
to verify Emma installs relevant skills before calling tools that belong
to those skills.
"""

PROMPT_TEMPLATE = """You are evaluating an AI marketing assistant called Emma.

Emma has a skill system where she must "install" skill packages before using
the tools they provide. For example, she should install "Content Creation" skills
before using blog writing or social media posting tools.

Review the conversation transcript below and determine:
1. Did Emma attempt to use any tools (function calls)?
2. If so, did she install the relevant skills BEFORE using those tools?
3. Were there cases where she used a tool without installing its skill first?

A "skill install" appears as a function call like install_skills, add_skills,
or similar. Tool usage appears as other function calls.

If Emma didn't need to use any tools (e.g., just answered a question), pass.
If Emma installed skills before using their tools, pass.
If Emma used tools without installing skills first, fail.

Transcript:
{scenario_input}

{generation}

Return only "pass" or "fail" followed by a brief explanation."""

CHECK_TYPE = "pass_fail"
"""Whether this is a pass/fail or score check."""
"""Output type for Okareo: "pass_fail" means binary, "score" means 1-5."""
"""We use pass_fail here since skill installation is a binary requirement."""
"""The model either installed skills first or it didn't."""
