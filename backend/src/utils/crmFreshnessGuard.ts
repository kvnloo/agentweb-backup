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
  /** An account-wide list/lead total whose number is in none of this turn's CRM tool results (nor a sum of them). */
  | 'inventory_total_not_in_tool_results';

export interface CrmFreshnessFinding {
  kind: CrmFreshnessFindingKind;
  /** The tag as written, markup stripped, capped. */
  tag: string;
  cited: string[];
  /** For inventory_total_not_in_tool_results: the number the reply stated. */
  claimed?: number;
}

export interface CrmFreshnessResult {
  findings: CrmFreshnessFinding[];
  /** CRM tools that ran AND succeeded this turn, distinct. */
  crmToolsSucceeded: string[];
  tagsSeen: number;
}

// Every quantifier below is BOUNDED and the input is capped: an unbounded `[^\]]*` rescans to the end of the
// text from every unclosed `[verified`, which is quadratic (measured: 100KB of them blocked the event loop
// for 1.5s, 500KB for 37s). This runs synchronously on every reply, so it must stay linear.
const TAG = /\[verified[^\]]{0,300}\]/gi;
const MAX_TEXT_CHARS = 200_000;
const MAX_TAGS_SCANNED = 200;
// A tag that already says it is not fresh is the honest form — nothing to flag.
const ALREADY_LABELLED = /\b(earlier|previous|prior|before|stale|out of date|outdated|last turn|from the conversation)\b/i;
const MAX_TAG_CHARS = 120;
// The model sometimes talks ABOUT the tag ("I can't include the [verified: ...] tag because no tool ran").
// That is the honest behaviour, not a claim — a tag followed by "tag"/"label" or introduced by an
// article/verb of using is a mention. Bare `[verified]` (no tool named) is deliberately not judged: in
// the replay it caught nothing the cited rule missed, and it is what misfired on this commentary.
const MENTION_AFTER = /^\s*(tag|label|marker|badge|notation|annotation)s?\b/i;
const MENTION_BEFORE = /\b(the|a|this|that|any|use|using|used|include|including|add|adding|attach|attaching|apply|applying|carry|put)\s+$/i;

// Linear-time tag stripper. A regex like /<[^>]*>/g rescans to the end from every unclosed "<"; here the
// next ">" is cached, so each character is visited a bounded number of times. A "<" with no ">" within
// MAX_MARKUP_CHARS is literal text (e.g. "5 < 6"), not markup.
const MAX_MARKUP_CHARS = 1000;
function stripMarkup(text: string): string {
  const out: string[] = [];
  let i = 0;
  let gt = -2;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { out.push(text.slice(i)); break; }
    if (gt < lt) {
      gt = text.indexOf('>', lt);
      if (gt === -1) { out.push(text.slice(i)); break; }
    }
    if (gt - lt <= MAX_MARKUP_CHARS) {
      out.push(text.slice(i, lt));
      i = gt + 1;
    } else {
      out.push(text.slice(i, lt + 1));
      i = lt + 1;
    }
  }
  return out.join('').replace(/`/g, '');
}

// ---- Untagged account-wide totals ----------------------------------------------------------------------
// get_lead_lists returns per-list leadCount plus totalLists and NO total-leads field, so a correct "N leads in
// total" is a SUM the model computed. The check therefore accepts any number that appears in this turn's CRM
// tool results, an array length, the sum of leadCount, or the sum of per-call match counts. Anything else, with
// no honest "earlier / out of date" wording next to it, is a carried-over total.
const MAX_RESULT_NODES = 20_000;
const MAX_CLAIMS = 20;
const CLAIM_LABEL_WINDOW = 140;

/** Numbers a CRM tool result can back: every number in it, array lengths, and the sums a model would compute. */
function numbersFromResult(result: unknown): { numbers: Set<number>; matchCount?: number } {
  const numbers = new Set<number>();
  let nodes = 0;
  let leadCountSum = 0;
  let listObjects = 0;
  const walk = (value: unknown, depth: number): void => {
    if (nodes++ > MAX_RESULT_NODES || depth > 8) return;
    if (typeof value === 'number') { if (Number.isFinite(value)) numbers.add(Math.trunc(value)); return; }
    if (typeof value === 'string') { if (/^\d{1,12}$/.test(value)) numbers.add(Number(value)); return; }
    if (Array.isArray(value)) { numbers.add(value.length); for (const v of value) walk(v, depth + 1); return; }
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o.leadCount === 'number') { leadCountSum += o.leadCount; listObjects++; }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    }
  };
  let parsed: any = result;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return { numbers }; } }
  walk(parsed, 0);
  if (listObjects > 0) { numbers.add(leadCountSum); numbers.add(listObjects); }
  let matchCount: number | undefined;
  if (parsed && typeof parsed === 'object') {
    const c = [parsed.count, parsed.rowCount, parsed.total, parsed.totalCount].find((x) => typeof x === 'number');
    matchCount = typeof c === 'number' ? c : Array.isArray(parsed.leads) ? parsed.leads.length : undefined;
  }
  return { numbers, matchCount };
}

/**
 * What this turn's CRM tool calls actually returned. The tool-call LEDGER cannot be used for this: its stored
 * result is minimised (search/lead tools collapse to `{}`), so a number check against it would flag every
 * correct answer. toolDispatch sees the FULL result before minimising and hands it here; only numbers are kept.
 */
export interface CrmEvidence {
  numbers: Set<number>;
  tools: Set<string>;
}

export interface CrmEvidenceCollector {
  /** Never throws; ignores non-CRM tools and failed results. */
  record(toolName: unknown, fullResult: unknown): void;
  snapshot(): CrmEvidence;
}

export function createCrmEvidenceCollector(): CrmEvidenceCollector {
  const numbers = new Set<number>();
  const tools = new Set<string>();
  let matchCountSum = 0;
  let recorded = 0;
  return {
    record(toolName, fullResult) {
      try {
        if (typeof toolName !== 'string' || !CRM_FRESHNESS_TOOLS.includes(toolName)) return;
        if (recorded++ >= 200) return;
        if (fullResult && typeof fullResult === 'object' && (fullResult as any).success === false) return;
        const r = numbersFromResult(fullResult);
        for (const n of r.numbers) if (numbers.size < 5000) numbers.add(n);
        if (typeof r.matchCount === 'number') { matchCountSum += r.matchCount; numbers.add(matchCountSum); }
        tools.add(toolName);
      } catch { /* evidence is best-effort; a bad result must never reach the turn */ }
    },
    snapshot: () => ({ numbers, tools }),
  };
}

/** Numbers backed by this turn, or null when a CRM tool succeeded but there is nothing to check its numbers against. */
function allowedNumbers(calls: any[], succeeded: Set<string>, evidence?: CrmEvidence): Set<number> | null {
  const allowed = new Set<number>(evidence?.numbers ?? []);
  let matchCountSum = 0;
  const coveredByLedger = new Set<string>();
  for (const call of calls) {
    if (!call || typeof call.name !== 'string' || !succeeded.has(call.name) || !toolCallSucceeded(call)) continue;
    const r = numbersFromResult(call.result);
    if (r.numbers.size > 0) coveredByLedger.add(call.name);
    for (const n of r.numbers) allowed.add(n);
    if (typeof r.matchCount === 'number') { matchCountSum += r.matchCount; allowed.add(matchCountSum); }
  }
  for (const tool of succeeded) {
    if (!evidence?.tools.has(tool) && !coveredByLedger.has(tool)) return null;
  }
  return allowed;
}

const NUM = '(\\d[\\d,]{0,14})';
// "N lists", "N lead lists", "total lead lists: N", "N leads in total", "N leads across K lists / your CRM".
// Deliberately NOT "N leads across all lists": that is how a filtered search total is phrased.
const INVENTORY_PATTERNS: RegExp[] = [
  new RegExp(`\\b${NUM}\\s+(?:total\\s+)?(?:lead\\s+)?lists\\b`, 'gi'),
  new RegExp(`\\b(?:total|overall)\\s+(?:number\\s+of\\s+)?(?:lead\\s+)?(?:leads|lists|contacts)(?:\\s+across\\s+all\\s+(?:your\\s+)?(?:lead\\s+)?lists)?\\W{0,12}${NUM}`, 'gi'),
  new RegExp(`\\b${NUM}\\s+(?:total\\s+)?leads\\s+(?:in\\s+total|total|in\\s+your\\s+(?:entire\\s+|whole\\s+)?crm)\\b`, 'gi'),
  new RegExp(`\\b${NUM}\\s+leads\\s+(?:across|in)\\s+(?:${NUM}\\s+(?:\\w+\\s+)?lists|your\\s+(?:entire\\s+|whole\\s+)?crm)`, 'gi'),
];

function findInventoryClaims(text: string): Array<{ n: number; at: number }> {
  const out: Array<{ n: number; at: number }> = [];
  for (const re of INVENTORY_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (out.length >= MAX_CLAIMS) return out;
      for (const g of m.slice(1)) {
        if (!g) continue;
        const n = Number(g.replace(/,/g, ''));
        if (Number.isFinite(n)) out.push({ n, at: m.index ?? 0 });
      }
    }
  }
  return out;
}

function citedTools(tag: string): string[] {
  return CRM_FRESHNESS_TOOLS.filter((name) => new RegExp(`(^|[^a-z_])${name}($|[^a-z_])`, 'i').test(tag));
}

export function detectCrmFreshnessMismatch(finalText: unknown, toolCalls: unknown, evidence?: CrmEvidence): CrmFreshnessResult {
  const empty: CrmFreshnessResult = { findings: [], crmToolsSucceeded: [], tagsSeen: 0 };
  if (typeof finalText !== 'string' || !finalText) return empty;

  const calls: any[] = Array.isArray(toolCalls) ? toolCalls : [];
  const succeeded = new Set<string>();
  for (const call of calls) {
    if (call && typeof call.name === 'string' && CRM_FRESHNESS_TOOLS.includes(call.name) && toolCallSucceeded(call)) {
      succeeded.add(call.name);
    }
  }

  const text = stripMarkup(finalText.length > MAX_TEXT_CHARS ? finalText.slice(0, MAX_TEXT_CHARS) : finalText);
  const findings: CrmFreshnessFinding[] = [];
  let tagsSeen = 0;
  for (const match of text.matchAll(TAG)) {
    if (tagsSeen >= MAX_TAGS_SCANNED) break;
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

  const claims = findInventoryClaims(text);
  if (claims.length > 0) {
    // null = a CRM tool ran but its numbers are unavailable: abstain rather than guess.
    const allowed = allowedNumbers(calls, succeeded, evidence);
    if (allowed) {
      const seen = new Set<number>();
      for (const { n, at } of claims) {
        if (allowed.has(n) || seen.has(n)) continue;
        const near = text.slice(Math.max(0, at - CLAIM_LABEL_WINDOW), at + CLAIM_LABEL_WINDOW);
        if (ALREADY_LABELLED.test(near)) continue;
        seen.add(n);
        findings.push({ kind: 'inventory_total_not_in_tool_results', tag: text.slice(at, at + 60), cited: [], claimed: n });
      }
    }
  }
  return { findings, crmToolsSucceeded: [...succeeded].sort(), tagsSeen };
}

export interface CrmFreshnessShadowInput {
  finalText: unknown;
  toolCalls: unknown;
  evidence?: CrmEvidence;
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
    const result = detectCrmFreshnessMismatch(input.finalText, input.toolCalls, input.evidence);
    if (result.findings.length === 0) return [];
    // One line of JSON, so a plain grep / log search / the summarizer script can read it (console.warn(obj)
    // spreads a multi-line dump that log shippers split apart).
    const log = input.log ?? ((message, detail) => console.warn(`${message} ${JSON.stringify(detail)}`));
    log('[crm-freshness-shadow] CRM freshness mismatch (message NOT modified)', {
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
