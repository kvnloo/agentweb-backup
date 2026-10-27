## ENG-673: Smartlead key connection (2026-10-27)

A customer connects their own Smartlead account by pasting an API key (Smartlead documents no OAuth). `POST /api/oauth/smartlead/connect` validates it by listing the key's mailboxes (`listEmailAccounts`, first page only on connect; paging by offset exists for later slices but is unverified against live Smartlead) and stores it as an `api_key` connected account, modelled on Luma: key encrypted in `config.access_token`, one connection per user (`account_id` is `smartlead-<userId>`, since Smartlead has no "who am I" call; replacing a key makes the connection private again via `createAccount`'s `resetSharing`), rate-limited to 10 tries per 15 minutes per user.

- API and webhooks need Smartlead Pro ($94) or above; Base has no API. An expired plan and a wrong key may both return 401, so the 422 message names both. Not yet seen against a real account: the exact response shape of `GET /email-accounts` (`id`, `from_email` assumed from the docs) and what a Base key returns.
- A valid key with no mailboxes connects, with a `warning` in the response.
- Not done here: `needs_reconnect` (nothing sets it until the first call that uses the key), the per-key throttle (`nextSlotAt` in `smartleadService.ts` is one module-wide slot shared by every key; fix before the push slice), the webhook receiver.

Test env only: `SMARTLEAD_API_BASE_URL` points Smartlead calls at `test-env/smartlead-stub.js` (compose profile `smartlead-stub`). It is honoured only when `NODE_ENV` is `development` or `test`, never when unset or `production`. The stub is our guess at Smartlead replies, so it proves our handling, not Smartlead behaviour.
