/**
 * LlmAnalystRuleSet — an LLM-as-policy implementation of Layer 2.
 *
 * The DSL RuleSet (`dslRuleSet.ts`) fires hand-written threshold rules. That's
 * great for high-volume surfaces with known failure shapes, but at low volume
 * (or for catching the failures you DIDN'T predict) it does nothing — which is
 * why the onboarding loop just reports "N people tried" and never says what's
 * wrong.
 *
 * This RuleSet instead hands the event window to an LLM with a description of
 * what the flow is supposed to do, and asks it to reason: "what looks broken or
 * underperforming, and what would you do about it?" — then turns each issue it
 * finds into a MutationProposal. The downstream layers are unchanged: the
 * proposal goes to the gate (your Slack DM with ✅/❌), and on approval the
 * tools layer ships the fix. So the chain becomes:
 *   raw events → LLM reasons → suggestion → you approve → it builds → measure.
 *
 * Generic + pluggable: a loop opts in via its manifest (`rulesetImpl:
 * 'llmAnalyst'`) and supplies the flow description + model in the instance
 * wiring. The same analyst works for onboarding, the lander, or any surface —
 * only the `flowDescription` differs.
 *
 * Cost note: this feeds a SUMMARY of the window (per-type + per-chapter counts,
 * error samples, a few representative journeys), not the raw firehose. At low
 * volume that summary is the whole dataset; at scale, gate the analyst behind a
 * cheap structural pre-filter so it only reasons over flagged slices.
 */

import type { BedrockPort } from '../ports';
import type { MutationProposal, NormalizedEvent, RuleSet, TimeWindow } from '../types';
import { asMutationId } from '../types';

export interface LlmAnalystProposalPayload {
  /** What the fix should do — consumed by the tools layer / cloud-dev spec. */
  directive: string;
  /** Which area/step the issue is in (for the human + the dispatch). */
  targetArea?: string;
  /** Copy-only low-risk fixes may auto-ship; code changes never do. */
  autoShipSafe: boolean;
}

export interface LlmAnalystConfig {
  model: string;
  /** Plain-English description of what this flow is and what "working" looks
   * like. This is the analyst's lens for judging intent vs outcome. */
  flowDescription: string;
  /** Human name of the metric the loop optimizes (frames the analysis). */
  targetMetricName: string;
  /** Max proposals to surface per cycle (keeps the DM focused + caps cost). */
  maxProposals?: number;
  /** Dimension key naming the step/chapter on each event, if present. */
  chapterDimension?: string;
}

interface AnalystIssue {
  title?: string;
  whatHappened?: string;
  evidence?: string;
  suggestedFix?: string;
  kind?: string;
  severity?: string;
  autoShipSafe?: boolean;
}

let counter = 0;
function nextProposalId(loopId: string, slug: string): string {
  counter++;
  return `${loopId}:llm:${slug}:${counter}`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'issue';
}

interface EventSummary {
  total: number;
  counts: Record<string, number>;
  chapters: Record<string, number>;
  errorSamples: string[];
  journeys: string[];
}

/** Compress the window into a compact, LLM-readable picture: per-type counts,
 * per-chapter counts, a few error samples, and a few representative journeys. */
function summarizeEvents(events: readonly NormalizedEvent[], chapterDim?: string): EventSummary {
  const counts: Record<string, number> = {};
  const chapters: Record<string, number> = {};
  const errorSamples: string[] = [];

  for (const e of events) {
    counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
    if (chapterDim) {
      const ch = e.dimensions?.[chapterDim];
      if (ch != null) chapters[String(ch)] = (chapters[String(ch)] ?? 0) + 1;
    }
    const err = e.dimensions?.errorMessage ?? e.dimensions?.error;
    if (err != null && errorSamples.length < 8) errorSamples.push(String(err));
  }

  // A few representative journeys (event sequence per subject, time-ordered).
  const bySubject = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    const arr = bySubject.get(e.subjectId) ?? [];
    arr.push(e);
    bySubject.set(e.subjectId, arr);
  }
  const journeys: string[] = [];
  for (const [, evs] of bySubject) {
    if (journeys.length >= 6) break;
    const seq = [...evs].sort((a, b) => a.ts.getTime() - b.ts.getTime()).map((e) => e.eventType);
    journeys.push(seq.join(' → '));
  }

  return { total: events.length, counts, chapters, errorSamples, journeys };
}

const ANALYST_SYSTEM =
  'You are a product-reliability analyst for a SaaS onboarding/funnel flow. You are given a ' +
  'description of what a flow is supposed to do and a summary of real user telemetry over a ' +
  'window. Your job is to spot where the flow is BROKEN or where users are clearly STRUGGLING ' +
  '(stuck, dropping off, hitting errors, a promised action not happening) — especially failures ' +
  'a fixed threshold rule would miss. Reason about intent vs. outcome the way a human watching ' +
  'over a user\'s shoulder would. Be conservative: only raise an issue when the evidence ' +
  'supports it; if the data looks healthy or is too thin to judge, return an empty list. ' +
  'Respond with JSON only — no markdown fences, no preamble.';

function buildUserPrompt(config: LlmAnalystConfig, window: TimeWindow, s: EventSummary): string {
  return (
    `Flow: ${config.flowDescription}\n\n` +
    `North-star metric: ${config.targetMetricName}\n` +
    `Window: ${window.start.toISOString()} → ${window.end.toISOString()}\n` +
    `Total events: ${s.total}\n\n` +
    `Event counts:\n${JSON.stringify(s.counts, null, 2)}\n\n` +
    (Object.keys(s.chapters).length
      ? `Per-step counts:\n${JSON.stringify(s.chapters, null, 2)}\n\n`
      : '') +
    (s.errorSamples.length ? `Error samples:\n- ${s.errorSamples.join('\n- ')}\n\n` : '') +
    (s.journeys.length ? `Representative user journeys:\n- ${s.journeys.join('\n- ')}\n\n` : '') +
    `Identify concrete issues where the flow is broken or users are struggling. For each, return ` +
    `an object with: title (short), whatHappened (the likely cause in plain English), evidence ` +
    `(which numbers/journeys point to it), suggestedFix (what to change), kind ("copy" for ` +
    `wording/UX copy, "code_change" for a bug/logic fix), severity ("high"|"med"|"low"), ` +
    `autoShipSafe (true only for low-risk copy tweaks).\n\n` +
    `Return JSON exactly: {"issues": [ ... ]}. If nothing is wrong or data is too thin, return ` +
    `{"issues": []}.`
  );
}

function parseIssues(raw: string): AnalystIssue[] {
  let text = raw.trim();
  // Tolerate accidental markdown fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text) as { issues?: unknown };
    if (!parsed || !Array.isArray(parsed.issues)) return [];
    return parsed.issues.filter((x): x is AnalystIssue => typeof x === 'object' && x !== null);
  } catch {
    return [];
  }
}

function composeHypothesis(iss: AnalystIssue): string {
  const what = iss.whatHappened ?? iss.title ?? 'Issue detected';
  const fix = iss.suggestedFix ? ` Suggested fix: ${iss.suggestedFix}` : '';
  return `${what}.${fix}`.trim();
}

export class LlmAnalystRuleSet implements RuleSet<NormalizedEvent, LlmAnalystProposalPayload> {
  constructor(
    private readonly loopId: string,
    private readonly bedrock: BedrockPort,
    private readonly config: LlmAnalystConfig,
  ) {}

  async evaluate(
    events: NormalizedEvent[],
    window: TimeWindow,
  ): Promise<MutationProposal<LlmAnalystProposalPayload>[]> {
    if (events.length === 0) return [];

    const summary = summarizeEvents(events, this.config.chapterDimension);

    let raw: string;
    try {
      const result = await this.bedrock.invoke({
        model: this.config.model,
        systemPrompt: ANALYST_SYSTEM,
        userPrompt: buildUserPrompt(this.config, window, summary),
        maxTokens: 1500,
      });
      raw = result.text;
    } catch (err) {
      // Telemetry analysis must never crash the loop — degrade to no proposals.
      // eslint-disable-next-line no-console
      console.warn(`[loops/llm-analyst] invoke failed for ${this.loopId}:`, String(err));
      return [];
    }

    const issues = parseIssues(raw);
    const max = this.config.maxProposals ?? 3;
    const triggerCounts = Object.fromEntries(
      Object.entries(summary.counts).map(([k, v]) => [`${k}_count`, v]),
    );

    return issues.slice(0, max).map((iss, i) => {
      const slug = slugify(iss.title ?? `issue-${i}`);
      const isCode = iss.kind === 'code_change';
      return {
        proposalId: asMutationId(nextProposalId(this.loopId, slug)),
        sourceRuleId: `llm-analyst:${slug}`,
        hypothesis: composeHypothesis(iss),
        kind: isCode ? 'code_change' : 'copy',
        payload: {
          directive: iss.suggestedFix ?? '',
          targetArea: iss.title,
          // Never auto-ship code changes; only the LLM-flagged low-risk copy.
          autoShipSafe: iss.autoShipSafe === true && !isCode,
        },
        triggeringStats: {
          ...triggerCounts,
          analyst: 'llm',
          severity: iss.severity ?? 'med',
          ...(iss.evidence ? { evidence: String(iss.evidence).slice(0, 500) } : {}),
        },
      };
    });
  }
}
