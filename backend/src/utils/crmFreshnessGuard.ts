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
  | 'cited_tool_not_run'
  /** The tag names no tool, sits next to CRM wording, and no CRM tool succeeded this turn. */
  | 'bare_tag_no_crm_tool';

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
const CRM_WORDING = /\b(leads?|lists?|crm|contacts?|pipeline)\b/i;
const MAX_TAG_CHARS = 120;
const CONTEXT_CHARS = 200;

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
    const cited = citedTools(tag);
    if (cited.length > 0) {
      if (!cited.some((name) => succeeded.has(name))) {
        findings.push({ kind: 'cited_tool_not_run', tag: tag.slice(0, MAX_TAG_CHARS), cited });
      }
      continue;
    }
    if (succeeded.size === 0) {
      const at = match.index ?? 0;
      const around = text.slice(Math.max(0, at - CONTEXT_CHARS), at + tag.length + CONTEXT_CHARS);
      if (CRM_WORDING.test(around)) {
        findings.push({ kind: 'bare_tag_no_crm_tool', tag: tag.slice(0, MAX_TAG_CHARS), cited: [] });
      }
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
