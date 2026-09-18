# ENG-2034 — Francisco provisioning attempt

**BLOCKED — the deployed supported lifecycle rejects the requested Ryan/ENG-1870 account contract. No Francisco account was created.**

Attempt: 2026-09-18T23:44:13.303Z. Execution actor: Codex; accountable owner: Harsha (ENG-2034 assignee). Branch: `defense/ryan-sandbox-bugs-francisco`; inspected head: `7a58a1a32`.

## Authorized contract and precedent

Read the Ryan setup's `INTERNAL/RELEASE_SHEET.md`, `PRODUCTION_QA.md`, `MASTER_SPEC.md`, `ACCESS_AND_REVOCATION.md`, and this branch's `ENG-2022-2029-investigation.md` before execution.

Requested identity: Francisco Rios, `franciscorios.digital@gmail.com`; active Pro, non-admin customer, standalone, no connectors, 100 generations, 30-day expiry, exact frozen materials and simulation. Frozen `EVALUATION_SEED.json` SHA-256: `0e524608cbc46a27e18025b0bd344a256397830798771ece549a1641e48eadcb` (unchanged). No historical creatives/assets were invented.

## Live attempt and exact blocker

Used SSM on the production backend to invoke its deployed `EvaluationStore.provision`, with the existing application runtime credentials loaded only inside the process, as in the Ryan precedent. Generated a random password from 36 cryptographic bytes in process; discarded it after the call. No plaintext password or credential was printed, persisted, or placed in the SSM command. No old password file was read or reused.

1. Strongly consistent `AW-Users` read of the requested email: no Item.
2. Deployed `requireEvaluationAdmin('1743956381327')`: passed. This is the same direct application administrator identifier recorded in the prior branch investigation.
3. Called deployed `EvaluationStore.provision` with the original ENG-1870 input contract: requested email/name, in-memory password, `generationBudget: 100`, `expiresAt: Date.now() + 30 * 86400000`, and the unchanged seed's `materials` and `simulationPacket`.
4. Exact rejection: **`Evaluation access denied`** (`error.name: Error`).
5. Strongly consistent candidate-email readback: no Item. Independent local AWS CLI consistent read also returned no Item.

The rejected application principal is the verified direct administrator `1743956381327`. The local SSM operator is `arn:aws:iam::992382574572:user/harsha-swarm`, already identified by name in the prior investigation. Runtime credential values and runtime principal identifiers are omitted, matching the Ryan evidence convention.

Affected resource/operation: deployed `EvaluationStore.provision` for `franciscorios.digital@gmail.com`; intended persistence is `AW-Users` and `AW-Evaluations` in `us-west-2`. **No AWS authorization denial or denied resource ARN was returned in this attempt.** The earlier `dynamodb:PutItem` denial is historical, not a newly verified result.

Inspection of the actual deployed implementation explains the rejection: the first legacy-incompatible check requires `brandGuidelines.brandName`; subsequent checks require a pinned dataset. The supported implementation hardcodes subscription tier `Sandbox` and a simulated Meta connector with a sentinel token. Its provision record no longer stores the legacy materials, simulation packet, or `remaining` generation budget. Reset now records `resetting-started` and `reset`, rather than the old `simulation:reset`. Adding missing parameters would create a different account contract and would not satisfy this request. No such substitution, legacy code injection, direct record patch, IAM change, or bypass was attempted.

## Verification ledger

| Requirement | Observed result |
| --- | --- |
| Requested email/account readback | Email key `franciscorios.digital@gmail.com` absent before and after; no verified user ID |
| Active Pro, non-admin, standalone login | Not testable: no account or login established |
| Expiry | Not persisted/verified; 30 days was requested only |
| Generations | Not persisted/verified; 100 was requested only |
| No connectors / embedded credentials | No candidate row exists; account-level checks not claimed |
| Seed materials/simulation equality | Local source checksum verified; no stored candidate seed exists to compare |
| Audit only provision + reset | Not achieved; provision rejected before transaction, reset not attempted |
| Production-route boundary denials | Not run as Francisco: no authenticated candidate identity |
| 22-table owner-filtered scans | Not run: no candidate user ID exists; zero-count evidence is not claimed |

No Ryan or unrelated customer records were modified. No email, password reset, schema/migration change, IAM expansion, merge, or PR-state change was performed. No generation was consumed.

## Branch improvements and evidence limits

This branch contains the ENG-2029 production-predicate guard fix, which avoids treating read-only phrases such as “all 4 ads” as produced-asset claims, and the dataset compiler's `Math.ceil(impressions * 0.8)` fix, so one impression yields reach one. These are improvements in branch source, **not verified deployed Francisco behavior**. Existing evidence in `ENG-2022-2029-investigation.md` records paired 148-pass/5-fail baseline versus 153-pass/0-fail changed runs, a successful backend build, and 154 passing boundary/policy/CAPI checks. Those tests were not rerun for this documentation-only attempt. No immutable dataset was recompiled/imported and no Okareo parity run is claimed.

## Harsha action and tracked remainder

**1–2 minute decision:** reply on ENG-2034: “Restore a supported connector-free ENG-1870 provisioning option for Francisco, preserving Pro, 100 generations, the exact frozen seed, and a 30-day expiry.” This is the recommended way to preserve the requested contract. Alternatively, explicitly revise the contract to the current Sandbox-tier/simulated-connector model; that requires a different verification contract and is not authorized by this request. Reconnecting an administrator alone cannot repair this mismatch: the administrator check already passed.

The engineering restoration itself is not a 1–2 minute fix. ENG-2034 tracks the lifecycle incompatibility and all unexecuted account/readback/isolation verification. Emma capability verdict: the current lifecycle exists, but cannot express the requested legacy account shape; the prior access-only diagnosis is incomplete. No additional gap issue is needed.

Complexity impact: one evidence document; no product, infrastructure, dependency, or persistence change. Rollback: revert this documentation commit. Linear's app connector required reauthentication; the existing authorized local Linear API connection was available for outcome reporting.
