"""ENG-1823: separate "did the run finish" from "did it actually succeed".

Background: WebAgent.execute_task drove both the ENG-859 partial-extraction
salvage gate AND the customer-facing success field off a single
``result.is_done()`` check. ``is_done()`` only answers "did the agent invoke
the `done` action at all" -- it says nothing about that action's own
``success`` field. A run whose final `done` action explicitly reported
``success: false`` (or a malformed/hallucinated result the agent itself
flagged as not real) still got reported to the customer -- and written to
DynamoDB -- as ``status: completed``, because nothing downstream ever looked
past "did done get called".

This module holds the pure, dependency-free split (no browser_use /
playwright imports) so it is unit-testable under plain Python. The browser
run's history is duck-typed: it only needs ``is_done()`` and
``is_successful()`` methods, matching browser_use's real
``AgentHistoryList``.
"""
from typing import Tuple


def determine_task_completion_status(result) -> Tuple[bool, bool]:
    """Return (task_is_done, task_succeeded) for one browser-use run.

    task_is_done: did the agent invoke `done` at all, regardless of outcome.
    Keep using this for anything that only cares whether the run finished
    (e.g. the ENG-859 salvage-path gate) -- that logic is intentionally
    unaffected by this split.

    task_succeeded: did that `done` call's own `success` field say True.
    This is the one that belongs in any customer-facing or persisted
    "did the task succeed" field -- never task_is_done.

    Always False when the run never finished; never True on its own.
    """
    task_is_done = bool(result.is_done())
    task_succeeded = task_is_done and result.is_successful() is True
    return task_is_done, task_succeeded
