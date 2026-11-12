## ENG-2957: the chat's voice button works again (broken since 2026-10-07) (2026-11-12)

The "Switch to voice mode" button switches a chat to the live-voice model (`gemini-3.1-flash-live-preview`) and the voice
call starts once the chat is on it. Two changes on 2026-10-07 broke it without an error:

- PR #3339 (ENG-903) removed the live-voice model from `/model-options` (a text-model picker must never offer it). The
  portal only switched to voice when that list contained the model, so the button did nothing.
- Commit `8b0794b64` (PR #3276, ENG-2293) made both model-switch routes use `isModelSelectableBy`, which excludes live
  models: switching a chat to the voice model answered 422 (plan allowlist on) or 403, and 403 on a share link.

Share pages had already lost the button on 2026-08-19 (the public catalog hides live models). Production logs held no
voice session started from the app.

**What changed**
- `agentModeService.getVoiceModelFor(isAdmin)` / `isVoiceModelSelectableBy`: the served live-voice model, with the same
  internal-only and admin-only gates as the picker.
- `updateSessionLlmModel`: the live-voice model is judged on those gates for the session OWNER and skips the text
  picker and plan checks (voice mode is not a text pick: generation refuses it and a stored one falls back for text).
- `updateSharedSessionLlmModel`: the same for share links, viewers judged as non-admin. Share token checks unchanged.
- New `GET /api/agent-mode/public/voice-model` → `{ voiceModel }`. `/model-options` and `/public/llm-models` are
  unchanged and still never list it. The portal reads the new endpoint, hides the button when it is null, and the voice
  panel says voice runs on Gemini Live.

**Not changed:** every text model's checks; which tools voice offers; share-link visitor restrictions on voice (ENG-2816).

**Testing:** `agentModeController.voiceModel.test.ts` (15 cases, six deliberate breakages each caught); 18 related
suites (823 tests). Test environment: owner clicked the voice button (switch 200, live session, Gemini answered a typed
turn, leaving restored the previous model, no picker during voice); a logged-out visitor on a share link started voice.

**Rollback:** revert; the button goes back to doing nothing.
