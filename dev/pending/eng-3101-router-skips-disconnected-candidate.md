## ENG-3101: LinkedIn write routing no longer substitutes an account with a dead session (2026-11-16)

`routeLinkedInWriteToAccountWithHeadroom` (`backend/src/services/agentMode/linkedInAccountRouting.ts`)
took the first other account with daily headroom and no invitation cooldown. It never asked
whether that account's LinkedIn session was alive. In the 2026-11-11 scheduled run five
`send-invite` calls were routed off a capped account onto one already known to be disconnected
and were refused as "LinkedIn account disconnected", while four live accounts were available.

- A candidate that passes the cooldown and headroom checks is now probed with
  `linkedInOutreachService.probeAccountSession` (the 10-minute-cached probe the write preflight
  uses). `disconnected` skips it and the scan continues. `unknown`, or a probe that throws, does
  not exclude it.
- If every other candidate is disconnected the router returns `null`, so the caller gets the
  existing daily-cap refusal for the account it asked for. No new text.
- Only a candidate that would otherwise be chosen is probed: never the requested account, never
  a capped or cooling-down one, none after the pick.
- The router stays read-only. Each skipped dead candidate is passed to an optional
  `onDisconnectedCandidate` callback; `backend/src/emma/impl/linkedin.ts` uses it to call
  `recordUnipileAccountHealth` with the arguments the preflight used when the write was routed
  onto that account, so the stored flag and the owner alert that follow from it are unchanged.
- Not in this change: the "disconnected" refusal text still names no account (ENG-3097).
- Tests: `backend/src/__tests__/linkedInAccountRouting.test.ts`,
  `backend/src/__tests__/agentModeService.linkedInOutreach.test.ts`.
