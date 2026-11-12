## ENG-2957: the chat's voice button works again (broken since 2026-10-07) (2026-11-12)

The portal's "Switch to voice mode" button only entered voice mode when the text picker's model list contained the
live-voice model (`gemini-3.1-flash-live-preview`), and then saved that model as the chat's model. Two changes on
2026-10-07 broke it without an error: PR #3339 (ENG-903) removed the live-voice model from `/model-options` (a text
picker must never offer it), and commit `8b0794b64` (PR #3276, ENG-2293) made both model-switch routes refuse live
models. Share pages had lost the button on 2026-08-19 (the public catalog hides live models). Production logs held no
voice session started from the app.

**Design: voice mode is client-side.** The voice session never reads the chat's stored model (`live:start` checks
ownership only), so the portal now enters and leaves voice mode in the picker only and never saves the voice model.
Saving it (the pre-2026-10-07 behaviour) left chats stored on the live model whenever voice was left without pressing
End, and several text paths read the stored model and fail on it (share-link plan check, Slack and email replies,
work plans; found by an independent review of the first version of this change).

**What changed (backend)**
- `agentModeService.getVoiceModelFor(isAdmin)`: the served live-voice model, with the picker's internal-only and
  admin-only gates.
- New `GET /api/agent-mode/public/voice-model` returns `{ voiceModel }` (null = no voice button).
- Unchanged on purpose: both model-switch routes still refuse the live-voice model; `/model-options` and
  `/public/llm-models` still never list it.

**Known, not changed here:** `live:start` has no usage or plan gate (usage is charged to the owner afterwards), and
share-link visitors and public-plan pages get voice again; the switch route is not what gates voice.

**Testing:** `agentModeController.voiceModel.test.ts` (7 cases: the endpoint, the helper's gates, both switch routes
still refuse the voice model); related suites pass. Portal PR: client-side enter/leave, button follows the endpoint,
voice panel note.

**Rollback:** revert both PRs; the button goes back to doing nothing.
