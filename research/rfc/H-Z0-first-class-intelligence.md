# RFC-H-Z0 — first-class z0intelligence for Emma

**Status:** downstream lab · **Issue:** #48 · **Upstream promotion:** forbidden until the study gate passes

## Goal

Use z0intelligence as an optional routing, verification and receipt authority beneath Emma while AgentWeb keeps ownership of user identity, confirmation, evaluation-workspace, scheduled-run, funding and publish safety.

## Modes

| mode | z0 endpoint | physical execution |
|---|---|---|
| off | none | no |
| shadow | /v1/plan | no |
| active | /v1/intelligence | possible, subject to z0 policy |

The default is `off`. There is no automatic shadow-to-active promotion.

## Identity and retry contract

AgentWeb hashes its session id before crossing the boundary. Raw AgentWeb user ids are never sent. A caller supplies a stable `operation_id`; the adapter deterministically derives the z0 trace id from pseudonymous session + operation. Function/task/context changes under that operation therefore collide with the same authority identity and are rejected by z0's request fingerprint.

Active transport ambiguity is not retry permission. The same operation and same request must be reconciled with the same trace. A changed request under the same identity is expected to fail z0's fingerprint check.

## Data boundary

`allow_remote=false` by default. Prompt text cannot enable remote transmission. Generic workers always request `free_only=true`.

ReliabilityEvent projection drops `userId` and free-form `errorSummary`. It is observational and partial. Tool success never becomes `verified_success`.

## Experiment matrix

1. mode-off makes zero z0 calls
2. shadow route makes zero physical calls
3. active PARENT_ONLY makes zero specialist calls
4. active specialist success produces canonical receipt
5. identical active request replays
6. trace reuse with changed request is rejected
7. active timeout stays unknown and requires reconciliation
8. 503 / transport failure fails open to Emma
9. malformed response fails open
10. remote context is denied by default
11. explicit remote authorization is preserved
12. free-only blocks unvalidated paid workers
13. raw user id never crosses boundary
14. raw session id never crosses boundary
15. ReliabilityEvent error text is not exported
16. tool success does not mint quality gold
17. pending confirmation does not become completion
18. user refusal does not become success
19. current direct JEV and z0 JEV are compared on the frozen eligible slice
20. unavailable JEV returns to the incumbent path
21. evaluation-workspace tool guards remain authoritative
22. scheduled publish consent remains authoritative
23. funding attribution remains unchanged
24. context packet must-keep facts survive compression
25. bounded packet reduces context on replay
26. risky/fresh-context routes abstain
27. routing agreement is measured, not assumed
28. latency overhead is measured at p50/p95
29. token economics use equal-cache comparisons
30. replay remains deterministic across config changes
31. service restart does not re-execute an uncertain claim
32. parallel duplicate operations converge on one authority claim

## Promotion gate

Freeze exact AgentWeb, z0intelligence and z0evals SHAs. Require safety invariants to pass, JEV parity on the eligible slice, and at least one representative workload with measurable latency/token benefit and no quality regression before proposing anything upstream.


## Paired report_type_v1 replay

The first measured domain seam is report classification. Gemini remains authoritative;
the z0 lane performs one shadow Jev Choice call behind z0 dispatch authority and emits
a canonical receipt with `applied=false`.

Run against the frozen z0evals corpus:

```bash
cd backend
Z0INT_AGENTWEB_MODE=shadow \
Z0INT_REPORT_CLASSIFY_ALLOW_REMOTE=1 \
npm run study:z0-report-type -- \
  /path/to/z0evals/studies/agentweb-emma-z0-v0/report-type-fixtures.jsonl \
  /tmp/agentweb-report-type-results.jsonl
```

The z0 service separately requires `Z0INT_EXPERIMENTAL_JEV_SHADOW=1`; that flag is
kept on the authority side so AgentWeb cannot unilaterally authorize the paid shadow
lane. Score results with `z0evals/scripts/score_agentweb_report_type.py`.

A 30-case authored corpus is only a design/regression set. The scorer refuses
promotion review until at least 1,000 paired live decisions exist and all quality,
coverage, receipt, non-application, and latency gates pass.
