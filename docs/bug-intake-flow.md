# Bug Intake & Resolution Flow

> **What this is:** the canonical contract for how a user-reported bug should behave from filing →
> tracking → resolution, across Emma, the in-app UI, Featurebase, and Linear. The **Contract**
> section is the human-written behavioral spec (Harsha, 2026-07-01) — treat it like acceptance
> criteria: make it pass, do **not** rewrite it.
>
> **Last verified against code:** 2026-07-01.
>
> **Design rule:** dedup + canonical grouping live in our code; **priority + assignment business
> rules live in Linear (automations/rules), NOT our application code.**

## Layers
- **Featurebase** — customer-facing surface. Bugs = private per-reporter *tickets* (only the reporter
  sees their own). Feature requests = public votable *posts*.
- **Linear (ENG team)** — engineering source of truth. One **canonical** issue per distinct bug.
  User-filed bugs land directly on the **board (Backlog)** so they're tracked and never lost. Triage
  is reserved for *unvetted external* intake (Featurebase's public board), not our real bug reports.
- **Our backend** (`intakeService`) — the matcher/router: creates the Featurebase ticket, dedups
  against open canonicals, creates-or-groups the Linear canonical, and bridges status back to reporters.

## The contract (human-written — do not modify)

1. **User A files a bug (via Emma or UI).** → A can find *their own* report on Featurebase (stable
   ticket URL). → exactly one Linear canonical is tracked.
2. **User B files a *similar* bug.** → B sees **only their own** Featurebase ticket, never A's. →
   engineering tracks it **non-lossily** under the *same* canonical (B recorded as an additional
   reporter), so eng knows multiple people hit it.
3. **User C files via the UI** (both a different bug and one similar to an existing canonical). → in
   both cases C sees **only their own** ticket; similar ones still group onto the canonical eng-side.
4. **The same user files again via UI.** → *different* bug → they see **two** separate tickets on
   their board. → *similar to their own prior* → they're told **"this looks similar to something you
   already reported."**
5. **A bug changes status.** → every reporter of that canonical gets comms.

### Business rules (enforced on the **Linear** side, not in our code)
- 2 reporters on one canonical → priority **≥ Medium**. 3+ reporters → **≥ High**.
- Customer-reported bugs are **assigned to Harshit** (for now).
- These are Linear automations/rules. **Do not encode them in application code.**

## Ownership matrix

| Behavior | Owner | Mechanism |
|---|---|---|
| Per-reporter private visibility | **Featurebase** | private tickets (reporter-only) |
| Public roadmap for feature requests | **Featurebase** | public votable posts |
| "Same bug?" dedup (similar → one canonical) | **our code** | `dedupService` LLM judge (below) |
| Non-lossy multi-reporter grouping | **our code today** (`[reporter-ticket]` comments) → *recommended:* **Linear Customer Requests** (native count) | see Open Decisions |
| Land user-filed bugs on the **Board** (Backlog), never gated | **our code** | canonical created in Backlog, never Triage — bugs must not be lost |
| Assign to Harshit | **Linear** (native) | Triage Rule "on enter → assignee = Harshit" or Triage Responsibility |
| Priority ≥Med@2 / ≥High@3 | **Linear** (target) | not native on reporter-count; via Customer-Requests count + Triage Automation, or manual triage — see Open Decisions |
| Status-change comms to reporters | **our code** | Linear webhook → resolve bridge |

**Linear capability (verified in Linear docs 2026-07-01):** Triage **Rules/Responsibility** set
assignee + priority *on entry* by property → assignment to Harshit is **fully native, no code**.
There is **no** native rule that watches a running reporter count and escalates priority; the
platform-native path is Linear **Customer Requests** (counts reporters natively) + a Triage Automation
(Business/Enterprise) or manual triage sorted by request count.

## Current implementation (verified against code 2026-07-01)

**Works today:**
- **Scenarios 1–3 largely satisfied.** Emma (`emma/tools.ts` `report_product_issues`) and UI
  (`POST /api/support/report-ui-bug`) share the **same** `intakeService.fileUserIssue()` pipeline. A
  bug → private Featurebase ticket (`featurebaseService.createTicket`, reporter-only) + **one** Linear
  canonical (`createInternalLinearIssue`, labels `Bug`+`Customer Reported`, no `Featurebase` label =
  private). Additional reporters recorded as `[reporter-ticket #N email]` comments on the canonical.
- **Dedup is an LLM judge** (`dedupService.ts`): Claude compares the new filing against ≤30 open
  candidates, 75% confidence threshold **biased toward NEW** (a false merge is worse than a missed
  one), 12s timeout, **fails open** (null → treat as new). Good design — keep it.
- **Resolve bridge** (`intakeService.ts` `notifyCanonicalResolved`, via `routes/integrations.ts`
  Linear webhook): on canonical → **completed**, emails each reporter (Resend) and flips their
  Featurebase ticket to Completed.

**Gaps vs the contract:**
- **G1 — "similar" hint (scenarios 2 & 4):** dedup is **silent to the user**. UI says "already a known
  request" but gives no link; Emma says nothing. No "you already reported something similar on <date>".
- **G2 — business rules absent:** **zero** priority-escalation or assignment code (confirmed by grep).
  Not yet built on the Linear side either.
- **G3 — status comms only on `completed`:** `accepted` / `in-progress` / `declined` are silent to
  reporters. Contract wants comms on status *changes*.
- **G4 — no aggregated "My Issues" view:** users get a stable per-ticket URL but no dashboard listing
  their reports. (Featurebase may provide a portal — verify.)

## Decisions (2026-07-01 — "value without adding complexity/spaghetti to our code")
- **CORRECTION (2026-07-01):** user-filed bugs go on the **board (Backlog)**, NOT Triage — Triage
  risks real bugs being lost if the inbox isn't cleared. Triage is only for unvetted *external*
  intake (Featurebase public board). The flood was solved by *dropping* telemetry issue-creation,
  not by gating.
- **DO — ENG-6:** user-filed bugs + auto-issues land on the **Board (Backlog)** (not Triage); drop
  telemetry-noise sources from issue creation; delete the Notion `createOncallItem` fallback. Pure subtraction.
- **DO — assign to Harshit:** Linear-native — set **Triage Responsibility → Harshit** (one setting).
  No code.
- **DO — priority floor (2→≥Med, 3→≥High) as a *guideline*, applied by whoever grooms the board.**
  Reporter count is already visible in the canonical's `[reporter-ticket]` comments.
  **No code, no automation** — Linear can't set priority from a running reporter count natively, and
  the only automatic options both add cost (a business-rule line in our code, or the Customer-Requests
  migration). Not worth it at current volume.
- **DEFER — G1 similar-bug hint:** Featurebase already surfaces this natively for feature requests
  (public merged/votable posts); private bugs are intentionally not cross-visible. No bespoke code.
- **DEFER — G3 multi-status comms:** keep the existing `completed` → resolved email (the one that
  matters). Per-status emails (accepted/in-progress/declined) add branches + templates for marginal
  value — revisit only if users are demonstrably left hanging.
- **DEFER — G4 "My Issues" view:** rely on Featurebase's customer portal; don't build our own.
- **DEFER — Customer-Requests migration:** the comment approach works and isn't spaghetti; migrating
  is lateral churn. Revisit only if we need native reporter-count automation.

## Key files
- `backend/src/services/intakeService.ts` — file / dedup / group + resolve bridge
- `backend/src/services/dedupService.ts` — LLM dedup judge
- `backend/src/services/featurebaseService.ts` — tickets (private) + posts (public)
- `backend/src/services/linearService.ts` — canonical create, team/state/label resolution
- `backend/src/routes/integrations.ts` — Linear webhook (status → resolve bridge)
- `backend/src/routes/support.ts` — UI bug report endpoint (`REPORT_TYPES`)
- `backend/src/emma/tools.ts` — Emma `report_product_issues`
