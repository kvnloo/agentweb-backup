import { agentModeService } from './agentModeService';
import { runJevDecide } from '../emma/jevAdapter';
import { runZ0ChoiceExperiment } from '../emma/z0Adapter';
import { createHash } from 'crypto';
import type { LLMUsageContext } from '../utils/llmService';

export type ReportType = 'creative' | 'research' | 'performance';

const CLASSIFICATION_MODEL = 'gemini-3.1-flash-lite';
const CLASSIFICATION_TIMEOUT_MS = 10000;
const MAX_CONTENT_CHARS = 500;

// JEV report_type_v1 shadow: bounded Choice over the same three labels.
// Mode is per-decision via env: unset/off = no Jev call (today's behavior);
// 'shadow' = call Jev concurrently, log comparison, always return incumbent.
// Never alters the returned category. Privacy surface unchanged: same
// filename + 500-char excerpt already sent to the incumbent.
type ReportShadowBackend = 'off' | 'jev' | 'z0';

export function readReportShadowBackend(env: NodeJS.ProcessEnv = process.env): ReportShadowBackend {
  if ((env.Z0_REPORT_CLASSIFY_SHADOW ?? '').trim().toLowerCase() === 'shadow') return 'z0';
  if ((env.JEV_REPORT_CLASSIFY ?? '').trim().toLowerCase() === 'shadow') return 'jev';
  return 'off';
}

async function shadowJevReportClassify(
  filename: string,
  truncated: string,
  incumbent: ReportType,
  incumbentLatencyMs: number,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await runJevDecide({
      state: { filename, excerpt: truncated },
      questions: {
        report_type: {
          type: 'choice',
          instructions: 'Classify the HTML report into exactly one category.',
          criteria: {
            creative: 'Blog articles, social media posts, ad copy, content calendars, email campaigns, marketing copy.',
            performance: 'Paid ads reports, ROAS, CPM, CPC, CTR, ad spend, campaign metrics, conversion rates, media buying analytics.',
            research: 'Market intelligence, competitor analysis, SEO reports, lead lists, general business reports, summaries, audits, GTM plans.',
          },
        },
      },
    });
    const latencyMs = Date.now() - startedAt;
    if (!result.ok) {
      console.log(JSON.stringify({
        event: 'jev_report_classify_shadow', ok: false, reason: result.reason,
        incumbent, incumbentLatencyMs, jevLatencyMs: latencyMs,
      }));
      return;
    }
    const answer = result.answers['report_type'];
    const label = answer?.type === 'choice' ? answer.choice : null;
    const probabilities = answer?.type === 'choice' ? answer.probabilities : {};
    const confidence = answer?.type === 'choice' ? answer.confidence : null;
    const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    const margin = sorted.length >= 2 ? sorted[0][1] - sorted[1][1] : null;
    console.log(JSON.stringify({
      event: 'jev_report_classify_shadow', ok: true, model: result.model,
      jevLabel: label, jevConfidence: confidence, jevMargin: margin,
      jevProbabilities: probabilities, jevLatencyMs: latencyMs,
      incumbent, incumbentLatencyMs,
      agree: label === incumbent,
      usage: result.usage ?? null,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      event: 'jev_report_classify_shadow', ok: false,
      reason: error instanceof Error ? error.message : String(error),
      incumbent, incumbentLatencyMs, jevLatencyMs: Date.now() - startedAt,
    }));
  }
}

async function shadowZ0ReportClassify(
  filename: string,
  truncated: string,
  incumbent: ReportType,
  incumbentLatencyMs: number,
): Promise<void> {
  const state = { filename, excerpt: truncated };
  const operationId = createHash('sha256')
    .update(JSON.stringify(state))
    .digest('hex');
  const startedAt = Date.now();
  try {
    const result: any = await runZ0ChoiceExperiment(
      {
        operation_id: operationId,
        decision_id: 'report_type_v1',
        state,
        instructions: 'Classify the HTML report into exactly one category.',
        options: {
          creative: 'Blog articles, social media posts, ad copy, content calendars, email campaigns, marketing copy.',
          performance: 'Paid ads reports, ROAS, CPM, CPC, CTR, ad spend, campaign metrics, conversion rates, media buying analytics.',
          research: 'Market intelligence, competitor analysis, SEO reports, lead lists, general business reports, summaries, audits, GTM plans.',
        },
        allow_remote: process.env.Z0INT_REPORT_CLASSIFY_ALLOW_REMOTE === '1',
      },
      { scopeId: 'report_type_v1' },
    );
    const latencyMs = Date.now() - startedAt;
    if (!result.ok || !result.output) {
      console.log(JSON.stringify({
        event: 'z0_report_classify_shadow', ok: false, reason: result.reason,
        traceId: result.trace_id ?? null, incumbent, incumbentLatencyMs,
        z0LatencyMs: latencyMs, reconcileRequired: result.reconcile_required === true,
      }));
      return;
    }
    const output = result.output as Record<string, any>;
    const label = typeof output.label === 'string' ? output.label : null;
    const probabilities = output.probabilities ?? {};
    const sorted = Object.entries(probabilities)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .sort((a, b) => b[1] - a[1]);
    const margin = sorted.length >= 2 ? sorted[0][1] - sorted[1][1] : null;
    console.log(JSON.stringify({
      event: 'z0_report_classify_shadow', ok: true,
      decisionId: 'report_type_v1', traceId: result.trace_id ?? null,
      dispatchReceiptId: result.dispatch_receipt_id ?? null,
      replayed: result.replayed === true, applied: result.applied === true,
      model: output.model ?? null, z0Label: label,
      z0Confidence: output.confidence ?? null, z0Margin: margin,
      z0Probabilities: probabilities, z0LatencyMs: latencyMs,
      providerLatencyMs: output.latency_ms ?? null,
      incumbent, incumbentLatencyMs, agree: label === incumbent,
      usage: output.usage ?? null,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      event: 'z0_report_classify_shadow', ok: false,
      reason: error instanceof Error ? error.message : String(error),
      incumbent, incumbentLatencyMs, z0LatencyMs: Date.now() - startedAt,
    }));
  }
}

const SYSTEM_PROMPT = `You classify HTML reports into exactly one category.

Categories:
- creative: blog articles, social media posts, ad copy, content calendars, email campaigns, marketing copy
- performance: paid ads reports, ROAS, CPM, CPC, CTR, ad spend, campaign metrics, conversion rates, media buying analytics
- research: market intelligence, competitor analysis, SEO reports, lead lists, general business reports, summaries, audits, GTM plans

Reply with ONLY one word: creative, performance, or research.`;

export async function classifyReport(filename: string, contentExcerpt: string, usageContext?: LLMUsageContext): Promise<ReportType> {
  const truncated = contentExcerpt.slice(0, MAX_CONTENT_CHARS);
  const userMessage = `Filename: ${filename}\nContent: ${truncated}`;

  // Shadow path: single incumbent call (authoritative) + one concurrent Jev
  // call whose comparison is logged fire-and-forget. The shadow never alters
  // the return value, never adds a second incumbent call, and never fails
  // the request (shadowJevReportClassify catches internally).
  const shadowBackend = readReportShadowBackend();
  if (shadowBackend !== 'off') {
    const incumbentStartedAt = Date.now();
    const incumbentPromise = runIncumbentClassifier(userMessage, usageContext);
    // Fire-and-forget: attaches to the same single incumbent promise.
    void incumbentPromise.then(
      (incumbent) => {
        const incumbentLatencyMs = Date.now() - incumbentStartedAt;
        if (shadowBackend === 'z0') {
          void shadowZ0ReportClassify(filename, truncated, incumbent, incumbentLatencyMs);
        } else {
          void shadowJevReportClassify(filename, truncated, incumbent, incumbentLatencyMs);
        }
      },
      () => {},
    );
    return incumbentPromise;
  }

  return runIncumbentClassifier(userMessage, usageContext);
}

async function runIncumbentClassifier(userMessage: string, usageContext?: LLMUsageContext): Promise<ReportType> {

  try {
    const llmPromise = agentModeService.callLLM(
      CLASSIFICATION_MODEL,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      {
        temperature: 0,
        max_completion_tokens: 5,
        taskClass: 'nonstandard_consumer',
        // ENG-1858: labelling the user's own reports — attribute it to them.
        usageContext: usageContext ?? { feature: 'report_classification' },
      }
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Classification timed out')), CLASSIFICATION_TIMEOUT_MS)
    );

    const res = await Promise.race([llmPromise, timeoutPromise]);
    const raw = (res.choices?.[0]?.message?.content ?? '').trim().toLowerCase();

    if (raw === 'creative' || raw === 'performance' || raw === 'research') {
      return raw;
    }
    // Partial match fallback
    if (raw.includes('creative')) return 'creative';
    if (raw.includes('performance')) return 'performance';
    return 'research';
  } catch {
    return 'research';
  }
}
