## ENG-2783: Lead call script: say who is calling, offer press 3 straight away (2026-11-13)

- Why: 47 CFR 64.1200(b)(1) and (b)(3) want the caller named first and a key-press opt-out offered within 2 seconds, with the press ending the call.
  Press 3 used to come last in the lead prompt.
- Wording change (`backend/src/services/voice/twiml.ts`, `screenPromptCopy`; owner-approved wording B, exact strings): "Hi, this is an automated call from <name>. To stop these
  calls at any time, press 3. We're calling about the enquiry you sent us. Press 1 and we'll connect you to a person now, or press 2 and we'll call you again later. You can also call us on <number>."
  (press 2 clause dropped when a retry cannot happen). The callback number is now last, so a lead who presses early never hears it; accepted by the owner. Apostrophes are written as &apos; like all copy. Digit handling, Gather and timeouts are unchanged.
- 64.1200(b)(2): the callback number is the prompt's last sentence, so key-press replies now state it: press 3 ("<name> will not call this number again. You can reach us on <number>. Goodbye."),
  press 2 ("Okay. <name> will call you again later. You can reach us on <number>. Goodbye."), any other key ("You can reach us on <number>. Goodbye."); press 1 connects to a person (unchanged).
  The number comes from the org context those handlers already resolve (no new read). The prompt does NOT designate press 3 as the exclusive revocation method: operators must still honour any reasonable
  revocation within 10 business days (64.1200(a)(10)/(11)); exclusivity from 2026-11-25 is not claimed.
- Press-3 goodbye shortened from "Understood. <name> will not call this number again. Goodbye." to "<name> will not call this number again. Goodbye."; it is followed by `<Hangup/>` only.
- Emma `update_hot_lead_call_settings` description and the `announcedName` field, and the owner-facing validation messages (`hotLeadCallSettingsService.ts`), now say announcedName
  must be the business's registered (legal) name. No validation change.
- Docs: `backend/docs/integrations/hot-lead-call.md` (new "Compliance basis of the script", including the known open voicemail item: no machine detection, no toll-free number on voicemail).
- Tests: prompt-text assertions (changed twice, the owner picked wording B over the first wording) updated in twiml.test.ts, twilioVoiceWebhook.test.ts, hotLeadCall.e2e.test.ts, hotLeadCall.e2e.retry.test.ts; new exact-string, order and press-3 Hangup tests.
- NOT verified: how Twilio's TTS speaks the text, and barge-in timing (whether press 3 lands within 2 seconds of the name). It was seen working with a robot that pressed digits
  during the prompt on 2026-11-12, but the audio was not heard by a person.
