# Ryan sandbox investigation — 2026-09-17

This is a **partial implementation, blocked before deployment**, not evidence that
all eight reports are fixed. Linear report text was read without modification.

## Findings and scope

| Issue | Finding | This change / remaining work |
| --- | --- | --- |
| ENG-2022 | The frozen source has two bursts separated by a verified inactive gap. Both trailing 30d and 90d contain the same 44 observations. The route subtracts 89 days for 90d correctly. | Preserve measured history; resolve how the evaluation should disclose coverage before changing product copy or choosing a synthetic case. |
| ENG-2023 | The compiler deliberately maps withheld creatives to a shared 1×1 gray PNG. Source assets for those ads are not supplied. | Await source-truth versus explicitly synthetic fixture direction; do not present invented assets as the historical winners. |
| ENG-2024 | Flooring 80% of one impression produces zero simulated reach. | Compiler rounds upward; regression verifies one impression has reach one. Immutable deployed dataset v1 is unchanged; a new compiled/imported version remains necessary. |
| ENG-2025 | Reach is synthesized as 80% of impressions and then summed. This mechanically yields approximately 1.25 frequency. Source explicitly does not export unique reach/frequency. | Requires source-truth versus synthetic-metrics decision; a different arbitrary ratio would conceal the limitation. |
| ENG-2026 | Compiler hardcodes configured and effective status ACTIVE. Packet settings are current snapshots and lack evidence for historical delivery status. | Do not infer PAUSED, rejected, or budget restrictions merely from zero spend. Effective-status source/case and portal presentation remain unresolved. |
| ENG-2027 | Lifecycle seeds brand name/tagline/domain but empty voice, audience, personality, messages, and values. | Checklist behavior lives in the separate portal repository; matching isolated portal branch requested. |
| ENG-2028 | PATCH explicitly rejects non-admin Opus; isModelSelectableBy has the same restriction, while getSupportedModels omits that name-based restriction. | Keep permission policy intact; portal error/draft retention and catalog consistency remain unimplemented pending portal branch scope. |
| ENG-2029 | Numeric phrases such as “all 4 ads” are interpreted as produced-asset claims without a production predicate. | Require an attached production predicate. Read-only analysis no longer triggers the footer; genuine underproduction checks still pass. |

## Source reconciliation

The source manifest is verified by the existing compiler; frozen inputs were not edited.

| Trailing window ending at frozen last day | Daily rows | Spend | Impressions |
| --- | ---: | ---: | ---: |
| 7d | 10 | $208.00 | 3,536 |
| 14d | 22 | $524.14 | 7,173 |
| 30d | 44 | $1,030.24 | 12,992 |
| 90d | 44 | $1,030.24 | 12,992 |
| 129d | 134 | $2,055.32 | 22,005 |

## Paired focused verification

Base: `8894ca5b946d4b9b0400e604093ca27ac5070261`.
Same test files and inputs, original implementation versus changed implementation:

- Original: 148 passed, 5 failed.
- Changed: 153 passed, 0 failed, six suites.
- Four expected differences cover read-only completion claims (three pure tests,
  one real `generateMarketingResponse` characterization-harness test).
- One expected difference covers the one-impression compiler invariant.
- Existing guard, ledger, kill-switch, and session-summary behavior remains covered.
- Dependencies installed from this branch's lockfile on Atem. The first attempt
  using a shared dependency directory failed due to mismatched Axios types and
  missing sanitize-html; that environment was replaced, not patched into source.
- `npm run build` in `backend`: passed with the clean lockfile installation.
- Evaluation boundary, tool-policy, and sandbox CAPI safety suites: 154/154 passed.
  These are fixture-based safety checks, not live Francisco account verification.

Command: `node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js
--runInBand --forceExit --runTestsByPath` with these paths:

- `backend/src/__tests__/sandbox/datasetCompiler.test.ts`
- `backend/src/__tests__/agentMode/synthesisResidueGuard.test.ts`
- `backend/src/__tests__/agentMode/synthesisResidueLedger.test.ts`
- `backend/src/__tests__/agentMode/synthesisResidueKillSwitch.test.ts`
- `backend/src/services/agentMode/core/__tests__/synthesisResidue.test.ts`
- `backend/src/__tests__/sessionSummary.test.ts`

Okareo SDK resolves baseline target `emma-prod-anthropic.claude-opus-4-8`, ID
`a341ba00-dbfc-4a76-bac7-d5331e7491b8`. **No paired Okareo simulation was run**:
there is no provisioned isolated account/changed-build target. Target lookup is
not evaluator evidence. Merge remains blocked on the required simulation.

## Francisco provisioning

- Requested identity: `eval-francisco-rios-44944cb3@example.invalid`.
- Requested dataset: `agentweb-2026q2@1`; display name: Francisco Rios Evaluation.
- Direct active admin verified: `1743956381327`.
- Existing CLI lifecycle denied: AWS principal `harsha-swarm` lacks
  `dynamodb:PutItem` on `AW-Evaluations`.
- Existing Emma `evaluation_workspace` provision denied: `Evaluation access denied`.
- Account readback returned no Item. **No evaluation user ID exists**, and login,
  seeded-data, Emma-access, and denied-action checks cannot be claimed.
- No email, schema change, IAM expansion, or bypass was performed. Password input
  remains in a private mode-0600 file outside the repository.
- Access blocker and remaining provisioning verification: ENG-2034.
- Emma verdict: lifecycle capability exists; current connected identity lacks access.

## Rollback and complexity

Revert this commit to restore the old guard/compiler. No persisted dataset, account,
table, or schema changed. Existing `AGENT_FALSE_CLAIM_GUARD=false` can disable the
correction guard in an emergency, but also disables its genuine underproduction
protection. Production smoke after an eventual approved deployment must replay a
read-only ad analysis and a genuine underproduction claim on a safe sandbox.

Complexity: one rounding change and a bounded predicate check inside the existing
guard; no new service, dependency, storage, configuration, or fallback path.

Local CodeRabbit review reported one minor finding: a success adverb could bypass the production predicate. Fixed with a focused regression (“All 12 sizes were successfully rendered”). The paired results above include that test.
