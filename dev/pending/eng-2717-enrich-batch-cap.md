## ENG-2717: Enforce Extra Usage cap per enrich-v3 batch (2026-10-28)

- Reuse `checkTokenUsage` / `resolveLlmUsagePoolDecision` for read-only projected-cost admission, so allowance, credits, billing owner, opt-in, suspension, high-water pool and Extra Usage cap use the existing policy rather than a parallel billing formula.
- Before sibling-mapping/vendor work, block a run whose conservative full-run estimate does not fit. Re-check immediately before each existing 20-lead batch (including preview). Unknown usage fails closed. A response-only `budgetStop` explains the stop; the HTTP route returns 402 when no results completed and returns partial results otherwise. Socket completion includes the same explanation.
- Keep completed snapshots/writes and existing job metadata. Attempted lead IDs now include only started batches, so refused leads are not incorrectly deduplicated as attempted. No persistence model/schema or stored usage changes; `paygSettlement.ts` and settlement math are untouched.
- A run-local estimated-spend floor prevents stale ledger reads from reusing this run's admitted budget. Preflight is not a reservation. Only real batch admission uses existing PAYG admission bookkeeping; projections cannot write it.

### Validation

- TDD reproduction: new cap tests failed 4/4 before the implementation (all 45 leads ran despite refusal); now pass.
- Scoped Jest: `cd backend && npx jest src/__tests__/enrichmentBatchCap.test.ts src/__tests__/enrichmentBatchBudget.test.ts src/__tests__/crmEnrichmentServiceV3.test.ts src/__tests__/enrichmentV3RealDepsLoadLeads.test.ts src/__tests__/paygOverage.gates.test.ts src/__tests__/paygOverage.test.ts src/__tests__/paygSettlement.test.ts --runInBand --silent` — 7 suites, 262 tests passed.
- Scoped TypeScript: `cd backend && node --max-old-space-size=5120 node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --esModuleInterop --resolveJsonModule --target es2018 --module commonjs src/services/enrichmentBatchBudget.ts src/services/crmEnrichmentServiceV3.ts src/services/enrichmentV3RealDeps.ts src/services/tokenUsageService.ts src/services/llmUsagePoolDecision.ts src/routes/crm.ts src/__tests__/enrichmentBatchCap.test.ts src/__tests__/enrichmentBatchBudget.test.ts src/__tests__/paygOverage.gates.test.ts` — exit 0. A first 3072MB attempt exhausted the heap; sequential 5120MB run succeeded.
- Negative tests: unaffordable full run starts no lead work; cap change after batch 1 stops batch 2, preserving 20 snapshots/writes and only 20 attempted IDs; usage lookup failure retains partial results; preview refusal; forecasts beyond PAYG cap/opt-out; stale-ledger floor; projection cannot write admission records; month rollover fails closed.

### Risk / rollback / not tested

- Admission estimates are intentionally conservative (current allocated vendor rates plus a documented LLM guard band), not invoices or guaranteed maximum provider prices. Cached runs may be refused earlier than actual spend requires. Variable-cost work already in flight can finish: exposure is one admitted 20-lead batch, not the remaining list. This is not a distributed reservation across concurrent runs/accounts; concurrent external spend can consume budget after a check.
- Rollback: revert this PR; no data migration or usage repair is needed. Restores prior start-only/unbounded enrichment admission behavior.
- Post-deploy smoke: with a controlled test account, refuse an unaffordable run with 402 and a message before vendor calls; then allow batch 1, exhaust allowance before batch 2, verify partial results and snapshots remain and no refused lead/vendor call starts. Check socket stop message and attempted IDs.
- NOT tested: live vendors, production billing/settlement, cloud/browser smoke, concurrent distributed runs, production deploy, full monorepo build/suite. Draft only; not ready or merged.
