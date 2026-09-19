# Ryan fixes and Francisco evidence — 2026-09-19

User requested PR #2963 completed **without merge or email**. Accountable owner: Harsha (Linear assignee); execution actor: Codex; commit identity: deploy@agentweb.pro. Backend branch defense/ryan-sandbox-bugs-francisco; portal companion defense/ryan-francisco-portal. No Ryan records, unrelated account records, IAM policies, schemas or migrations changed.

## Root causes and acceptance

| Issue | Root cause and verified behavior |
| --- | --- |
| ENG-2022 | The original trailing 90d contains only 30d delivered observations. New pin preserves all 44 actual rows' spend/impressions/clicks/actions, adds older 65%/45% synthetic cohorts, and discloses exactly **30d real + 60d synthetic** in account name, sandbox header, brand context and candidate packet. Original pin untouched. |
| ENG-2023 | Compiler deliberately supplied a 1×1 placeholder for withheld originals. New pin supplies an explicit 960×540 unavailable card, including AD_15. Cleared originals preserved. Missing historical art cannot honestly be reconstructed; no invented winner is represented as real. |
| ENG-2024 | Flooring modeled reach gave one impression zero reach. Integer-ceiling reach preserves AD_17: one impression, one click, reach one, frequency one, $0.02. Single-impression rows are not replayed into older history. |
| ENG-2025 | Fixed 80% daily reach plus additive aggregation forced static frequency. Disclosed modeled daily audiences and window overlap now derive frequency per window; breakdown allocation preserves parent totals and filter invariance. Reach remains synthetic, not recovered Meta unique reach. |
| ENG-2026 | Hardcoded ACTIVE plus configured-only route output hid delivery restrictions. Compiler preserves effective status; explicitly PAUSED exercise campaigns 01/02; route returns effective status plus configuredStatus; child statuses inherit resolved parent restrictions without losing their own restrictions. Zero delivery alone never infers an actual restriction. |
| ENG-2027 | Seeded name/legacy completion flags falsely passed onboarding. Portal requires a meaningful typed brand brief from Brand Hub and an explicit review flag; stale flags, malformed fields and account-switch races cannot complete it. |
| ENG-2028 | A stale name-based Opus deny contradicted ENG-744’s human-written public availability contract, while session creation ignored failed PATCH. Authenticated/shared PATCH and model-mention guidance now use registry flags; public Opus 4.8/5 remain offered, admin-only/internal/live restrictions remain enforced; portal handles 403/500/transport failures, retains prompt/attachments, restores confirmed model, avoids generation/navigation and retires or retries cleanup of empty sessions. |
| ENG-2029 | Numeric read-only analysis was interpreted as an asset-production claim. Attached production predicate required; genuine underproduction still detected. |

## Verification

- TDD baseline at f9f07005e: same seven focused backend suites, 13 failed / 139 passed before final extra review regressions. Earlier compiler RED: 3 failed / 16 passed. Final changed run: **158 passed / eight suites**, production TypeScript build passed. Boundary/lifecycle/tool/CAPI safety run: **163 passed / five suites**.
- Portal baseline b3d12af2: 3 failed / 13 passed in the paired prompt/checklist tests. Changed focused run: **45 passed / four suites**; production Vite build passed.
- Browser drives the real portal with intercepted network responses: empty seeded brand shows 0/5, exact disclosure visible; picker switch → POST session → PATCH 403 → DELETE empty session; prompt remains in composer and user bubble, confirmed Flash model restored, no generate request, no page errors. Browser mocks are not a live production portal claim. Screenshots and trace summary attached.
- Local CodeRabbit backend final review: zero findings; four first-round findings fixed (insight identity validation, parent restriction cascade, breakdown reach consistency, restriction preservation). Portal findings about stale account state, cleanup failure and raw transport error text fixed and covered; final review/CI recorded in PR evidence.
- Okareo paired six-scenario **classification of the actual guard**, not a multi-turn LLM simulation: baseline c3ae04a4-fb23-4d58-83b9-6f1748ced226 = 4/6; changed 79527ff6-8afd-4279-9f2c-8f7be7687510 = 6/6. Both FINISHED. Read-only false positives removed, real production claims preserved. JSON results included; the real generateMarketingResponse characterization harness also passes. This does not establish general model-quality parity.

## Live Francisco account

Current deployed `EvaluationStore.provision` and `reset` used with supported dataset import; no legacy Pro contract or direct record patch. Application runtime authorization used through existing SSM, no IAM expansion. Emma capability verdict: supported lifecycle exists, but provision required an authorized application admin runtime; the connected Emma identity was not sufficient. ENG-2034 retains that access-gap history.

- Email: franciscorios.digital@gmail.com; userId: **eval_00e1b770-feb0-45cc-8c21-ffc9f2d05bc7**.
- Active Sandbox; customer role; non-admin; standalone. Real password login 200 and auth/me 200. Random password generated, used and discarded only in remote process memory. No plaintext password/token retained. Candidate uses Forgot password; no reset email sent in this run. Subsequent checks used an in-memory short-lived application JWT, separate from the actual password-login proof.
- Provisioned **2026-09-19T19:31:02.876Z**; expires **2026-10-19T19:31:02.876Z** (1792438262876), exactly 30 days.
- Current supported allowance: **100,000,000 tokens/month**, $500 model-cost accounting allowance, $100 extra-API allowance. Runtime costEnforced=false; actual gate is token usage. No fixed generation counter exists; do not claim 100 guaranteed generations. After the real Emma smoke: 377,328 tokens used; **99,622,672 remaining**; cost $0.094806375; allowed=true. Reset did not refund usage. No tier change or extra top-up needed.
- Pin: **agentweb-evaluation-90d@1**, canonical SHA-256 **1d388a21ee9daddcfa7047866a89dceb6d2512b6c53a1679bb9854cdf97dda4b**. One simulated Meta connector with sentinel only, no real credentials. Overlay diff count zero after reset.

| Live window | Spend | Impressions | Clicks | Reported leads |
| --- | ---: | ---: | ---: | ---: |
| 7d | $208.00 | 3,536 | 128 | 1 |
| 14d | $524.14 | 7,173 | 262 | 4 |
| 30d | $1,030.24 | 12,992 | 493 | 20 |
| 90d | $2,163.24 | 27,279 | 1,032 | 42 |

Corrected live lead readback uses totalLeads; the first QA script mistakenly read a nonexistent leads field and printed zeros. It was corrected and rerun; those first zeros are not accepted evidence. AD_15 image HTTP 200, 960×540, sha e927de971cf016b3297d3f32cbbb6cfd57073a5f56aadd63156559b33ca24347. AD_17 invariant passed. Current live frequency varies with the new dataset; window-overlap algorithm and portal fixes remain unmerged code, not deployed claims.

HTTP 403 verified for connector connect, billing checkout, admin evaluations and session sharing. Deployed policy guard denied send_email, publish_landing_page, deploy_landing_page, connect_account, call_google_ads_api before dispatch. No real send/publish/spend was attempted. Real Emma generate HTTP 200 (Gemini 3.8 Flash) explained the exact history split and limits without a false write-verification footer. Session 71e70cc2-2878-4a38-9d19-8162e8bb7529 was then removed by supported reset.

Reset removed only Francisco's QA session (15 messages, one S3 object). Strongly consistent paginated owner-filtered scans of **23 existing tables returned zero**; AW-AgentRuns is absent, explicitly reported rather than claimed scanned. Initial scan harness stopped on that absent table, then corrected and rerun to completion. Exact table/page counts are in sanitized-readbacks.json. Audit: provision=1, meta=84 (all GET), resetting-started=1, reset=1; auth/me still 200 after reset. This is expected audit activity, not a claim of only two entries.

SSM evidence: import 436a538c-8356-40ba-9f89-a4e93a470afe; provision 7552af97-c8dd-4a3d-a307-cda7450829a9; final verification/reset c0f81a3b-e305-43b8-ae34-dd4f428e8b17. No secrets in attached readbacks.

## Packet, risk and rollback

Candidate packet: /home/harsha/francisco-takehome-setup/CANDIDATE_PACKET. START_HERE, DATA_CONTEXT, EXERCISE_DATA.csv, SUBMISSION_CHECKLIST plus byte-identical source archive and checksums. Explicitly labels older synthetic history, modeled audience/status/breakdowns, withheld creatives, no real connector, no send/publish/spend and no approved future budget. Draft external copy remains unsent for Harsha's review.

Complexity: no new service, dependency, schema, IAM or legacy lifecycle path. One opt-in dataset compiler history mode, one shared unavailable asset, one reach reducer, existing registry flags made authoritative, two portal failure/completion paths corrected. Added frozen dataset and focused regressions. Roll back code with revert; existing dataset pins unaffected. Francisco can be revoked/reset through existing supported admin lifecycle; do not delete or mutate Ryan. Post-merge plan (not executed, user forbids merge): observe both deployments, repeat read-only UI/metrics smoke and a fresh isolated prompt-denial browser test; do not rerun provisioning.

## Final contract reconciliation / ENG-2028

The broader pre-push suite exposed an incorrect first approach: hiding all Opus models would preserve the controller’s stale family-name deny but violate **ENG-744’s HUMAN-WRITTEN AC1/AC3**, which explicitly require public Opus 5 and actual invocation after selection. Read ENG-744 and ENG-892/1205 from Linear; neither later issue authorizes removing that availability. Restored catalog behavior (including unchanged public Live listing), removed the stale name check from isModelSelectableBy, and used that registry predicate in both authenticated and shared PATCH. This enforces the existing intended permissions, not a new model-access policy. Generic denied-model error names no longer incorrectly say every denial is an Opus denial.

Controller TDD: **9 failed / 7 passed** before the fix. Final targeted model/controller/registry/acknowledgement suites: **274 passed / four suites**. Negatives cover admin-only/internal/live IDs, wrong-type values on both siblings, cross-owner access, invalid/expired sharing token; positives cover public Opus and canonical aliases. Existing ENG-744 public availability tests pass unchanged. One stale model-mention test now expects picker guidance for public Opus; a separate actually admin-only Opus4.6 test preserves the denial assertion. No live provider routing, pricing, default or voice behavior is changed.

First broad pre-push typecheck was killed by the shared 4GiB process group while checks overlapped; serial retry passed in 73s. No killed run is counted as passing. A full portal attempt exposed the unstable auth-object dependency in brand verification; it was corrected to stable account fields and regression-tested, then the old workers were stopped. Final exact-head GitHub suite is the full-suite proof. Local portal build, type/lint, bundle and 45 focused tests pass. Temporary dataset transport object was deleted after import; canonical pin remains available.

## Remaining PR-stage guard findings closed

Inspected the full old CodeRabbit PR review, including its non-inline warning. Comment 4051471649 correctly identified missed “rendered successfully” suffixes; its complexity warning correctly identified unbounded prefix/suffix splitting per claim. Both were still present despite the earlier clean local review, so neither was dismissed.

Added three suffix regressions: **3 failed / 84 passed** before change. Matcher now accepts success adverbs before or after the verb. Predicate context is bounded to 160 preceding / 256 following characters with sentinels to avoid artificial boundaries; no full-prefix/suffix rescanning. A one-million-character read-only analysis regression with 20,000 matching counts completes within the 2s guard budget. Final guard + real-loop/kill-switch/ledger/session-summary checks: **141 passed / five suites**.

Repeated paired Okareo guard classification with nine scenarios, including suffix forms: baseline **5e8d5de1-8f21-46a6-9c11-c1e3adaaafc0**, accuracy 0.777778 (7/9); changed **3ad1dc70-480a-498e-8a2a-086134949545**, accuracy 1.0 (9/9), both FINISHED. Final JSON/scenarios are separate from the earlier six-scenario artifacts. This remains a bounded actual-guard evaluation, not a general multi-turn LLM simulation.

At fd2721fe6cd4c7e9765371a255425d529e6c6138 the full typecheck passed in 65s and the exact pre-push selected set completed separately with two workers: **306 suites / 5,717 tests passed**, exit 0 (166.615s). The hook selected eight workers under a 4 GiB cap and was interrupted while swapping; it is not counted as passing. The push used the supported hook-skip switch only after these identical checks completed. Final suffix change is separately covered by the 141 checks above; final build/CI and commit evidence are recorded on the PR and local release sheet.

Portal final review follow-up: dfccda2e4032f83e3b0c661e8575a2db059ffa20 cancels both stale progress and detection results on account switch. RED 1 fail / 15 pass; changed 46 focused tests pass. Final local CodeRabbit: zero findings. Production build, changed-line type/lint and bundle budget pass at that portal head.
