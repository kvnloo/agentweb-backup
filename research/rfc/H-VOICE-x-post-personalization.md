# RFC-H-VOICE — X posts that sound more like the author

**Status:** ready · **Issue:** [#7](https://github.com/kvnloo/agentweb/issues/7) · **Epic:** [#4](https://github.com/kvnloo/agentweb/issues/4)

## Problem

Generated social drafts read generic. Posts should sound like the author over time.

## Proposal

**Voice Card** (≤2k chars) injected into draft prompts, built from observed edits before publish.

- `backend/src/services/voiceProfileService.ts` — new file
- Session-scoped MVP: capture draft → edit → approve diff in session metadata
- Hook `post_on_connected_account` draft path

## Sub-issues

#13 (capture), #14 (inject), #15 (durable profile, parked)
