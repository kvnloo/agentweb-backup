## ENG-2812: a share-link visitor cannot reopen the owner's session limit; pause wording without numbers (2026-11-25)

Follow-up to the per-session turn/spend limit (PR #4242).

**Found live on the test instance.** A share-link visitor who typed "continue" on a paused session reopened the owner's window and got an answer. `startSessionLimit` read the raw typed text and did not ask who typed it (the same class as ENG-3164).

**What changed**
- A visitor's turn never opens a new window, whatever the word ("continue", "yes", "keep going"...). The owner on the same session still can, also from their own share link.
- A visitor on a paused session gets: "This shared chat has reached its usage limit. Ask the person who shared it to continue it."
- A visitor never sees the 75% / 90% notices (their advice, "start a new session", means nothing to them), and their turns do not claim a notice, so the owner's next turn still gets it.
- Owner decision (2026-11-25): the pause text carries no numbers (no step count, no dollar figure): "This session has reached its usage limit. Reply "continue" to keep going in this session, or start a new session." The exact usage is still logged (`session_limit_paused`) and stored on the message (`sessionLimitPaused`).

**Which signal.** `isInteractiveShare`, the flag the share route already passes (`!viewerIsOwner`, so false for the owner on their own link). It crosses the worker boundary (controller payload, worker entry, `generateSessionResponse`). The in-process `isShareVisitorTurn` marker was NOT used on purpose: replies are generated in a forked worker, where that set is empty.

**Limits (not changed here)**
- Slack sessions and MCP agents: a "continue" typed there is judged by its text only (as before).
- A visitor on a paused session sees the pause text and cannot reopen; only the owner can.
- The kill switch `SESSION_LIMIT_ENFORCE=false` still disables the whole limit.

**Tests.** `sessionLimit.test.ts`: visitor cannot confirm (several words, the owner still can), visitor wording, visitor notices neither shown nor claimed, new wording exact, and the wiring (the call site passes `isShareVisitor`, the flag crosses the worker boundary, the share route sends `!viewerIsOwner`).
