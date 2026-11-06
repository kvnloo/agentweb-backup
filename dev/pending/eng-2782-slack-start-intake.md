## ENG-2782: public Slack-start intake API (2026-11-05)

- No server-side captcha verifier existed (routes/landingPageGeneration.ts's reCAPTCHA code only manages a
  generated site's Vercel env vars), so `services/slackStart/slackStartCaptcha.ts` is a minimal Turnstile client
  that fails closed outside an explicit development/test NODE_ENV.
- `userDb.createUser`'s `attribute_not_exists(email)` condition is on a userId-keyed put, so it does not stop two
  rows with one email. The intake relies on the domain lock + an EmailIndex pre-check, same as /api/auth/register.
- `triggerBrandBuildForUser` fires WS3 Slack Connect provisioning as a side effect. The intake passes
  `skipSlackConnect` and provisions only on completion, so the two cannot double-invite once the flag is on.
- Docs: backend/docs/SLACK_START.md.
