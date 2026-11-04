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
  'get_lead_conversation_statuses',
  'get_hot_leads',
];

/** CRM tools that CHANGE the totals; a total restated after one of these is not comparable to an earlier read. */
const CRM_WRITE_TOOLS: readonly string[] = [
  'create_lead_list', 'add_leads_to_list', 'update_lead_list', 'delete_lead_list', 'delete_leads', 'delete_leads_by_filter',
  'import_leads_from_search', 'import_leads', 'enrich_leads_execute', 'create_lead', 'update_lead', 'update_lead_status',
];

export type CrmFreshnessFindingKind =
  /** The tag names a CRM tool, and none of the tools it names succeeded this turn. */
  | 'cited_tool_not_run'
  /** An account-wide list/lead total whose number is in none of this turn's CRM tool results (nor a sum of them). */
  | 'inventory_total_not_in_tool_results';

export interface CrmFreshnessFinding {
  kind: CrmFreshnessFindingKind;
  /** Tool names the tag cited. NEVER reply text: findings are logged, and replies contain customer data. */
  cited: string[];
  /** For inventory_total_not_in_tool_results: the number the reply stated. */
  claimed?: number;
  /** The claim is within 0.5% (min 1) of a number the tool results do back: arithmetic drift, not a stale or invented total. */
  drift?: true;
  /**
   * The claimed number equals a CRM number an EARLIER turn of this session really returned (persisted crmEvidence) and this turn's tools
   * do not back it: the reply restated an old value. Absent = no earlier evidence matched (which includes sessions saved before
   * evidence was persisted), not "not stale".
   */
  echoesEarlier?: true;
}

export interface CrmFreshnessResult {
  findings: CrmFreshnessFinding[];
  /** CRM tools that ran AND succeeded this turn, distinct. */
  crmToolsSucceeded: string[];
  tagsSeen: number;
  /** Inventory-total claims found in the reply (before any backing check). */
  claimsSeen: number;
  /** Claims were found but the total check abstained (a CRM write ran, or earlier evidence is missing). */
  totalsAbstained: boolean;
}

// Every quantifier below is BOUNDED and the input is capped: an unbounded `[^\]]*` rescans to the end of the
// text from every unclosed `[verified`, which is quadratic (measured: 100KB of them blocked the event loop
// for 1.5s, 500KB for 37s). This runs synchronously on every reply, so it must stay linear.
const TAG = /\[verified[^\]]{0,300}\]/gi;
const MAX_TEXT_CHARS = 200_000;
const MAX_TAGS_SCANNED = 200;
// A tag that already says it is not fresh is the honest form — nothing to flag.
const ALREADY_LABELLED = /\b(earlier|previous(?:ly)?|stale|out of date|outdated|last turn|from the conversation|unverified|(?:a few |some )?(?:moments?|minutes?|seconds?) ago|(?:a )?(?:while|bit) ago|just now|prior (?:check|lookup|query|answer|analysis|turn|message|result|run|response)|not (?:re-?)?(?:checked|verified|queried|run|refreshed)|(?:from|per|in|on) (?:our|my|the) (?:last |earlier |previous |prior )?(?:check|lookup|query|session|conversation))\b/i;
// The model sometimes talks ABOUT the tag ("I can't include the [verified: ...] tag because no tool ran").
// That is the honest behaviour, not a claim — a tag followed by "tag"/"label" or introduced by an
// article/verb of using is a mention. Bare `[verified]` (no tool named) is deliberately not judged: in
// the replay it caught nothing the cited rule missed, and it is what misfired on this commentary.
const MENTION_AFTER = /^\s*(tag|label|marker|badge|notation|annotation)s?\b/i;
const MENTION_BEFORE = /\b(the|a|this|that|any|use|using|used|include|including|add|adding|attach|attaching|apply|applying|carry|put)\s+$/i;

// Linear-time tag stripper. A regex like /<[^>]*>/g rescans to the end from every unclosed "<"; here the
// next ">" is cached, so each character is visited a bounded number of times. A "<" with no ">" within
// MAX_MARKUP_CHARS is literal text (e.g. "5 < 6"), not markup.
// Emma replies are HTML: a block tag (</p>, <li>, <br> ...) must become a line break, otherwise "...:</p><ul><li>Total lead
// lists: 97</li><li>Total leads: 15,480" collapses into "...:Total lead lists: 97Total leads: 15,480" and neither the numbers nor
// the "From our check earlier:" lead-in can be read. Inline tags (<strong>, <code>) vanish without a trace.
const MAX_MARKUP_CHARS = 1000;
const BLOCK_TAG = /^<\/?\s*(?:p|div|li|ul|ol|br|tr|td|th|table|tbody|thead|h[1-6]|blockquote|section|hr|pre)\b/i;
function stripMarkup(text: string): string {
  const out: string[] = [];
  let endsWithNewline = true;
  const push = (chunk: string): void => {
    if (!chunk) return;
    out.push(chunk);
    endsWithNewline = chunk.charCodeAt(chunk.length - 1) === 10;
  };
  let i = 0;
  let gt = -2;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { push(text.slice(i)); break; }
    if (gt < lt) {
      gt = text.indexOf('>', lt);
      if (gt === -1) { push(text.slice(i)); break; }
    }
    if (gt - lt <= MAX_MARKUP_CHARS) {
      push(text.slice(i, lt));
      i = gt + 1;
      const head = text.slice(lt, Math.min(gt + 1, lt + 24));
      if (BLOCK_TAG.test(head)) {
        if (!endsWithNewline) push('\n');
        // An opening <li> becomes a bullet, so the items of a list stay recognisable as a run under their lead-in line.
        if (/^<\s*li\b/i.test(head)) push('\u2022 ');
        // The whitespace a model puts BETWEEN two tags is formatting, not a paragraph break.
        let j = i;
        while (j < text.length && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 10 || text.charCodeAt(j) === 13 || text.charCodeAt(j) === 9)) j++;
        if (j < text.length && text.charCodeAt(j) === 60) i = j;
      }
    } else {
      push(text.slice(i, lt + 1));
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
// An honest label only excuses a claim when it is in the SAME sentence (a label two sentences away is about
// something else: "Your last import was 2 days ago. You have 18 lead lists.").
function sentenceAround(text: string, at: number, maxEachSide = 160): string {
  let a = at;
  const lo = Math.max(0, at - maxEachSide);
  while (a > lo && !'.!?\n'.includes(text[a - 1] as string)) a--;
  let b = at;
  const hi = Math.min(text.length, at + maxEachSide);
  while (b < hi && !'.!?\n'.includes(text[b] as string)) b++;
  // keep a trailing parenthetical that closes the sentence: "...(from our check earlier)."
  return text.slice(a, b);
}

// Only count-like fields can back a total. Accepting EVERY number in a result masks stale totals: lead rows carry
// icpScore / engagementCount / dealValue / phone digits, so for a 20-lead page ~1 in 3 numbers up to 100 would be
// "backed" by coincidence (measured by the PR #3351 review).
const COUNT_KEYS = new Set([
  'count', 'rowCount', 'total', 'totalCount', 'totalLists', 'totalLeads', 'totalConsidered', 'scanned', 'matchCount',
  'leadCount', 'listCount', 'returned', 'totalMatches', 'resultCount',
]);

/** Numbers a CRM tool result can back: its count fields, array lengths, and the sums a model would compute. */
function numbersFromResult(result: unknown): { numbers: Set<number>; matchCount?: number } {
  const numbers = new Set<number>();
  const listIds = new Set<string>();
  let nodes = 0;
  let leadCountSum = 0;
  let listObjects = 0;
  const walk = (value: unknown, depth: number): void => {
    if (nodes++ > MAX_RESULT_NODES || depth > 8) return;
    if (Array.isArray(value)) {
      numbers.add(value.length);
      for (const v of value) { if (nodes > MAX_RESULT_NODES) return; walk(v, depth + 1); }
      return;
    }
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o.leadCount === 'number') { leadCountSum += o.leadCount; listObjects++; }
      if (typeof o.listId === 'string' && listIds.size < 5000) listIds.add(o.listId);
      for (const k of Object.keys(o)) {
        const v = o[k];
        // A per-list `leadCount` only counts through the SUM below: accepting each list's own count would let "8 lead lists"
        // be "backed" because some list happens to hold 8 leads. At the top level (a single-list result) it is the answer.
        if (typeof v === 'number') { if (COUNT_KEYS.has(k) && Number.isFinite(v) && !(k === 'leadCount' && depth > 0)) numbers.add(Math.trunc(v)); }
        else if (typeof v === 'string') { if (COUNT_KEYS.has(k) && /^\d{1,12}$/.test(v)) numbers.add(Number(v)); }
        else walk(v, depth + 1);
      }
    }
  };
  let parsed: any = result;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return { numbers }; } }
  walk(parsed, 0);
  if (listObjects > 0) { numbers.add(leadCountSum); numbers.add(listObjects); }
  // "Found 20 leads across 3 lists": distinct lists the returned leads belong to.
  if (listIds.size > 1) numbers.add(listIds.size);
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

/** What is persisted on the assistant message so a LATER invocation of the same task can check its totals. */
export interface PersistedCrmEvidence {
  tools: string[];
  numbers: number[];
  truncated?: true;
}
const MAX_PERSISTED_NUMBERS = 64;

/** Numbers and CRM tool names only. Never reply text, lead rows or names: this lands in the customer's chat history. */
export function serializeCrmEvidence(evidence: CrmEvidence | undefined): PersistedCrmEvidence | undefined {
  try {
    if (!evidence || evidence.tools.size === 0) return undefined;
    const nums = [...evidence.numbers].filter((n) => Number.isSafeInteger(n) && n >= 0).sort((a, b) => a - b);
    return {
      tools: [...evidence.tools].filter((t) => CRM_FRESHNESS_TOOLS.includes(t)).sort(),
      numbers: nums.slice(0, MAX_PERSISTED_NUMBERS),
      ...(nums.length > MAX_PERSISTED_NUMBERS ? { truncated: true as const } : {}),
    };
  } catch {
    return undefined;
  }
}

const MAX_SESSION_NUMBERS = 2000;

/** Every CRM number the EARLIER turns of this session really returned (numbers only, from persisted per-message evidence). */
export function crmNumbersFromSessionHistory(history: unknown): Set<number> {
  const out = new Set<number>();
  try {
    if (!Array.isArray(history)) return out;
    const msgs = history.length > MAX_HISTORY_SCANNED ? history.slice(-MAX_HISTORY_SCANNED) : history;
    for (const m of msgs) {
      if (!isRecord(m) || m.role !== 'assistant' || !isRecord(m.metadata)) continue;
      const ev = validPersistedEvidence(m.metadata.crmEvidence);
      if (!ev) continue;
      for (const n of ev.numbers) if (out.size < MAX_SESSION_NUMBERS) out.add(n);
    }
  } catch { /* best effort: no earlier numbers just means echoesEarlier stays unset */ }
  return out;
}

/** Numbers backed by this turn, or null when a CRM tool succeeded but there is nothing to check its numbers against. */
function allowedNumbers(calls: any[], succeeded: Set<string>, evidence?: CrmEvidence): Set<number> | null {
  for (const call of calls) {
    if (call && typeof call.name === 'string' && CRM_WRITE_TOOLS.includes(call.name) && toolCallSucceeded(call)) return null;
  }
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

// ---- Count tokens: "47", "1,234", "1.2k", "12 thousand", "twelve", "forty-seven" ------------------------------------------
const WORD_ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const WORD_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const START_WORDS = [...Object.keys(WORD_ONES), ...Object.keys(WORD_TENS)].join('|');
// Every quantifier is bounded (see the ReDoS note at the top): at most 6 following words, 1-3 separators between them.
const NUM = `(\\d[\\d,]{0,14}(?:\\.\\d{1,2})?(?:\\s?(?:k|thousand|million)\\b)?|(?:${START_WORDS})(?:[\\s-]{1,3}(?:${START_WORDS}|hundred|thousand|and)){0,6})`;

interface CountRange { lo: number; hi: number; mid: number }
const HEDGE_BEFORE = /\b(about|around|roughly|approximately|approx\.?|nearly|almost|over|under|some|circa)\s+$|~\s*$/i;

/** "1.2k" -> [1150,1250); "forty-seven" -> 47; "about 40" (hedged round number) -> [35,45). null if unparseable. */
function parseCount(raw: string, hedged: boolean): CountRange | null {
  const t = raw.trim().toLowerCase();
  let value: number;
  let half = 0;
  const m = /^(\d[\d,]*)(?:\.(\d{1,2}))?(?:\s?(k|thousand|million))?$/.exec(t);
  if (m) {
    const intPart = (m[1] as string).replace(/,/g, '');
    const frac = m[2] ?? '';
    const unit = m[3] === 'million' ? 1_000_000 : m[3] ? 1_000 : 1;
    value = Number(`${intPart}${frac ? '.' + frac : ''}`) * unit;
    if (!Number.isFinite(value)) return null;
    value = Math.round(value);
    if (unit > 1) half = (unit / 10 ** frac.length) / 2; // "1.2k" is rounded to the nearest hundred
    else if (frac) return null; // a decimal count of leads is not a count
  } else {
    const words = t.split(/[\s-]+/).filter((w) => w && w !== 'and');
    if (words.length === 0) return null;
    let total = 0;
    let current = 0;
    for (const w of words) {
      if (w in WORD_ONES) current += WORD_ONES[w] as number;
      else if (w in WORD_TENS) current += WORD_TENS[w] as number;
      else if (w === 'hundred') current = (current || 1) * 100;
      else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
      else return null;
    }
    value = total + current;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1e9) return null;
  if (half === 0 && hedged && value >= 20) {
    // "about 40" means 40 to the nearest ten, "about 1,200" to the nearest hundred: precision = the trailing zeros it was written with.
    let zeros = 0;
    for (let v = value; v % 10 === 0 && zeros < 6; v = v / 10) zeros++;
    if (zeros > 0) half = 10 ** zeros / 2;
  }
  return { lo: value - half, hi: value + half - (half > 0 ? 1 : 0), mid: value };
}

// "N lists", "N lead lists", "total lead lists: N", "N leads in total", "Lead lists: N", "N leads across K lists / your CRM",
// "Your CRM has N leads", "You have N leads." Deliberately NOT "N leads across all lists": that is how a filtered search total is phrased.
const HEDGE = '(?:(?:about|around|roughly|approximately|approx\\.?|nearly|almost|over|some)\\s+)?';
// pluralOnly: the pattern is only grammatical for a count above one ("N lists", "N leads"), so a claim of 1 there is a verb
// ("No one lists the prices"), not a count.
interface InventoryPattern { re: RegExp; needsCrmContext: boolean; pluralOnly: boolean; /** also reads as a per-category row in a breakdown: skipped inside parentheses or after a row label */ subsetProne?: boolean; /** 'Some Qualifier Lead Lists: N' is a category row when a qualifier word precedes the label */ rowLabelProne?: boolean }
const INVENTORY_PATTERNS: InventoryPattern[] = [
  { pluralOnly: true, needsCrmContext: false, subsetProne: true, re: new RegExp(`\\b${NUM}\\s+(?:total\\s+)?(?:(?:lead|crm)\\s+)?lists\\b`, 'gi') },
  { pluralOnly: false, needsCrmContext: true, re: new RegExp(`\\b(?:total|overall)\\s+(?:number\\s+of\\s+)?(?:lead\\s+)?(?:leads|lists|contacts)(?:\\s+across\\s+all\\s+(?:your\\s+)?(?:lead\\s+)?lists)?[ \\t:*\\-\u2013\u2014]{0,12}${NUM}\\b(?![.)]\\s)`, 'gi') },
  { pluralOnly: true, needsCrmContext: true, re: new RegExp(`\\b${NUM}\\s+(?:total\\s+)?leads\\s+(?:in\\s+total|total|in\\s+your\\s+(?:entire\\s+|whole\\s+)?crm)\\b`, 'gi') },
  { pluralOnly: false, needsCrmContext: false, rowLabelProne: true, re: new RegExp(`\\b(?:total |overall )?(?:number of )?lead lists[ \\t:*\\-\u2013\u2014]{1,12}${NUM}\\b(?![.)]\\s)`, 'gi') },
  { pluralOnly: true, needsCrmContext: false, subsetProne: true, re: new RegExp(`\\b${NUM}\\s+leads\\s+(?:across|in)\\s+(?:${NUM}\\s+(?:\\w+\\s+)?lists|your\\s+(?:entire\\s+|whole\\s+)?crm)`, 'gi') },
  // "Your CRM currently has / contains / holds about 1.2k leads"
  { pluralOnly: true, needsCrmContext: false, re: new RegExp(`\\b(?:crm|account|database|pipeline)\\b(?:\\s+(?:currently|now|account|database|data|total|overall|also|still|right\\s+now|as\\s+a\\s+whole))*\\s+(?:size\\s+(?:is|remains?|stays?|stands at)|has|have|contains?|holds?|includes?|stands at|totals?|is at|comes? to)\\s+${HEDGE}${NUM}\\s+(?:total\\s+)?(?:leads|contacts|records|lists)\\b`, 'gi') },
  // "a total of 4,999 leads", "with a total of twelve lead lists", "a combined count of 12,746 leads" (seen from a scheduled run)
  { pluralOnly: true, needsCrmContext: true, re: new RegExp(`\\b(?:total|(?:combined|overall|aggregate)\\s+(?:count|total|number))\\s+of\\s+${HEDGE}${NUM}\\s+(?:lead\\s+)?(?:leads|contacts|records|lists)\\b`, 'gi') },
  // "You have 47 leads." (a bare statement, not "5 leads named Test" / "3 leads needing follow-up")
  { pluralOnly: true, needsCrmContext: true, re: new RegExp(`\\byou\\s+(?:currently\\s+|now\\s+)?(?:have|hold|manage)\\s+${HEDGE}${NUM}\\s+(?:total\\s+)?(?:leads|contacts|records)\\b(?=\\s*(?:[.,;:!)\\]]|$|in\\s+total|overall|altogether|in\\s+your|across\\s+(?:all\\s+)?(?:your\\s+)?(?:\\d+\\s+|\\w+\\s+)?(?:lists|the\\s+crm)))`, 'gi') },
];

const SUBSET_BEFORE = /\b(remaining|other|another|rest of(?: the)?|empty|those|these|all but|except(?: for)?|plus|new|created|added|imported|built|made|found|[\d,]+(?:\.\d+)?k?\s+(?:total\s+)?(?:leads?\s+|contacts?\s+)?across)\s+$/i;
// "N leads in total" / "Total leads: N" also describe a Apollo search, an import, a pasted list. Count them as an account
// total only when CRM wording is in the same sentence.
const CRM_CONTEXT = /\b(crm|lead lists?|your lists?|all (?:of )?(?:your )?lists|across (?:all )?(?:your |the )?(?:\d+ )?(?:lead )?lists|pipeline|contacts? database)\b/i;

// CRM wording anywhere in the same paragraph (a bullet list is one paragraph) - not just the same line.
function paragraphAround(text: string, at: number, maxEachSide = 300): string {
  const lo = Math.max(0, at - maxEachSide);
  const hi = Math.min(text.length, at + maxEachSide);
  const win = text.slice(lo, hi); // search inside the window: an unbounded lastIndexOf/indexOf per claim is quadratic on long unbroken text
  const rel = at - lo;
  const before = win.lastIndexOf('\n\n', rel);
  const after = win.indexOf('\n\n', rel);
  return win.slice(before === -1 ? 0 : before, after === -1 ? win.length : after);
}

// A label that introduces the whole account ("Summary:", "Your CRM:", "Total:") keeps its claim; any other "Label: 23 leads across 2 lists" row
// ("Calendly Bookings: ...") describes one group.
const WHOLE_ACCOUNT_LABEL = /\b(total|overall|crm|your|account|all|entire|summary|snapshot|overview|status|current|now|result|inventory)\b/i;
// "Six lists account for 14,829 of your contacts": the lists the sentence goes on to single out, not how many there are.
const SUBSET_AFTER = /^\s*(?:account(?:s|ed)?\s+for|make\s+up|represent|together|combined|each|alone)\b/i;
// "Landing Page Lead Lists: 15+ ...": a qualifier word in front of the label makes it a category row. Bare / Total / Overall / Number of keep the claim.
const LABEL_FILLER = new Set(['your', 'the', 'our', 'my', 'a', 'an', 'of', 'all', 'in', 'is', 'are', 'and', 'now', 'currently', 'with', 'total', 'overall', 'number', 'by', 'for', 'to', 'has', 'have', 'show', 'shows', 'showing']);
const QUALIFIED_LABEL_BEFORE = { test(before: string): boolean {
  const w = /([A-Za-z][A-Za-z&-]*)[ \t]+$/.exec(before);
  return !!w && !LABEL_FILLER.has(w[1].toLowerCase());
} };
function inBreakdownRow(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const before = text.slice(Math.max(lineStart, at - 200), at);
  let depth = 0;
  for (const ch of before) { if (ch === '(') depth++; else if (ch === ')' && depth > 0) depth--; }
  if (depth > 0) return true; // "Test & QA (~110 leads across 25 lists)"
  const label = /^[\s\-*\u2022\d.)]*([^:\n]{1,80}):\s*$/.exec(before);
  return !!label && !WHOLE_ACCOUNT_LABEL.test(label[1]);
}

function findInventoryClaims(text: string): Array<CountRange & { at: number }> {
  const out: Array<CountRange & { at: number }> = [];
  for (const { re, needsCrmContext, pluralOnly, subsetProne, rowLabelProne } of INVENTORY_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (out.length >= MAX_CLAIMS) return out;
      const at = m.index ?? 0;
      if (needsCrmContext && !(CRM_CONTEXT.test(sentenceAround(text, at)) || CRM_CONTEXT.test(paragraphAround(text, at)))) continue;
      // "Remaining 15 lists: 0 leads" / "the other 4 lists" is a breakdown of a subset, not the account total.
      if (SUBSET_BEFORE.test(text.slice(Math.max(0, at - 24), at))) continue;
      if (rowLabelProne && QUALIFIED_LABEL_BEFORE.test(text.slice(Math.max(0, at - 40), at))) continue;
      if (subsetProne && /\blists\b/i.test(m[0]) && (inBreakdownRow(text, at) || SUBSET_AFTER.test(text.slice(at + m[0].length, at + m[0].length + 24)))) continue;
      for (const g of m.slice(1)) {
        if (!g) continue;
        const gAt = m[0].indexOf(g);
        const hedged = HEDGE_BEFORE.test(text.slice(Math.max(0, at + Math.max(0, gAt) - 24), at + Math.max(0, gAt)));
        const range = parseCount(g, hedged);
        if (range && !(pluralOnly && range.mid === 1)) out.push({ ...range, at });
      }
    }
  }
  return out;
}

/** Within 0.5% (at least 1) of a backed number, but not equal: the model mis-added a column it really had. */
function nearBacked(allowed: ReadonlySet<number>, n: number): boolean {
  const tol = Math.max(1, Math.round(n * 0.005));
  for (const a of allowed) if (a !== n && Math.abs(a - n) <= tol && a >= 10) return true;
  return false;
}

/** Is any backed number inside [lo, hi]? Exact claims are a Set lookup; rounded ones scan the (small) set. */
function backed(allowed: ReadonlySet<number>, lo: number, hi: number): boolean {
  if (lo === hi) return allowed.has(lo);
  for (const n of allowed) if (n >= lo && n <= hi) return true;
  return false;
}

// ---- Work that spans several invocations -------------------------------------------------------------------
// One user-visible task can be several generateMarketingResponse invocations: a server-authored auto-continuation, an answer
// to a question/approval card that halted the run, or the user asking to "continue". Each invocation persists a small
// numbers-only `metadata.crmEvidence` on its closing assistant message, so a later invocation of the SAME task can check its
// totals against what the task's earlier CRM calls really returned. Where that evidence is missing (messages saved before this
// existed, a truncated record, a CRM write in between) the total check abstains instead of guessing. A plain follow-up question
// is NOT a continuation: carrying a number over from an earlier turn is exactly the failure this detector exists to see.
const MAX_HISTORY_SCANNED = 120;
const MAX_TOOLCALLS_PER_MESSAGE = 200;

export interface EarlierInvocationEvidence {
  /** CRM tools that ran and succeeded in earlier invocations of the task this one continues. */
  tools: string[];
  /** Numbers those calls returned (only what was persisted). */
  numbers: Set<number>;
  /** True when every CRM call in the earlier invocations has its numbers recorded, so totals can be checked against them. */
  complete: boolean;
}
const NO_EARLIER_EVIDENCE: EarlierInvocationEvidence = { tools: [], numbers: new Set(), complete: true };

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// What a person types to resume: "continue", "go on", "keep going", "ok proceed" ... and nothing else of substance.
const CONTINUE_REQUEST = /^(?:(?:ok(?:ay)?|yes|yep|sure|please|pls|thanks?|great)[\s,.!-]+){0,2}(?:continue|go on|keep going|carry on|proceed|resume|go ahead|pick (?:it )?up|keep at it)(?:[\s,]+(?:please|pls|thanks?|thank you|now|then|again|with (?:that|it|this|the rest(?: of (?:it|that|this))?)|from there|on that|where you (?:left off|stopped)|from where you (?:left off|stopped)))*[\s,.!]*$/i;

/** A typed "continue" (short, and says nothing else). Anything longer is a new request that happens to start that way. */
export function looksLikeContinueRequest(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  if (!t || t.length > 60) return false;
  if (t.split(/\s+/).length > 8) return false;
  return CONTINUE_REQUEST.test(t);
}

/** Does this user message continue earlier work rather than start a new request? */
function userMessageContinuesEarlierWork(user: Record<string, any>): boolean {
  const md = isRecord(user.metadata) ? user.metadata : {};
  if (md.kind === 'auto-continuation') return true;
  if (md.askUserQuestionAnswer || md.approvalDeckAnswer || md.approvalDeckCancelled) return true;
  // The server tells people to 'reply "continue"' after a time-limit partial, a step-budget stop, and a whole-turn timeout.
  // Only the first leaves a marker, so the typed words are what decides - and a marker alone no longer does: someone who
  // ignores the partial and asks something new is not continuing.
  return looksLikeContinueRequest(user.content);
}

function validPersistedEvidence(v: unknown): PersistedCrmEvidence | undefined {
  if (!isRecord(v) || !Array.isArray(v.tools) || !Array.isArray(v.numbers)) return undefined;
  return {
    tools: v.tools.filter((t: unknown): t is string => typeof t === 'string' && CRM_FRESHNESS_TOOLS.includes(t)).slice(0, 20),
    numbers: v.numbers.filter((n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)).slice(0, MAX_PERSISTED_NUMBERS),
    ...(v.truncated === true ? { truncated: true as const } : {}),
  };
}

/**
 * What the CRM tools of the EARLIER invocations of the task the current invocation continues returned.
 * `history` is the persisted session; the current user message is normally its last entry. Returns an empty, complete
 * record for a fresh request, so ordinary follow-ups are still fully checked.
 */
export function crmEvidenceFromEarlierInvocations(history: unknown): EarlierInvocationEvidence {
  try {
    if (!Array.isArray(history) || history.length === 0) return NO_EARLIER_EVIDENCE;
    const msgs = history.length > MAX_HISTORY_SCANNED ? history.slice(-MAX_HISTORY_SCANNED) : history;
    const lastIdx = msgs.length - 1;
    const last = msgs[lastIdx];
    // If the current user message is not in the history we cannot tell what this invocation continues.
    if (!isRecord(last) || last.role !== 'user') return NO_EARLIER_EVIDENCE;

    const ran = new Set<string>();       // CRM tools seen succeeding in toolCalls
    const recorded = new Set<string>();  // CRM tools whose numbers were persisted
    const numbers = new Set<number>();
    let truncated = false;
    let wrote = false;
    let unrecordedTimeout = false; // a time-limit partial persists no toolCalls/crmEvidence, so what its turn returned is unrecoverable
    let userIdx = lastIdx;
    for (let guard = 0; guard < MAX_HISTORY_SCANNED; guard++) {
      const user = msgs[userIdx];
      if (!isRecord(user) || !userMessageContinuesEarlierWork(user)) break;

      // Walk back over the earlier invocation(s) of this task, up to the user message that opened them.
      let i = userIdx - 1;
      for (; i >= 0; i--) {
        const m = msgs[i];
        if (!isRecord(m)) continue;
        if (m.role === 'user') break;
        if (m.role !== 'assistant') continue;
        const md = isRecord(m.metadata) ? m.metadata : {};
        const calls = Array.isArray(md.toolCalls) ? md.toolCalls : [];
        for (const tc of calls.slice(0, MAX_TOOLCALLS_PER_MESSAGE)) {
          if (!isRecord(tc) || typeof tc.name !== 'string' || !toolCallSucceeded(tc)) continue;
          if (CRM_FRESHNESS_TOOLS.includes(tc.name)) ran.add(tc.name);
          else if (CRM_WRITE_TOOLS.includes(tc.name)) wrote = true;
        }
        const ev = validPersistedEvidence(md.crmEvidence);
        if (ev) {
          for (const t of ev.tools) recorded.add(t);
          for (const n of ev.numbers) numbers.add(n);
          if (ev.truncated) truncated = true;
        } else if (md.kind === 'generation-timeout-continuation') {
          unrecordedTimeout = true;
        }
      }
      if (i < 0) break;
      userIdx = i; // that user message may itself be a continuation boundary: keep walking
    }
    const tools = [...new Set([...ran, ...recorded])].sort();
    if (tools.length === 0 && !wrote && !unrecordedTimeout) return NO_EARLIER_EVIDENCE;
    // Complete = every CRM tool that ran has its numbers on file, nothing was cut off, and no write changed the totals since.
    const complete = !wrote && !truncated && !unrecordedTimeout && [...ran].every((t) => recorded.has(t));
    return { tools, numbers, complete };
  } catch {
    return NO_EARLIER_EVIDENCE;
  }
}

/** CRM tools that ran in earlier invocations of the task this one continues (names only; see crmEvidenceFromEarlierInvocations). */
export function crmToolsFromEarlierInvocations(history: unknown): string[] {
  return crmEvidenceFromEarlierInvocations(history).tools;
}

// An honest label often sits in a lead-in line that introduces a list ("From our check earlier (not re-queried):") and covers
// every bullet under it. Rules, all deliberately narrow so a label never excuses an unrelated claim:
//  - the lead-in is a NON-bullet line that ends with ":";
//  - a claim on a bullet line is covered by walking up through the unbroken run of bullets directly above it (a blank line ends
//    the run, except between the lead-in and its first bullet);
//  - a claim on a plain line is covered only if the lead-in is the line directly above it.
const BULLET_LINE = /^(?:[-*\u2022]|\d{1,3}[.)])\s/;
const LEAD_IN_END = /:\s*(?:\*\*|__)?$/; // callers pass a trimmed line, so no trailing \s* (two adjacent \s* backtrack quadratically)
function leadInLine(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const lineEndIdx = text.indexOf('\n', at);
  const claimLine = text.slice(lineStart, lineEndIdx === -1 ? text.length : lineEndIdx).trim();
  const claimIsBullet = BULLET_LINE.test(claimLine);
  const lines: string[] = [];
  let end = lineStart - 1; // the newline that ends the previous line
  for (let hops = 0; hops < 14 && end >= 0; hops++) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    lines.push(text.slice(start, end).trim());
    end = start - 1;
  }
  let blankAbove = false; // blank line(s) seen since the last non-blank line, walking upwards
  for (const line of lines) {
    if (!line) { blankAbove = true; continue; }
    if (BULLET_LINE.test(line)) {
      if (!claimIsBullet) return '';          // a plain claim under a list is not part of that list
      if (blankAbove) return '';              // a blank line inside the run ends it
      continue;
    }
    // A non-bullet line: it must be the lead-in. Blank lines directly between it and what follows are fine.
    return LEAD_IN_END.test(line.slice(-300)) ? line : '';
  }
  return '';
}

function citedTools(tag: string): string[] {
  return CRM_FRESHNESS_TOOLS.filter((name) => new RegExp(`(^|[^a-z_])${name}($|[^a-z_])`, 'i').test(tag));
}

function normalizeEarlier(e: EarlierInvocationEvidence | readonly string[] | undefined): EarlierInvocationEvidence {
  if (!e) return NO_EARLIER_EVIDENCE;
  if (Array.isArray(e) || !('numbers' in (e as object))) {
    // A bare list of tool names: the tools ran, but nothing is known about their numbers.
    const tools = [...(e as readonly string[])];
    return tools.length ? { tools, numbers: new Set(), complete: false } : NO_EARLIER_EVIDENCE;
  }
  return e as EarlierInvocationEvidence;
}

export function detectCrmFreshnessMismatch(
  finalText: unknown,
  toolCalls: unknown,
  evidence?: CrmEvidence,
  /** What the earlier invocations of the task this one continues returned (see crmEvidenceFromEarlierInvocations). */
  earlierInput?: EarlierInvocationEvidence | readonly string[],
  /** CRM numbers earlier turns of the session returned (see crmNumbersFromSessionHistory); used only to mark `echoesEarlier`. */
  sessionNumbers?: ReadonlySet<number>,
): CrmFreshnessResult {
  const empty: CrmFreshnessResult = { findings: [], crmToolsSucceeded: [], tagsSeen: 0, claimsSeen: 0, totalsAbstained: false };
  if (typeof finalText !== 'string' || !finalText) return empty;
  const earlier = normalizeEarlier(earlierInput);

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
    if (cited.length > 0 && !cited.some((name) => succeeded.has(name) || earlier.tools.includes(name))) {
      findings.push({ kind: 'cited_tool_not_run', cited });
    }
  }

  const claims = findInventoryClaims(text);
  let totalsAbstained = false;
  if (claims.length > 0) {
    // null = a CRM tool ran but its numbers are unavailable: abstain rather than guess. For a continued task that means an
    // earlier invocation has no persisted evidence (saved before it existed, truncated, or a CRM write changed the totals).
    const current = !earlier.complete ? null : allowedNumbers(calls, succeeded, evidence);
    totalsAbstained = current === null;
    if (current) {
      const allowed = earlier.numbers.size > 0 ? new Set<number>([...current, ...earlier.numbers]) : current;
      const seen = new Set<number>();
      for (const { lo, hi, mid, at } of claims) {
        if (backed(allowed, lo, hi) || seen.has(mid)) continue;
        if (ALREADY_LABELLED.test(sentenceAround(text, at)) || ALREADY_LABELLED.test(leadInLine(text, at))) continue;
        seen.add(mid);
        findings.push({
          kind: 'inventory_total_not_in_tool_results', cited: [], claimed: mid,
          ...(nearBacked(allowed, mid) ? { drift: true as const } : {}),
          ...(sessionNumbers && sessionNumbers.size > 0 && backed(sessionNumbers, lo, hi) ? { echoesEarlier: true as const } : {}),
        });
      }
    }
  }
  return { findings, crmToolsSucceeded: [...succeeded].sort(), tagsSeen, claimsSeen: claims.length, totalsAbstained };
}

export interface CrmFreshnessShadowInput {
  finalText: unknown;
  toolCalls: unknown;
  evidence?: CrmEvidence;
  /** What the earlier invocations of the task this one continues returned (or just their tool names). */
  earlier?: EarlierInvocationEvidence | readonly string[];
  /** CRM numbers earlier turns of this session returned; marks findings that restate one (`echoesEarlier`). */
  sessionNumbers?: ReadonlySet<number>;
  sessionId?: string;
  model?: string;
  /** Messages in the session history at the start of this turn (a size, never content). */
  sessionMessages?: number;
  log?: (message: string, detail: Record<string, unknown>) => void;
  /** Sink for the per-reply "checked" line (the denominator for the flag rate); defaults to console.log. */
  logChecked?: (message: string, detail: Record<string, unknown>) => void;
}

const SMALL_RANGE_MAX = 20;

function validMessageCount(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Share of the integers 0..20 that the session's number set contains. `echoesEarlier` says "this claimed number is in the set";
 * when most small integers are in it, that is expected by chance and says nothing about staleness. Numbers in, one number out.
 */
function smallNumberDensity(numbers: ReadonlySet<number> | undefined): number {
  if (!numbers || numbers.size === 0) return 0;
  let hit = 0;
  for (let n = 0; n <= SMALL_RANGE_MAX; n++) if (numbers.has(n)) hit++;
  return Math.round((hit / (SMALL_RANGE_MAX + 1)) * 100) / 100;
}

/**
 * Log-only entry point for the agent loop. Kill switch: AGENT_CRM_FRESHNESS_GUARD=off.
 * Never throws and never touches the message; returns the findings for tests.
 */
export function runCrmFreshnessShadow(input: CrmFreshnessShadowInput): CrmFreshnessFinding[] {
  try {
    if (process.env.AGENT_CRM_FRESHNESS_GUARD === 'off') return [];
    const result = detectCrmFreshnessMismatch(input.finalText, input.toolCalls, input.evidence, input.earlier, input.sessionNumbers);
    let findings: CrmFreshnessFinding[] = [];
    if (result.findings.length > 0) {
      // One line of JSON, so a plain grep / log search / the summarizer script can read it (console.warn(obj)
      // spreads a multi-line dump that log shippers split apart).
      const log = input.log ?? ((message, detail) => console.warn(`${message} ${JSON.stringify(detail)}`));
      try {
        log('[crm-freshness-shadow] CRM freshness mismatch (message NOT modified)', {
          sessionId: input.sessionId,
          model: input.model,
          kinds: [...new Set(result.findings.map((f) => f.kind))],
          findingCount: result.findings.length,
          tagsSeen: result.tagsSeen,
          crmToolsSucceeded: result.crmToolsSucceeded,
          continuation: normalizeEarlier(input.earlier).tools.length > 0,
          // Numbers and tool names only - never reply text (replies carry names, emails, deal values).
          claimed: [...new Set(result.findings.map((f) => f.claimed).filter((n): n is number => typeof n === 'number'))].slice(0, 10),
          cited: [...new Set(result.findings.flatMap((f) => f.cited))].slice(0, 10),
          drift: result.findings.filter((f) => f.drift).length,
          echoesEarlier: result.findings.filter((f) => f.echoesEarlier).length,
          // ENG-2382: how crowded the session's number set was, so an `echoesEarlier` hit can be told from a coincidence.
          sessionNumberCount: input.sessionNumbers?.size ?? 0,
          sessionDensity20: smallNumberDensity(input.sessionNumbers),
          sessionMessages: validMessageCount(input.sessionMessages),
        });
      } catch { /* a failing sink must not lose the denominator line below, nor reach the reply */ }
      findings = result.findings;
    }
    writeCheckedLine(input, result);
    return findings;
  } catch {
    return [];
  }
}

/**
 * ENG-2382: one line per reply the detector had something to look at (a CRM tool succeeded, a `[verified: ...]` tag, or an inventory
 * total claim), flagged or not. The shadow line alone records only the flagged replies, so a flag rate had no denominator.
 * "Looked at" is the detector's own scope, not proof the reply is about the CRM: the bare "N lists" pattern needs no CRM context,
 * so "5 lists of ideas" counts as a claim. The flagged line has the same property, so rate and numerator stay consistent.
 * Counts and a model name only: no reply text and no session id. Replies with nothing CRM-related write nothing.
 */
function writeCheckedLine(input: CrmFreshnessShadowInput, result: CrmFreshnessResult): void {
  try {
    if (result.claimsSeen === 0 && result.tagsSeen === 0 && result.crmToolsSucceeded.length === 0) return;
    const sink = input.logChecked ?? ((message, detail) => console.log(`${message} ${JSON.stringify(detail)}`));
    sink('[crm-freshness-checked] CRM reply checked', {
      model: input.model,
      flagged: result.findings.length > 0,
      findingCount: result.findings.length,
      tagsSeen: result.tagsSeen,
      claimsSeen: result.claimsSeen,
      crmToolsSucceeded: result.crmToolsSucceeded.length,
      totalsAbstained: result.totalsAbstained,
      // Same three numbers as the flagged line, so the flag rate can be split by session size and number-set crowding.
      sessionNumberCount: input.sessionNumbers?.size ?? 0,
      sessionDensity20: smallNumberDensity(input.sessionNumbers),
      sessionMessages: validMessageCount(input.sessionMessages),
    });
  } catch { /* log-only: never reaches the reply */ }
}
