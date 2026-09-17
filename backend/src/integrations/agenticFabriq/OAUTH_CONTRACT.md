# PR #2887 OAuth contract correction (ENG-1685)

## Evidence

Inspected the setup prompt embedded in the public dashboard bundle on 2026-09-17:
https://dashboard.agenticfabriq.com/assets/index-DDxLdGek.js
SHA-256: `fc4dc42b3f9586ee58ee59baced42a0748952aa4aa2c04330ff883bd83851fce`.
Sections: app-scoped REST endpoints, multiple accounts, and OAuth callback.

- Initiate accepts `connection_id` and optional `scopes`, returning `oauth_url`,
  `state`, `connection_id`, and `credential_source`. Caller-state echo is not
  documented. The reported live HTTP 200 `afct_*` ticket is modeled with synthetic
  values in the client regression fixture; no live credential request was made.
- Success redirect fields: `status=success`, `tool`, `connection_id`,
  `external_user_id`. Error fields: `status=error`, `tool`, `reason`.
  None are signed. Success requires a fresh connected-row lookup.
- Connection IDs select separate credentials, including on later tool calls.
  A configured row is not a completed connection.

## Binding and limits

AgentWeb generates a fresh 128-bit random connection ID per attempt, requires
initiate to return that exact ID, and binds it locally to the initiating user,
owned mailbox, and Gmail provider. Vendor state is bounded/shape-checked but
never sent as a caller challenge or trusted as CSRF. Unsigned callback user IDs
are ignored. Unknown IDs, wrong providers, malformed/duplicate binding query parameters,
and unbound error redirects fail closed without consuming a legitimate attempt.
An error callback carrying a valid challenge is terminal; an error without an
ID cannot securely identify an attempt, which instead expires or is replaced.

A reservation serializes at most three verification attempts over ten minutes.
Success, bound errors, revoked eligibility, and mismatched ownership are terminal;
transient failures release the reservation. A concurrent replay cannot delete the
third reservation. Expired or superseded in-flight success cannot publish a binding.
Pending/completed ID collisions fail closed without overwriting another account.
Each attempt draws a new random ID, but retired IDs are not tracked: uniqueness
after a terminal attempt is probabilistic, not a guaranteed never-reuse property.

Only verified success records the user/mailbox-to-connection mapping used by the
email bridge. Pending plus completed entries are capped at 1,000. Reconnecting
the same user/mailbox replaces its completed local slot with a pending attempt,
including at capacity; another user/mailbox cannot use that slot. Allocation and
collision checks precede replacement. Reads fail closed until the replacement
verifies; stale callbacks cannot restore the retired mapping. Completed
mappings, like pending attempts, are process-local: restart loses them, other
workers fail closed, and reconnect is required. No persistence/schema changes.
Random IDs can leave abandoned configured rows at the vendor; no cleanup mutation
is attempted here. Connection-list reads accept up to 1,000 rows (aligned with
the local cap), retaining per-row validation and the 1 MB response byte bound.
Larger lists fail closed rather than silently truncating verification data. This
bounded increase does not solve indefinite vendor debris accumulation.
Keep this default-off, allowlisted, read-only spike constrained
until the shared-state and vendor-debris lifecycle are separately approved.

The read-only action gate, empty reviewed-tool manifest, flag, and allowlist
remain unchanged. No deployment, merge, or live canary was performed.

## RED → GREEN → REFACTOR

Before production changes, three targeted suites recorded exit 1:
**4 failed, 37 passed, 41 total**. The four new failures were vendor-ticket
acceptance, callback without state, per-attempt ID freshness, and collision
protection. The previous caller-state-echo and stable OAuth ID assertions were
replaced because they contradicted the confirmed vendor contract; their binding,
replay, and ownership invariants remain covered.

After implementation, the five focused client/store/route/transport/authorization
suites recorded exit 0: **153 passed, 0 failed**. Additional regressions cover
third-attempt concurrency, expiration during verification, supersession, binding
publication/isolation, substituted vendor IDs, and malformed state fields.

Complexity: adds one bounded in-memory verified mapping; removes the incorrect
state-echo requirement and deterministic OAuth connection IDs. No dependencies,
new provider call paths, persistent stores, or write-capable canary actions.

Final verification on Atem, inside the requested isolated checkout:

```sh
cd backend
npm test -- --runTestsByPath src/integrations/agenticFabriq/__tests__/*.test.ts src/routes/__tests__/agenticFabriqSpike.security.test.ts src/services/agentMode/core/__tests__/toolDispatch.agenticFabriqSpike.test.ts src/__tests__/ssrfGuard.test.ts src/__tests__/ssrfGuard.fetchBufferFollowingRedirects.test.ts
npm run typecheck
```

Results: **15/15 suites, 302/302 tests passed, zero failures**, Jest exit 0;
full backend TypeScript check **zero diagnostics, exit 0**; `git diff --check`
passed. An earlier typecheck found an optional-ID narrowing error, corrected
before this final run. One incorrectly pluralized Jest filter started an
unintended broader run; it was stopped and is not counted as verification.

Execution actor: Codex. Existing ENG-1685 ownership was not changed; Linear's
connector required reauthentication, so no issue state/comment was updated.

Local CodeRabbit review raised durability of the completed mapping. This is a
valid pre-rollout limitation, not a reason to recover bindings from unsigned
vendor metadata. Shared persistence is deliberately deferred: the spike is
single-process/default-off, restarts require reconnect, and durable binding is
separate data-plane work. No rollout or durability claim is made here.

## Independent review corrections (2026-09-17)

Strict TDD before production edits: **3 failed, 41 passed, 44 total**, exit 1,
across the client/store suites. Failures reproduced 101-row and 1,000-row vendor
lists plus reconnecting a completed mailbox at the 1,000-entry local capacity.
Negative assertions cover new/cross-user bindings at capacity, more than 1,000
vendor rows, malformed rows beyond index 99, and completed-ID collisions without
losing the existing mapping. No vendor cleanup or other mutation was added.

Final focused verification used the same 15-suite command above: **308 passed,
0 failed, 15/15 suites**, exit 0. Backend typecheck: **zero diagnostics, exit 0**.
Diff whitespace check passed. Complexity: one bounded read-limit adjustment and
reuse of the existing account slot; no new maps, dependencies, or network paths.
The existing commit is amended with its author and execution attribution retained;
no merge or deployment is authorized by this follow-up.
