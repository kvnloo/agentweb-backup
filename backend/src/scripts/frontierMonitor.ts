/** Daily read-only discovery; --write prepares code for the existing draft-PR workflow. */
import * as fs from 'fs';
import * as path from 'path';
import { buildReviewArtifacts, byokCoverage, detectFrontier, fetchJson, renderCoverage, upstreamId } from '../services/agentMode/frontierMonitor';
import { classifyExistingChanges, endpointPriceReport } from '../services/agentMode/catalogReview';
import { blendedPrice } from '../services/agentMode/modelSupersession';
import { LLM_MODEL_REGISTRY, LLMModelConfig } from '../services/agentMode/llmModelRegistry';
import { refreshModelCatalog } from '../services/agentMode/modelCatalogRefresh';
import { writeCatalogPlan } from './refreshModelCatalog';

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const catalog = await fetchJson('https://openrouter.ai/api/v1/models');
  const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  let aa: unknown, aaError = '';
  try {
    aa = apiKey ? await fetchJson('https://artificialanalysis.ai/api/v2/data/llms/models', fetch, { 'x-api-key': apiKey }) : undefined;
  } catch (error) { aaError = `Artificial Analysis failed: ${error instanceof Error ? error.message : 'fetch failed'}`; }
  const detection = detectFrontier(catalog, aa, undefined, Date.now(), Number(process.env.FRONTIER_TOP_N ?? 10));
  if (aaError) detection.reports.push(aaError);
  // Reuse the same source snapshots for detection and refresh (no second fetch).
  const plan = await refreshModelCatalog({ catalog, aa, aaApiKey: '', additionIds: detection.additions, date });
  const proposedRegistry: Record<string, Readonly<LLMModelConfig>> = { ...LLM_MODEL_REGISTRY };
  for (const id of plan.additions) proposedRegistry[id] = plan.registryChanges[id] as LLMModelConfig;
  const coverage = await byokCoverage(proposedRegistry);
  const markdown = renderCoverage(coverage, date);
  const target = path.resolve(__dirname, '../../..', 'docs/openrouter-byok-coverage.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown);
  // Cross-check each new model's listed price against what its endpoints charge.
  const reviewReports: string[] = [];
  for (const id of plan.additions) {
    const upstream = upstreamId(id), price = plan.pricingChanges[id];
    if (!upstream || !price) continue;
    try {
      reviewReports.push(...endpointPriceReport(id, blendedPrice(price), await fetchJson(`https://openrouter.ai/api/v1/models/${upstream}/endpoints`)));
    } catch (error) {
      reviewReports.push(`⚠️ ENDPOINT PRICES UNAVAILABLE: ${id} — ${error instanceof Error ? error.message : 'fetch failed'}`);
    }
  }
  const additions = plan.additions.map(id => ({ id, adminOnly: (plan.registryChanges[id] as LLMModelConfig | undefined)?.adminOnly }));
  // The live smoke test runs in its own step (it needs a secret); until then it is "pending".
  const existingChanges = classifyExistingChanges(LLM_MODEL_REGISTRY as any, plan.registryChanges as any, plan.additions);
  // Missing Artificial Analysis data or unreadable endpoint coverage means the run did not
  // see everything; that blocks auto-merge (a failed Slack post is a notification issue, not a data one).
  const observationDegraded = !!aaError || !apiKey || coverage.some(r => r.status.startsWith('UNKNOWN:'));
  const review = buildReviewArtifacts({
    additions, reports: [...detection.reports, ...plan.reports, ...reviewReports],
    smoke: Object.fromEntries(plan.additions.map(id => [id, 'pending' as const])),
    existingChanges, observationDegraded,
  });
  const report = [ '# Frontier monitor', '', ...detection.alerts, '', ...detection.reports, ...plan.reports, ...reviewReports, '', markdown ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (process.argv.includes('--write')) writeCatalogPlan(plan);
  if (process.env.PR_BODY_PATH) fs.writeFileSync(process.env.PR_BODY_PATH, review.body);
  // Opt-in side effect: ordinary local runs cannot post alerts accidentally.
  let notificationFailed = false;
  if (process.argv.includes('--notify') && process.env.SLACK_MODEL_ALERTS_WEBHOOK && detection.alerts.length) {
    try {
      const response = await fetch(process.env.SLACK_MODEL_ALERTS_WEBHOOK, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ text: detection.alerts.join('\n'), mrkdwn: false }),
      });
      if (!response.ok) throw new Error('Model alert failed');
    } catch {
      notificationFailed = true;
      const warning = 'Slack model alert failed; inspect webhook configuration.';
      detection.reports.push(warning);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${warning}\n`);
    }
  }
  console.log(JSON.stringify({ ...detection, coverage, plan, reviewReports, existingChanges, observationDegraded, autoMerge: review.autoMerge, degraded: notificationFailed || !!aaError || coverage.some(r => r.status.startsWith('UNKNOWN:')) }, null, 2));
  // The workflow checks degraded after preserving the report and opening the draft PR.
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
