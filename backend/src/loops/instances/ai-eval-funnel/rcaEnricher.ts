/**
 * Root-cause analysis (RCA) enricher for the ai-eval-funnel loop.
 *
 * Given a MutationProposal (fired rule + triggering stats) and the loop's
 * mutation surface, calls claude-sonnet-4-6 on Bedrock to produce:
 *   - 3–5 candidate root-cause hypotheses grounded in specific components/events
 *   - ≥3 ranked candidate fixes with impact / confidence / cost / why-this-rank
 *
 * Design notes:
 *   - The system prompt encodes the rule context + telemetry events + mutation
 *     surface + JSON output schema. It is stable across runs, so we attach a
 *     `cachePoint` marker — Bedrock caches this prefix and only the per-rule
 *     user prompt pays full input-token price on subsequent calls.
 *   - Hard 25-second timeout. Any failure path (Bedrock error, non-JSON
 *     response, schema mismatch, timeout) returns the same graceful envelope:
 *         { topHypotheses: [proposal.hypothesis], rankedFixes: [], error: '...' }
 *     The caller (NotionDigestTool / cron DM) NEVER sees a thrown exception.
 *   - This module is the single source of truth for the RCA shape. Both the
 *     Notion task body and the Slack DM read its output via
 *     `mutation.artifact.rcaEnrichment` (populated by NotionDigestTool.apply()).
 */

import type { MutationProposal } from '../../core/types';
import type { AiEvalProposalPayload } from './rules';

export const RCA_TIMEOUT_MS = 25_000;

// claude-sonnet-4-6 requires the global cross-region inference profile ARN —
// matches the mapping in agentModeService.getBedrockClient().
const SONNET_4_6_INFERENCE_PROFILE =
  'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6';

export type RcaImpact = 'high' | 'med' | 'low';
export type RcaConfidence = 'high' | 'med' | 'low';

export interface RcaRankedFix {
  title: string;
  impact: RcaImpact;
  confidence: RcaConfidence;
  cost_sp: number;
  why_this_rank: string;
}

export interface RcaEnrichment {
  /** 3–5 distinct candidate root causes. On error, falls back to [proposal.hypothesis]. */
  topHypotheses: string[];
  /** ≥3 ranked candidate fixes. On error, []. */
  rankedFixes: RcaRankedFix[];
  /** Set when enrichment failed; the caller renders a graceful fallback. */
  error?: string;
}

interface MutationSurfaceEntry {
  readonly key: string;
  readonly kind: string;
}

const MAX_HYPOTHESES = 5;

/**
 * Build the cacheable system prompt. Contains everything that does NOT vary
 * per-rule: the loop architecture briefing, the telemetry event glossary, the
 * mutation surface, the reasoning rubric, and the JSON output schema.
 *
 * Stable string -> Bedrock caches it. Per-rule data lives in the user prompt.
 */
function buildSystemPrompt(mutationSurface: readonly MutationSurfaceEntry[]): string {
  const surfaceLines = mutationSurface.map((s) => `  - ${s.key} (${s.kind})`).join('\n');
  return [
    'You are the root-cause analyst for the AgentWeb /ai-eval landing-page closed-loop funnel.',
    '',
    'ARCHITECTURE:',
    'A daily cron scans funnel telemetry from a DynamoDB events table, fires policy-DSL rules',
    'when ratios cross thresholds, and asks you to explain WHY each fired rule actually triggered',
    'and HOW to fix it. Your output drives the Notion task spec + the Slack DM line for the founder.',
    '',
    'TELEMETRY EVENTS (these are the event types in the table — fluent reference):',
    '  - landed: a user hit any AgentWeb pathname. Note: <LandedTracker /> in the landing-page',
    '    repo fires this on every site path, NOT just /ai-eval. Denominator pollution is a',
    '    real failure mode for any rule that divides by landed_count.',
    '  - form_submitted: the /ai-eval form was submitted. Only fires from app/(frontend)/ai-eval/page.tsx.',
    '  - eval_started: the polling job kicked off after a form submit.',
    '  - eval_completed: the eval finished and ReportView rendered.',
    '  - eval_failed / eval_abandoned: failure modes during polling.',
    '  - report_viewed: ReportView was visible. ReportView embeds the report in an iframe whose',
    '    inner scroll does NOT re-engage the sticky outer CTA bar — a known UX trap.',
    '  - signup_clicked: user clicked the signup CTA from ReportView.',
    '  - signed_up: account creation completed.',
    '  - onboarding_started: post-signup onboarding began.',
    '  - complaint_received: explicit complaint surfaced (NPS / Slack / email forwarded).',
    '  - icp_match: subject matched the ICP-1 segment.',
    '',
    'NOTE on denominators: events may include logged-in subjects who are not part of the funnel.',
    'When a rule fires, ask yourself whether the denominator could be polluted by a different',
    'cohort (e.g. logged-in users in signup_clicked / eval_completed ratios).',
    '',
    'MUTATION SURFACE (the keys you are allowed to recommend mutations against):',
    surfaceLines,
    '',
    'Any fix you recommend SHOULD target one of those keys when possible. Code-fix recommendations',
    'that touch landing-page repo components (e.g. <LandedTracker />, ReportView, the iframe',
    'wrapper, the form submit handler) or backend telemetry shape are also valid — just say so',
    'explicitly. Do NOT recommend generic copy advice without grounding it in a component or event.',
    '',
    'RANKING RUBRIC:',
    '  - Rank fixes by impact x confidence x ease.',
    '  - Lower cost_sp = easier; 1 SP = half day, 2 SP = full day, 3 SP = ~1.5 day, 5 SP = ~half',
    '    week, 8 SP = full week (max).',
    '  - Prefer the fix that addresses the root cause over a workaround.',
    '  - Be specific. Reference component names, event names, file paths when they are knowable',
    '    from the architecture above. Generic suggestions ("improve copy") are unhelpful.',
    '',
    'OUTPUT SCHEMA (you MUST return ONLY this JSON, no prose, no markdown fence):',
    '{',
    '  "topHypotheses": [string, string, string, ...],     // 3 to 5 distinct candidate causes',
    '  "rankedFixes": [                                     // 3 or more fixes, ordered best-first',
    '    {',
    '      "title": string,                                 // short imperative summary',
    '      "impact":     "high" | "med" | "low",',
    '      "confidence": "high" | "med" | "low",',
    '      "cost_sp":    number,                            // integer SP, see scale above',
    '      "why_this_rank": string                          // 1 sentence justifying the slot',
    '    }',
    '    ...',
    '  ]',
    '}',
    '',
    'STYLE:',
    '  - Direct, no hedging, no preamble, no apologies.',
    '  - Each hypothesis MUST reference a specific surface (a component, an event, a threshold,',
    '    a telemetry path). "The copy might be wrong" alone does NOT count.',
    '  - Never name competitors. Never promise outcome numbers.',
  ].join('\n');
}

function buildUserPrompt(p: MutationProposal<AiEvalProposalPayload>): string {
  return [
    `Rule fired: \`${p.sourceRuleId}\``,
    `Current rule hypothesis (the WHAT, not the WHY): "${p.hypothesis}"`,
    `Target mutation key: ${p.payload.targetKey}`,
    '',
    'Triggering stats (the window snapshot that caused the rule to fire):',
    '```json',
    JSON.stringify(p.triggeringStats ?? {}, null, 2),
    '```',
    '',
    'Produce the JSON described in the system prompt. Return JSON only — no markdown fence, no prose.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response validation (hand-rolled — no zod dependency in this repo).
// ---------------------------------------------------------------------------

const VALID_IMPACT: ReadonlySet<RcaImpact> = new Set(['high', 'med', 'low']);
const VALID_CONFIDENCE: ReadonlySet<RcaConfidence> = new Set(['high', 'med', 'low']);

function parseAndValidate(raw: string): { topHypotheses: string[]; rankedFixes: RcaRankedFix[] } {
  // The model occasionally wraps its output in ```json ... ``` — strip that if present.
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`LLM did not return valid JSON: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.topHypotheses) || obj.topHypotheses.length < 3) {
    throw new Error('topHypotheses must be an array of at least 3 strings');
  }
  const topHypotheses: string[] = [];
  for (const h of obj.topHypotheses) {
    if (typeof h !== 'string' || h.trim().length === 0) {
      throw new Error('every topHypotheses entry must be a non-empty string');
    }
    topHypotheses.push(h);
  }

  if (!Array.isArray(obj.rankedFixes) || obj.rankedFixes.length < 3) {
    throw new Error('rankedFixes must be an array of at least 3 fix objects');
  }
  const rankedFixes: RcaRankedFix[] = [];
  for (const f of obj.rankedFixes) {
    if (!f || typeof f !== 'object') {
      throw new Error('every rankedFixes entry must be an object');
    }
    const fix = f as Record<string, unknown>;
    if (typeof fix.title !== 'string' || fix.title.trim().length === 0) {
      throw new Error('fix.title must be a non-empty string');
    }
    if (typeof fix.impact !== 'string' || !VALID_IMPACT.has(fix.impact as RcaImpact)) {
      throw new Error(`fix.impact must be one of high|med|low (got "${fix.impact}")`);
    }
    if (typeof fix.confidence !== 'string' || !VALID_CONFIDENCE.has(fix.confidence as RcaConfidence)) {
      throw new Error(`fix.confidence must be one of high|med|low (got "${fix.confidence}")`);
    }
    if (typeof fix.cost_sp !== 'number' || !Number.isFinite(fix.cost_sp) || fix.cost_sp < 0) {
      throw new Error(`fix.cost_sp must be a non-negative number (got "${String(fix.cost_sp)}")`);
    }
    if (typeof fix.why_this_rank !== 'string' || fix.why_this_rank.trim().length === 0) {
      throw new Error('fix.why_this_rank must be a non-empty string');
    }
    rankedFixes.push({
      title: fix.title,
      impact: fix.impact as RcaImpact,
      confidence: fix.confidence as RcaConfidence,
      cost_sp: fix.cost_sp,
      why_this_rank: fix.why_this_rank,
    });
  }

  return {
    topHypotheses: topHypotheses.slice(0, MAX_HYPOTHESES),
    rankedFixes,
  };
}

// ---------------------------------------------------------------------------
// Bedrock call with hard timeout
// ---------------------------------------------------------------------------

async function callBedrockSonnet46(systemText: string, userText: string): Promise<string> {
  // Lazy-import the AWS SDK so the test mock applies. The metered factory
  // (llmClients) is lazy-imported for the same reason — it constructs the
  // (mocked) BedrockRuntimeClient internally.
  const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const { getBedrockClient } = await import('../../../utils/llmClients');

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
  const credentials = process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      }
    : undefined;

  // Shadow usage metering: cron/loop context — no attributable user, so the
  // recorder attributes to 'system'.
  const client = await getBedrockClient(
    { feature: 'other' },
    {
      region,
      credentials,
      requestHandler: {
        connectionTimeout: 10_000,
        requestTimeout: RCA_TIMEOUT_MS,
      } as unknown as Record<string, unknown>,
    }
  );

  // System prompt is stable across runs — attach cachePoint so Bedrock caches it.
  // Use `any` for the input bag because cachePoint blocks aren't in the public
  // SDK types yet (they are accepted at runtime — see agentModeService.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const converseInput: any = {
    modelId: SONNET_4_6_INFERENCE_PROFILE,
    system: [
      { text: systemText },
      { cachePoint: { type: 'default' } },
    ],
    messages: [
      {
        role: 'user',
        content: [{ text: userText }],
      },
    ],
    inferenceConfig: {
      maxTokens: 2048,
      temperature: 0.2,
    },
  };
  const command = new ConverseCommand(converseInput);

  const response = (await client.send(command as never)) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  };

  const blocks = response?.output?.message?.content ?? [];
  const text = blocks.map((b) => b?.text ?? '').join('');
  if (!text.trim()) {
    throw new Error('Bedrock returned an empty response');
  }
  return text;
}

/**
 * Race the LLM call against a hard timeout. On timeout, rejects with a
 * descriptive Error; the outer `enrichWithRCA` translates that into the
 * graceful error envelope.
 */
async function callWithTimeout(systemText: string, userText: string): Promise<string> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`RCA enrichment timed out after ${RCA_TIMEOUT_MS}ms`));
    }, RCA_TIMEOUT_MS);
  });
  try {
    return await Promise.race([callBedrockSonnet46(systemText, userText), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function enrichWithRCA(
  proposal: MutationProposal<AiEvalProposalPayload>,
  mutationSurface: readonly MutationSurfaceEntry[],
): Promise<RcaEnrichment> {
  const fallback = (reason: string): RcaEnrichment => ({
    topHypotheses: [proposal.hypothesis],
    rankedFixes: [],
    error: `RCA enrichment unavailable: ${reason}`,
  });

  let raw: string;
  try {
    raw = await callWithTimeout(buildSystemPrompt(mutationSurface), buildUserPrompt(proposal));
  } catch (err) {
    return fallback((err as Error).message ?? String(err));
  }

  try {
    const validated = parseAndValidate(raw);
    return {
      topHypotheses: validated.topHypotheses,
      rankedFixes: validated.rankedFixes,
    };
  } catch (err) {
    return fallback((err as Error).message ?? String(err));
  }
}
