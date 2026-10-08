/**
 * Live smoke test of every model the daily refresh adds, then rewrites the PR body
 * and plan file with the result. Reads the plan written by frontierMonitor.ts, plus
 * the capability-guard result (jest --json) written by the previous workflow step.
 * Never fails the job: a missing key or a failed model becomes a visible
 * "not eligible for auto-merge" item in the PR, not a run that dies before the PR opens.
 */
import * as fs from 'fs';
import { buildReviewArtifacts } from '../services/agentMode/frontierMonitor';
import { guardReport, smokeReports, smokeTestAll } from '../services/agentMode/catalogReview';
import type { LLMModelConfig } from '../services/agentMode/llmModelRegistry';

const readIfExists = (path: string): string | undefined => { try { return fs.readFileSync(path, 'utf8'); } catch { return undefined; } };

async function main() {
  const planPath = process.argv[2] ?? '/tmp/model-catalog-plan.json';
  const doc = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const registryChanges: Record<string, LLMModelConfig> = doc.plan?.registryChanges ?? {};
  const ids: string[] = doc.plan?.additions ?? [];
  const results = await smokeTestAll(
    ids.map(id => ({ id, capabilities: registryChanges[id] })),
    { apiKey: process.env.OPENROUTER_API_KEY },
  );
  const reviewReports = [
    ...(doc.reviewReports ?? []).filter((r: string) => !/LIVE SMOKE TEST|CAPABILITY GUARD/.test(r)),
    ...guardReport(readIfExists(process.env.GUARD_RESULT_PATH ?? '/tmp/guard-result.json')),
    ...smokeReports(results),
  ];
  const smoke = Object.fromEntries(results.map(r => [r.id, r.status]));
  const additions = ids.map(id => ({ id, adminOnly: registryChanges[id]?.adminOnly }));
  const review = buildReviewArtifacts({
    additions, smoke, reports: [...(doc.reports ?? []), ...(doc.plan?.reports ?? []), ...reviewReports],
    // Fail closed if the monitor step's data is missing.
    existingChanges: doc.existingChanges ?? { changed: 0, blockers: ['existing-model changes were not evaluated'] },
    observationDegraded: doc.observationDegraded ?? true,
  });
  fs.writeFileSync(planPath, JSON.stringify({ ...doc, reviewReports, smoke, autoMerge: review.autoMerge }, null, 2));
  if (process.env.PR_BODY_PATH) fs.writeFileSync(process.env.PR_BODY_PATH, review.body);
  console.error(`smoke: ${results.map(r => `${r.id}=${r.status}`).join(', ') || 'no new models'}; auto-merge ${review.autoMerge.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}`);
}
main().catch(error => { console.error('smoke test step errored; PR body left as the monitor step wrote it:', error); });
