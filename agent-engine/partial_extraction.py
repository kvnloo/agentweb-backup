"""ENG-859: salvage partial browser-extraction output on an incomplete run.

Background: a browser-automation run (WebAgent.execute_task) only delivered its
result when the agent explicitly signalled ``done``. When a long scrape — e.g. a
LinkedIn activity page that needs many scroll/snapshot steps — reached its
step/time limit first, ``result.is_done()`` was False and the whole deliverable
was discarded: the user got a bare "Oops! Something went wrong" and was told to
restart from scratch, even though rows had already been extracted.

This module holds the pure, dependency-free salvage logic (no browser_use /
playwright imports) so it is unit-testable under plain Python. The browser run's
history is duck-typed: it only needs an ``extracted_content()`` method that
returns either a list of strings or a single string.
"""
from typing import Optional

# Cap the salvaged text so a runaway history cannot bloat the response or the
# persisted transcript. Generous enough to carry a full activity page.
_MAX_PARTIAL_CHARS = 20000


def collect_partial_extraction(result) -> Optional[str]:
    """Return everything a browser run already extracted as one string.

    ``result`` is a browser_use ``AgentHistoryList`` (duck-typed). Returns None
    when nothing usable was captured. Any access error degrades to None so this
    can never raise into the caller's already-failing path.
    """
    try:
        content = result.extracted_content()
    except Exception:
        return None
    if not content:
        return None
    if isinstance(content, (list, tuple)):
        parts = [str(c).strip() for c in content if c is not None and str(c).strip()]
    else:
        text = str(content).strip()
        parts = [text] if text else []
    if not parts:
        return None
    joined = "\n\n".join(parts)
    if len(joined) > _MAX_PARTIAL_CHARS:
        joined = joined[:_MAX_PARTIAL_CHARS].rstrip() + "\n\n…(partial results truncated)"
    return joined


def build_incomplete_run_message(partial: Optional[str]) -> Optional[str]:
    """Wrap salvaged partial content in a user-facing note, or None if empty.

    Deliberately frames the outcome as "here is what I gathered, ask me to
    continue" rather than "restart" — returning the partial deliverable instead
    of zeroing it out is the whole point of ENG-859.
    """
    if not partial:
        return None
    return (
        "I wasn't able to fully finish, but here is the data I gathered before the "
        "run reached its step/time limit:\n\n"
        f"{partial}\n\n"
        "(Partial results — ask me to continue and I'll pick up from here rather "
        "than starting over.)"
    )
