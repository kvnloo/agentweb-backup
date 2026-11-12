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

**Voice usage (owner, 2026-11-12: "voice has to have usage and everything linked up properly").**
- Admission: a voice call is admitted like a typed turn (`checkTokenUsage(owner, TURN_ADMISSION)`), after the ownership
  check and before any Gemini session exists; a paused or over-limit account (the share link's owner, for a share-link
  call) is refused with typed chat's message and `code: 'usage_paused'`; a failed lookup refuses (fail closed). After
  every completed turn the same check runs; a call whose allowance ran out is told so and ended (a transient lookup
  failure does not cut a live call).
- Cost: each Gemini usage report is priced per modality from the price book (`LIVE_MODALITY_PRICES`, Google's paid-tier
  rates read 2026-11-12: input text 0.75, audio 3.00, image/video 1.00; output text 4.50, audio 12.00 USD per 1M tokens)
  instead of the text-rate approximation, which under-priced audio about 4x in and 2.7x out. Metered under the
  feature `live_voice` (was the generic `agent_task`), so usage reports show voice as its own line.
- Usage reports were measured on the test environment (3-turn call, 2026-11-12): exactly one report per turn, each the
  turn's own usage (prompt ~91k each turn: the full context incl. every tool declaration is re-sent per turn, growing by
  only that turn; response 95/83/78), so each report is charged as it arrives. A count-only log line per report stays.
- Price book version bumped to 2026-11-12 with `LIVE_MODALITY_PRICES` in the pinned fingerprint (voice events before it
  were priced at the text-rate approximation).
- Feature `live_voice:interactive`; token counts as Google defines them (cached tokens once, as cache reads; tool-use
  prompt as input; thinking as output). The voice cost is also added to the chat's own cost (`addToolCostToSession`,
  key `live_voice`), so per-chat cost includes voice and an anonymous public-plan session's cap counts it.
- Share-link visitors refused for usage see typed share chat's wording, not the owner's billing message; the portal
  shows the usage message (not "try again") for `usage_paused`.
- Cost note: a voice turn sends about 91k input tokens (mostly tool declarations), about $0.07 a turn; trimming the
  voice tool list is the main lever for voice cost (not in this change).
- The switch route is still not what gates voice; the voice start is.

**Testing:** `agentModeController.voiceModel.test.ts` (7 cases: the endpoint, the helper's gates, both switch routes
still refuse the voice model); related suites pass. Portal PR: client-side enter/leave, button follows the endpoint,
voice panel note.

**Rollback:** revert both PRs; the button goes back to doing nothing.
