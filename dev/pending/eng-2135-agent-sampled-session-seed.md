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

**Gated creative candidates (ENG-2226).** `--gated-creatives` (opt-in, off by default) adds `gated_candidate` creative cases: image candidates in `AW-HumanEvalQueue` that carry an evaluated creative-gate result (`creativeGates` present and not `notChecked`). Every reviewer-feedback creative case predates the gates (earliest gated candidate 2026-09-25), so the gates adapter abstains on all of them; labelling `format_readiness` on those is wasted effort. Reviewed candidates keep priority and a larger `--target-creative` only appends.

**Target semantics, a foot-gun worth stating.** `--target-<surface>` is the size of the *selection*, not the number of additions, and `createCase` never overwrites. For agent the pinned and catalogue cases (10 admin-override + 2 replay + 38 catalogue = 50) come first, so with `--fp-catalogue` the sampled additions are `target - 50`; without the catalogue file only the 10 admin-override cases are pinned, so the same 20 additions need `--target-agent 30`. Read `bySource` in the dry run and aim for about 20 new `sampled_session` cases (about 12 land in the test split), then diff against the store before any `--write`.
