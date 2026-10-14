## ENG-2135: Agent golden set gets an unbiased sampled_session source (2026-10-14)

### Problem
`seedAgent` built cases from replay fixtures, `admin_override` sessions (10) and the false-positive
catalogue (38). All 10 admin_override sessions are already in `AW-EvalGoldenCases`, so no
`--target-agent` value could add cases: the agent surface sat at 50 (29 test / 21 dev). Validation
needs n >= MIN_VALIDATION_N (30) human-labelled cases on the test split, and the split is a hash of the
case id fixed at creation, so agent could never validate as seeded. All three sources are also
failure-biased, a poor base for judge agreement on ordinary traffic.

### What changed
A fourth source, `taskType` / `seedSource` = `sampled_session`. A session qualifies when it was created
within 90 days of `now`, has `messageCount >= 4`, has `sessionType` regular (or absent on legacy rows),
and its `userId` is not an evaluation user (`isEvaluationUser`, `eval_` prefix). Sessions already in
another agent source keep that source. Candidates are ordered by a salted hash of the case id, never by
recency or score, so re-runs pick the same sessions and a larger target only appends. Sampled cases are
not pinned: they fill after pinned and `fp_catalogue` cases, so the default target (50) adds nothing while
the existing store already holds 50 pinned + catalogue cases. The loader now also projects `userId`,
`createdAt`, `sessionType`, `messageCount` (no message bodies). `bySource` and the dry-run line count it.

### Use
Dry run first (reads only, writes nothing): `--target-agent 70` adds up to 20 sampled sessions on top of
the existing 50. `store.createCase` is conditional on `attribute_not_exists(caseId)`, so `--write` never
overwrites and is idempotent. The write is additive but still data-plane work: needs Harsha's approval.
Human labelling workload grows by the number of new cases (about 60% land in test, so 20 new cases is
roughly 12 test labels; reaching 30 test labels from 29 needs only a few, 70 gives margin).

### Limits
Sessions with no `messageCount` (written before the counter) are never sampled. Evaluation sessions are
identified only by the `eval_` userId prefix; other internal/QA accounts cannot be told apart from cheap
attributes and are not excluded.
