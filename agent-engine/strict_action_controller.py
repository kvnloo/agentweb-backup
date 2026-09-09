"""ENG-1828: reject a malformed multi-action browser-use response instead of
silently executing the wrong one.

Background: browser-use's per-step call asks the LLM for one `ActionModel`
per list item in `AgentOutput.action` -- a single dynamically-built pydantic
model with every registered action (`done`, `go_to_url`, `search_google`,
`write_file`, ...) as an optional sibling field, not a discriminated union.
Nothing in the JSON schema enforces "exactly one populated field per
`ActionModel`" -- that invariant is only ever assumed by the framework's own
code (`ActionModel.set_index()`'s `next(iter(...))`, `Controller.act()`'s own
"execute the first non-null field" loop), never actually validated.

Observed 5 times in production (2026-09-08/09, across ENG-1818/1820/1822/1823's
live testing): the LLM's response populates several action fields at once
instead of exactly one. `Controller.act()` iterates
`action.model_dump(exclude_unset=True).items()` and unconditionally executes
whichever field it finds first, silently discarding the rest -- and that
field is always `done` (confirmed: `done` is registered first in
`Controller.__init__`, before any navigation action), so a malformed
multi-field response always terminates the task prematurely with a
fabricated result, never getting a chance to perform whatever the other
populated (possibly genuine) fields described.

This module holds a `Controller` subclass that validates before delegating,
so the framework's own already-existing step-error/retry machinery
(`Agent._handle_step_error`, bounded by the same `max_failures`/`retry_delay`
already configured in `web_agent.py`) handles recovery -- no new retry logic
needed. Deliberately a subclass, not a monkeypatch of `Controller` itself:
`self.controller` (constructed once per `WebAgent.setup()`, one OS subprocess
per task) is the only instance that matters here, confirmed via `grep` that
`Controller.act(` has exactly one call site in the whole installed
`browser_use` package -- a global class-level patch would carry needless
blast radius a subclass doesn't.

A response with ZERO populated fields is deliberately NOT rejected here:
unlike the multi-field case, it falls through to a harmless no-op
`ActionResult()` (`is_done=False`) in the real `Controller.act()`, so the
agent just proceeds to the next step rather than fabricating anything --
not observed in production, and not worth guarding against a hypothetical
that isn't actually dangerous.
"""
from typing import List, Tuple

from browser_use import Controller


def describe_populated_actions(action) -> Tuple[int, List[str]]:
    """Return (count, field_names) of populated fields on one ActionModel.

    ``action`` is duck-typed: it only needs ``model_dump(exclude_unset=True)``,
    matching the exact call browser-use's own ``Controller.act()`` makes, so
    this count reflects precisely what the real execution path would iterate
    over.
    """
    dumped = action.model_dump(exclude_unset=True)
    populated = [name for name, value in dumped.items() if value is not None]
    return len(populated), populated


class StrictActionController(Controller):
    """Raise instead of silently executing the first of several populated
    action fields. See module docstring for the full mechanism and why a
    subclass (not a monkeypatch) is the right intervention point.
    """

    async def act(self, action, *args, **kwargs):
        count, names = describe_populated_actions(action)
        if count > 1:
            raise ValueError(
                f"Malformed agent response: {count} actions were populated "
                f"simultaneously ({', '.join(names)}) -- you must return "
                "exactly ONE action per step, with every other action field "
                "left unset/null. Retry with only the single action you "
                "actually intend to take this step."
            )
        return await super().act(action, *args, **kwargs)
