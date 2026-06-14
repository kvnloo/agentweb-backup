# Durable Execution for Long-Running Agent Tools (RC1) — Spec

**Status:** DRAFT for review. Acceptance criteria below are AGENT-DRAFTED and must be ratified/edited by Harsha before implementation (per `~/.claude/rules/loop-acceptance-tests.md` — the agent must not author the contract it later satisfies).
**Author:** investigation 2026-06-12 (see `dev.md` "Landing-Page Generation Failures — Empathia Incident Root-Cause").
**Owner:** Harsha (Agent-Mode experiment, per Jun 9 deal with Rui). Touches agent infra — coordinate with Rui before scaffolding.

## 1. Problem

Long-running agent tools (`generate_landing_page`, `coding_agent`) run synchronously inside the agent-mode response loop. The run has a 600s timeout (`agentModeController.ts:55`); the tool itself runs up to 25 min (`apiTools.ts:1301`). When the run times out:

1. `withGenerationTimeout` loses a `Promise.race`, the user gets **"Your request took longer than expected"** (`agentModeService.ts:3319`), and the session lock is released.
2. The generation is **not cancelled** — it keeps running detached and completes, updating `AW-LandingPages` to `deployed`. Nobody reconnects to it. (Comment: `agentModeController.ts:50-53`.)
3. Because the lock was released, a user retry (Angela did this twice on Jun 8) starts a **second** generation racing the first — on the single-repo-per-user model (RC2) this corrupts the repo and blocks all builds.

Net effect for the customer: a build that actually succeeded is reported as a failure; manual retries make it worse. This is the dominant reliability complaint and it bit an in-evaluation prospect (Empathia, decision ~Jun 17–18).

## 2. Goals / Non-goals

**Goals**
- A long-running tool never reports a false failure when the work is still in progress or already succeeded.
- When detached work completes, its result is delivered into the originating session and the user is notified live.
- A retry while work is in flight **reconnects** to the in-flight job instead of starting a competing one.

**Non-goals (explicitly deferred)**
- A separate scalable "agent engine" service (Rui's long-term direction). This spec is the bridge, not the replacement.
- Surviving a backend **redeploy** mid-build for the in-process path. Covered only partially by the §5 backstop; full durability is the engine's job.
- Telemetry/observability — that is the spine, already in flight, orthogonal.

## 3. Design — "reconnect to detached work," not "build a queue"

The work already detaches and finishes. We add three thin layers around that existing behavior.

### Layer A — Truthful in-progress state (replaces the lie)
On run timeout, if a long-running tool is still in flight for the session, return a **"still building, I'll post the link here when it's done"** assistant message instead of the failure string. Requires marking, at tool-invocation time, that a durable job is owned by this `sessionId`.

- Job marker: reuse the existing `AW-LandingPages` record (it already carries `status: generating|deploying|deployed`) plus a new `originatingSessionId` field. No new table for the landing-page case.
- Generalized marker (for `coding_agent` etc. that have no natural record): a small `AW-AgentJobs` record `{ jobId, sessionId, userId, tool, status, claimedCompletionAt?, createdAt }`. Optional — only if we generalize beyond landing pages in phase 1.

### Layer B — Completion post-back
When the detached generation finishes (it already writes `deployed`), fire a completion hook that:
1. Appends an assistant message to the session via `addMessagesToSession` (EXISTS — used by scheduled chats).
2. Emits `io.to('user:${userId}').emit('session-message-appended', { sessionId, message })` (EXISTS — same pattern as `gtmPlan.ts:1499` `gtm-session-ready`).
3. Sets an idempotency guard (`claimedCompletionAt`) so the poller (Layer C) and the in-process hook can't double-deliver.

Frontend: handle `session-message-appended`; if the session is open, append the message; otherwise surface an unread indicator.

### Layer C — Durability backstop (the redeploy case)
A `dripSequenceWorker`-style poller (`setInterval` in-process, DynamoDB-backed state — EXISTS as a template, `server.ts:502`) scans for jobs where `status=generating` AND `createdAt` older than a threshold AND no `claimedCompletionAt`:
- If the underlying record has since reached `deployed` → run the Layer B post-back (recovers a completion the in-process hook missed, e.g. because of a redeploy).
- If still `generating` past a hard ceiling (e.g. 30 min) → mark `failed`, post a truthful failure message into the session.

This is the only genuinely new persistent-state machinery, and it is small (one poller, one status scan).

### Coordination with the lock + retry (fixes the poisoned-repo race)
At generation entry, before starting a new build, check for an in-flight job owned by the session/user. If found, **reconnect** (return the Layer A message) instead of starting a second build. This closes the Jun 8 double-build race and is a prerequisite, not an add-on.

## 4. Complexity assessment (explicit vs hidden)

| Piece | Exists? | Complexity | Notes |
|---|---|---|---|
| Live push from worker → frontend | ✅ `io.to('user:…')` | none | `gtmPlan.ts:1499` does exactly this |
| Append message to a session | ✅ `addMessagesToSession` | none | used by scheduled chats |
| Work keeps running after run ends | ✅ (currently the bug) | none | we reconnect instead of building detachment |
| Durable job *state* template | ✅ dripSequenceWorker + DynamoDB | low | copy the pattern |
| Truthful "still building" message | ❌ | low | branch in the timeout path |
| Completion hook + idempotency guard | ❌ | **medium** | the real new logic; double-delivery is the trap |
| Retry-reconnects-to-in-flight | ❌ | **medium** | also fixes RC2 race; needs lock coordination |
| Backstop poller (redeploy recovery) | ❌ | medium | bounded; one scan loop |
| Frontend renders appended message | ❌ | low | one socket handler |

**Verdict on "complexity vs lack of complexity":** the notification and session-append primitives genuinely exist and are used elsewhere, so the *delivery* path is low-complexity — this is not hand-waving. The real, **explicit** complexity is concentrated in two places: the completion hook's idempotency (so the in-process hook and the poller never double-post) and the retry-reconnect lock coordination. Both are bounded and testable.

**Hidden complexity (Rui's "hidden vs explicit" point — stated honestly):** the detached work runs in the same Node process, so the lightweight design fixes the *run-timeout* case (the common one, ~90% — what hit Empathia) but **not** a *redeploy* landing mid-build. Layer C recovers a build that finished before the crash; it cannot resurrect one killed mid-flight. That residual is exactly the case Rui's separate engine solves cleanly. So this spec does **not** make the engine unnecessary — it removes the customer-facing pain now and de-risks the engine decision with real post-back UX in production. Do not oversell it as "durability solved."

## 5. Draft acceptance criteria (HUMAN to ratify — do not implement as-is)

Behavioral assertions; a different implementation should be able to satisfy them.

1. A `generate_landing_page` that exceeds the 600s run timeout but later succeeds results in (a) NO failure message, (b) a "still building" message at timeout, (c) a completion message containing the live URL appended to the **same** session, delivered live via socket without a reload.
2. Triggering a second generation for a user/session that already has an in-flight job does **not** start a second build; it returns the in-flight status. (Verify only one GitHub build/Vercel deploy occurs.)
3. The completion message is delivered **exactly once** even when both the in-process hook and the backstop poller observe completion (idempotency).
4. If the underlying generation reaches `deployed` while the originating run is already dead, the backstop poller delivers the completion within one poll interval.
5. A job stuck at `generating` past the hard ceiling produces a truthful **failure** message in the session, not silence and not a false success.
6. (Honest-limit assertion) A backend redeploy that kills an in-flight build leaves the job recoverable-or-failed within one poll interval — never permanently `generating` with no message. (This is the partial-durability guarantee; full mid-build survival is out of scope.)

## 6. Rollout

- Behind a flag (`DURABLE_LANDING_GENERATION`), `generate_landing_page` only, in `agentModeService`/`agentModeController`. Other tool paths untouched.
- A/B as "V2" per the Jun 9 framing; revert = flip the flag.
- Pre-req for confident merge: an Ocario benchmark case for landing-page generation (currently unscheduled — book it).

## 7. Test plan (per CLAUDE.md TDD)

Backend, fail-first: timeout-then-success path, double-trigger reconnect, double-delivery idempotency, poller recovery, stuck-job failure, redeploy-recovery (simulate process restart by re-running the poller against a `generating` record that is now `deployed`). Frontend: socket handler appends to open session; unread indicator when closed. ≥95% coverage per CI rule.
