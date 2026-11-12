## ENG-2816: live voice on a share link now obeys the same tool restrictions as typed chat (2026-11-05)

Second step of ENG-2816 (step 1, owner recognition for typed chat, is live). A share-link visitor acts under the OWNER's
userId, so every "does this user own it" check passes for them. Typed chat refuses a list of owner-only tools to a visitor
in its preflight (`agentMode/core/toolDispatch.ts`); live voice never went through that preflight, so a visitor on a
voice call could use them. This closes that.

**What changed**
- `services/toolRestrictionProfiles.ts` (new, imports nothing): one registry of restriction profiles. `share_visitor` holds
  the owner-only block list (moved here from toolDispatch, which re-exports it under its old name), admin tools and
  `connect_account`, with the same refusal wording typed chat has always used ("... is not available in shared sessions").
  An unrecognised profile id is treated as the strictest known one. A new restricted source later is one new entry.
- `agentModeService.executeTool` (where every path ends: typed chat, voice, nested calls) now refuses a tool its caller's
  `restrictionProfile` forbids, by throwing `ToolRestrictionDenied`, next to the sandbox guard. Thrown, not returned: voice
  hands a thrown message to Gemini as an error and marks the tool card failed, whereas a returned failure object would be
  summarised as if the tool had run. `executePreparedAgentTool` forwards the profile; the typed-chat dispatcher passes it on
  every tool call of a share turn (both sites), keeping its own preflight refusal unchanged for the model-facing message.
- Voice: each live session gets its own frozen `toolContext` (never the shared `ATTENDED_TOOL_CONTEXT` mutated) used at both
  `executeTool` sites, so the restriction reaches the onboarding-safe tools (connect_account) as well as the rest.
  `startLiveSession(..., restrictionProfile)`; `liveVoiceSocket.getLiveRestrictionProfile(socket)` decides: an interactive
  share socket is a visitor unless it is the session owner's own logged-in view.
- Handshake: the conversable-socket branch of the Socket.IO middleware moved out of `server.ts` into
  `liveVoiceSocket.authenticateConversableSocket` (same checks, same error strings, same precedence, now testable). It also
  reads an optional `auth.viewerToken` (the portal sends the viewer's login there; the portal PR must be live first) and
  records `conversableViewerIsOwner` through the step-1 `isSessionOwnerRequest` (a verified normal login that is the session
  owner's own, never a delegate or service token). A bad or missing `viewerToken` never fails the connection.
- The visitor flag now survives the media auto-continuation after a timed-out shared turn (parameter carried through every
  round) and the owner-reopen durability backstop (`lastUserTurnWasShareVisitor`: a continuation re-runs the last real
  request, so it runs under that request's restrictions whoever opens the chat).

**What did not change.** The owner on their own share link (when the portal sends their login), every normal signed-in
voice call, onboarding voice, and typed chat are unchanged. No table, index, IAM or environment change.

**Rollout order matters.** Merge and deploy the portal PR (sends `viewerToken`) FIRST. If this backend change goes live
first, an owner on a tab opened before the portal deploy connects as a visitor on voice until they reload. Nothing is
exposed in that case, but their own voice tools would be refused.

**Not covered here (separate decisions):** link expiry, usage-limit and evaluation-account checks on voice; scheduled-chat
marking (next PR, needs the data-plane approval); the public variables link; approval-inbox resume.

**Testing.** Live voice cannot be run on a test environment (needs a Gemini key). Instead a real Socket.IO server and
client drive the production handshake, the real start handler and the real voice service with only Gemini, the database and
the tool executor mocked (`liveVoiceSocket.shareVisitor.test.ts`); the real `executeTool` is exercised separately
(`agentModeService.restrictionProfile.test.ts`); the real dispatcher by `toolDispatch.shareProfile.test.ts`; the follow-up
turns by additions to `agentModeController.autoMediaContinuation.test.ts` and `timeoutContinuation.shareVisitor.test.ts`.
Mutation checks (break the code, a test fails) for every rule. Production check: the owner's own account, owner logged in
versus a private window, by voice.

**Rollback.** Revert; voice visitors regain the unrestricted owner tool set (the bug).
