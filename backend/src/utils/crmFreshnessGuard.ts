/**
 * ENG-2263 — detect a `[verified: <CRM tool>]` tag that no CRM tool call this turn can back.
 *
 * Emma is told that `[verified]` on a CRM number means a tool call happened in THIS turn. Weaker
 * models restate a number from an earlier turn and still tag it `[verified: get_lead_lists]`
 * (measured on production-selectable models; the default model did not do it).
 *
 * Pure and deterministic: no LLM, no I/O. It only DETECTS — the caller logs. Nothing here
 * rewrites text, so it cannot make an answer worse; it exists to measure how often it happens
 * on real traffic before anyone decides to enforce.
 */
import { toolCallSucceeded } from './toolCallOutcome';

/** CRM reads whose result is what a `[verified: ...]` tag on a CRM number should cite. */
export const CRM_FRESHNESS_TOOLS: readonly string[] = [
  'get_lead_lists',
  'get_leads',
  'search_leads',
  'ask_crm',
  'get_lead_details',
  'get_leads_needing_followup',
  'get_hot_leads',
];

export type CrmFreshnessFindingKind =
  /** The tag names a CRM tool, and none of the tools it names succeeded this turn. */
  'cited_tool_not_run';

export interface CrmFreshnessFinding {
  kind: CrmFreshnessFindingKind;
  /** The tag as written, markup stripped, capped. */
  tag: string;
  cited: string[];
}

export interface CrmFreshnessResult {
  findings: CrmFreshnessFinding[];
  /** CRM tools that ran AND succeeded this turn, distinct. */
  crmToolsSucceeded: string[];
  tagsSeen: number;
}

const TAG = /\[verified[^\]]*\]/gi;
// A tag that already says it is not fresh is the honest form — nothing to flag.
const ALREADY_LABELLED = /\b(earlier|previous|prior|before|stale|out of date|outdated|last turn|from the conversation)\b/i;
const MAX_TAG_CHARS = 120;
// The model sometimes talks ABOUT the tag ("I can't include the [verified: ...] tag because no tool ran").
// That is the honest behaviour, not a claim — a tag followed by "tag"/"label" or introduced by an
// article/verb of using is a mention. Bare `[verified]` (no tool named) is deliberately not judged: in
// the replay it caught nothing the cited rule missed, and it is what misfired on this commentary.
const MENTION_AFTER = /^\s*(tag|label|marker|badge|notation|annotation)s?\b/i;
const MENTION_BEFORE = /\b(the|a|this|that|any|use|using|used|include|including|add|adding|attach|attaching|apply|applying|carry|put)\s+$/i;

function stripMarkup(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/`/g, '');
}

function citedTools(tag: string): string[] {
  return CRM_FRESHNESS_TOOLS.filter((name) => new RegExp(`(^|[^a-z_])${name}($|[^a-z_])`, 'i').test(tag));
}

export function detectCrmFreshnessMismatch(finalText: unknown, toolCalls: unknown): CrmFreshnessResult {
  const empty: CrmFreshnessResult = { findings: [], crmToolsSucceeded: [], tagsSeen: 0 };
  if (typeof finalText !== 'string' || !finalText) return empty;

  const calls: any[] = Array.isArray(toolCalls) ? toolCalls : [];
  const succeeded = new Set<string>();
  for (const call of calls) {
    if (call && typeof call.name === 'string' && CRM_FRESHNESS_TOOLS.includes(call.name) && toolCallSucceeded(call)) {
      succeeded.add(call.name);
    }
  }

  const text = stripMarkup(finalText);
  const findings: CrmFreshnessFinding[] = [];
  let tagsSeen = 0;
  for (const match of text.matchAll(TAG)) {
    tagsSeen++;
    const tag = match[0];
    if (ALREADY_LABELLED.test(tag)) continue;
    const at = match.index ?? 0;
    if (MENTION_AFTER.test(text.slice(at + tag.length, at + tag.length + 24))) continue;
    if (MENTION_BEFORE.test(text.slice(Math.max(0, at - 24), at))) continue;
    const cited = citedTools(tag);
    if (cited.length > 0 && !cited.some((name) => succeeded.has(name))) {
      findings.push({ kind: 'cited_tool_not_run', tag: tag.slice(0, MAX_TAG_CHARS), cited });
    }
  }
  return { findings, crmToolsSucceeded: [...succeeded].sort(), tagsSeen };
}

export interface CrmFreshnessShadowInput {
  finalText: unknown;
  toolCalls: unknown;
  sessionId?: string;
  model?: string;
  log?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * Log-only entry point for the agent loop. Kill switch: AGENT_CRM_FRESHNESS_GUARD=off.
 * Never throws and never touches the message; returns the findings for tests.
 */
export function runCrmFreshnessShadow(input: CrmFreshnessShadowInput): CrmFreshnessFinding[] {
  try {
    if (process.env.AGENT_CRM_FRESHNESS_GUARD === 'off') return [];
    const result = detectCrmFreshnessMismatch(input.finalText, input.toolCalls);
    if (result.findings.length === 0) return [];
    const log = input.log ?? ((message, detail) => console.warn(message, detail));
    log('[crm-freshness-shadow] verified tag not backed by a CRM tool call this turn (message NOT modified)', {
      sessionId: input.sessionId,
      model: input.model,
      kinds: [...new Set(result.findings.map((f) => f.kind))],
      findingCount: result.findings.length,
      tagsSeen: result.tagsSeen,
      crmToolsSucceeded: result.crmToolsSucceeded,
      sample: result.findings[0],
    });
    return result.findings;
  } catch {
    return [];
  }
}
