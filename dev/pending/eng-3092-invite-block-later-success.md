## ENG-3092: no run-wide LinkedIn invite-block notice when a later invite went out on another account (2026-11-16)

- `backend/src/controllers/agentModeController.ts`, `detectLinkedInInviteSendBlock`: a failed send-invite that matches the disconnected, cooldown or pacing pattern no longer produces the run-wide notice if a later send-invite in the same run succeeded on a different account. The session note, the owner email text and the oncall alert all read this one value.
- Unchanged: a block with no later invite, with only failed later invites, or with a later success on the same account keeps its notice.
- No new owner-facing text. What the owner is told when one of several accounts is disconnected is ENG-3097.
- Cause on 2026-11-11 (session 97d98044): 5 invites refused on a disconnected account, 10 sent on a second account, and the owner was told "No invitations can be sent".
- Tests: `backend/src/__tests__/eng3092.linkedInInviteBlockLaterSuccess.test.ts` (9 cases).
