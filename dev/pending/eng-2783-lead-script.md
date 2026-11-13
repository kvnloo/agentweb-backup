## ENG-2783: Lead call script: say who is calling, offer press 3 straight away (2026-11-13)

- Why: 47 CFR 64.1200(b)(1) and (b)(3) want the caller named first and a key-press opt-out offered within 2 seconds, with the press ending the call.
  Press 3 used to come last in the lead prompt.
- Wording change (`backend/src/services/voice/twiml.ts`, `screenPromptCopy`; owner-approved, exact strings): "This is an automated call from <name>. To stop these
  calls at any time, press 3. This call is about the enquiry you sent us. To reach a person at <name>, call <number>. Press 1 to be connected now, or press 2 if you
  are not available and we will call you again later." (press 2 clause dropped when a retry cannot happen). Digit handling, Gather and timeouts are unchanged.
- Press-3 goodbye shortened from "Understood. <name> will not call this number again. Goodbye." to "<name> will not call this number again. Goodbye."; it is followed by `<Hangup/>` only.
- Emma `update_hot_lead_call_settings` description and the `announcedName` field, and the owner-facing validation messages (`hotLeadCallSettingsService.ts`), now say announcedName
  must be the business's registered (legal) name. No validation change.
- Docs: `backend/docs/integrations/hot-lead-call.md` (new "Compliance basis of the script", including the known open voicemail item: no machine detection, no toll-free number on voicemail).
- Tests: prompt-text assertions updated in twiml.test.ts, twilioVoiceWebhook.test.ts, hotLeadCall.e2e.test.ts, hotLeadCall.e2e.retry.test.ts; new exact-string, order and press-3 Hangup tests.
- NOT verified: how Twilio's TTS speaks the text, and barge-in timing (whether press 3 lands within 2 seconds of the name). It was seen working with a robot that pressed digits
  during the prompt on 2026-11-12, but the audio was not heard by a person.
