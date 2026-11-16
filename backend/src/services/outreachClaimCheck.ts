/**
 * Shadow-only claim check for outreach drafts (ENG-3067, slice of ENG-2967).
 *
 * Finds specifics a draft states about the sender (percentages, money amounts,
 * numbers with a unit, named customers/partners) that the sender's brand facts
 * do not contain. It only measures: callers log counts and never block,
 * rewrite or surface anything to the user.
 *
 * What this cannot see, so a zero count is NOT proof a draft is grounded:
 *  - qualitative claims ("the leading platform", "best in class")
 *  - paraphrased or spelled-out numbers ("half", "forty percent", "doubled")
 *  - a supported number attached to the wrong thing (facts say "40% faster
 *    onboarding", draft says "40% cheaper") — percentages and money match on
 *    value alone
 *  - named customers outside the trigger phrases below, or written lowercase
 *  - numbers with no unit word after them
 *
 * `findUnsupportedSenderClaims` is pure: no I/O, no LLM call, no network call.
 */

export type OutreachClaimKind = 'percentage' | 'money' | 'number_with_unit' | 'named_entity';

export interface UnsupportedClaim {
  kind: OutreachClaimKind;
  /** The claim as written in the draft. Never log this. */
  text: string;
}

export type OutreachClaimCheckResult =
  | { status: 'no_facts' }
  | { status: 'checked'; unsupported: UnsupportedClaim[] };

export interface OutreachClaimCheckInput {
  draft: { subject?: unknown; body?: unknown };
  /** `brandData` object plus market strategy text. */
  facts: { brandData?: unknown; marketStrategyText?: unknown };
  /** The lead record. Anything it contains is a fact about the recipient, not the sender. */
  recipient?: unknown;
}

const MAX_FLATTEN_DEPTH = 6;

function flatten(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > MAX_FLATTEN_DEPTH) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(v => flatten(v, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(v => flatten(v, depth + 1)).filter(Boolean).join('\n');
  }
  return '';
}

function plainText(value: unknown): string {
  return flatten(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

function toNumber(digits: string, multiplier?: string): number | null {
  const n = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = multiplier ? MULTIPLIERS[multiplier.toLowerCase()] ?? 1 : 1;
  // Round away float noise so 1.5 * 1000 and 1500 produce the same key.
  return Math.round(n * mult * 1e6) / 1e6;
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const MULT = String.raw`(?:thousand|million|billion|bn|mm|k|m|b)`;

const MONEY_PREFIX = new RegExp(String.raw`(?:US)?\$\s*(${NUM})\s*(${MULT})?\b`, 'gi');
const MONEY_SUFFIX = new RegExp(String.raw`\b(${NUM})\s*(${MULT})?\s*(?:dollars?|usd|bucks)\b`, 'gi');
const PERCENT = new RegExp(String.raw`(${NUM})\s*(?:%|percent\b|per\s+cent\b)`, 'gi');
const NUMBER_UNIT = new RegExp(String.raw`\b(${NUM})(?:\s*(${MULT})\b)?\+?(?:\s*-?\s*)([a-z]{1,30})\b`, 'gi');

// Words that follow a number without making it a measurable claim.
const NON_UNITS = new Set([
  'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'the', 'is', 'are',
  'was', 'were', 'but', 'so', 'as', 'if', 'that', 'this', 'than', 'then', 'we', 'you', 'i', 'it', 'they',
  'am', 'pm', 'st', 'nd', 'rd', 'th',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july',
  'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december',
]);

function singular(unit: string): string {
  const u = unit.toLowerCase();
  if (u.length > 3 && u.endsWith('ies')) return `${u.slice(0, -3)}y`;
  if (u.length > 2 && u.endsWith('s') && !u.endsWith('ss')) return u.slice(0, -1);
  return u;
}

interface NumericClaim {
  kind: Exclude<OutreachClaimKind, 'named_entity'>;
  key: string;
  value: number;
  text: string;
}

/** Extract numeric claims. Each span is consumed once, so "40 percent" is not also "40 + unit". */
function extractNumericClaims(source: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  let text = source;
  const consume = (
    re: RegExp,
    build: (m: RegExpExecArray) => NumericClaim | null,
  ): void => {
    text = text.replace(re, (...args) => {
      const match = args[0] as string;
      const m = [match, ...args.slice(1, -2)] as unknown as RegExpExecArray;
      const claim = build(m);
      if (!claim) return match;
      claims.push(claim);
      return ' '.repeat(match.length);
    });
  };
  const money = (m: RegExpExecArray): NumericClaim | null => {
    const n = toNumber(m[1], m[2]);
    return n === null ? null : { kind: 'money', key: `money:${n}`, value: n, text: m[0].trim() };
  };
  consume(MONEY_PREFIX, money);
  consume(MONEY_SUFFIX, money);
  consume(PERCENT, m => {
    const n = toNumber(m[1]);
    return n === null ? null : { kind: 'percentage', key: `pct:${n}`, value: n, text: m[0].trim() };
  });
  consume(NUMBER_UNIT, m => {
    const unit = m[3].toLowerCase();
    if (NON_UNITS.has(unit)) return null;
    const n = toNumber(m[1], m[2]);
    return n === null ? null : { kind: 'number_with_unit', key: `num:${n}:${singular(unit)}`, value: n, text: m[0].trim() };
  });
  return claims;
}

const BARE_NUMBER = new RegExp(String.raw`(${NUM})(?:\s*(${MULT})\b)?`, 'gi');

/**
 * Every number in the recipient's record, unit or not. A lead record stores
 * `employees: 250` or `funding: 5000000` as bare values, so a draft's
 * "250 employees" or "$5M" must match on value alone to count as theirs.
 */
function recipientNumbers(text: string): Set<number> {
  const values = new Set<number>();
  for (const m of text.matchAll(BARE_NUMBER)) {
    const n = toNumber(m[1], m[2]);
    if (n !== null) values.add(n);
  }
  return values;
}

const NAME = String.raw`[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3}`;
const NAME_LIST = String.raw`${NAME}(?:\s*(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)${NAME}){0,5}`;
// Triggers match in any case but names must be capitalized, so the regex cannot
// use the global `i` flag: each trigger word is expanded to [aA][bB]... instead.
const ci = (words: string): string =>
  words.split(' ').map(w => w.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`)).join(String.raw`\s+`);
const anyOf = (...phrases: string[]): string => `(?:${phrases.map(ci).join('|')})`;
const ENTITY_TRIGGERS = [
  `${anyOf('customer', 'customers', 'client', 'clients', 'partner', 'partners', 'companies', 'brands', 'teams')}${String.raw`\s+`}${anyOf('like', 'such as', 'including')}`,
  anyOf('trusted by', 'used by', 'helped'),
  anyOf('partner with', 'partners with', 'partnered with', 'partnering with'),
  anyOf('work with', 'works with', 'worked with', 'working with'),
];
const ENTITY = new RegExp(String.raw`\b(?:${ENTITY_TRIGGERS.join('|')})\s+(${NAME_LIST})`, 'g');

function extractNamedEntities(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(ENTITY)) {
    for (const part of m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/)) {
      const name = part.replace(/[.'-]+$/, '').trim();
      if (name.length > 1) names.push(name);
    }
  }
  return names;
}

function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The lead record carries the previous `emailDraft` / `messageDraft`. Those are
 * our own generated text, not facts about the recipient: left in, a regenerated
 * draft that repeats an unsupported claim would excuse itself and count zero.
 */
const GENERATED_DRAFT_FIELDS = new Set(['emailDraft', 'messageDraft']);

function withoutGeneratedDrafts(recipient: unknown): unknown {
  if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) return recipient;
  return Object.fromEntries(
    Object.entries(recipient as Record<string, unknown>).filter(([key]) => !GENERATED_DRAFT_FIELDS.has(key)),
  );
}

export function findUnsupportedSenderClaims(input: OutreachClaimCheckInput): OutreachClaimCheckResult {
  const factsText = [plainText(input.facts?.brandData), plainText(input.facts?.marketStrategyText)]
    .filter(t => t.trim())
    .join('\n');
  if (!factsText.trim()) return { status: 'no_facts' };

  const draftText = [plainText(input.draft?.subject), plainText(input.draft?.body)].join('\n');
  const recipientText = plainText(withoutGeneratedDrafts(input.recipient));

  const knownKeys = new Set(
    [...extractNumericClaims(factsText), ...extractNumericClaims(recipientText)].map(c => c.key),
  );
  const recipientValues = recipientNumbers(recipientText);
  const knownNames = ` ${normalizeName(factsText)} \n ${normalizeName(recipientText)} `;

  const unsupported: UnsupportedClaim[] = [];
  const seen = new Set<string>();
  for (const claim of extractNumericClaims(draftText)) {
    if (knownKeys.has(claim.key) || seen.has(claim.key)) continue;
    // A bare recipient number excuses a count or an amount, not a percentage.
    if (claim.kind !== 'percentage' && recipientValues.has(claim.value)) continue;
    seen.add(claim.key);
    unsupported.push({ kind: claim.kind, text: claim.text });
  }
  for (const name of extractNamedEntities(draftText)) {
    const normalized = normalizeName(name);
    const key = `name:${normalized}`;
    if (!normalized || seen.has(key) || knownNames.includes(` ${normalized} `)) continue;
    seen.add(key);
    unsupported.push({ kind: 'named_entity', text: name });
  }
  return { status: 'checked', unsupported };
}

export interface OutreachClaimShadowInput extends OutreachClaimCheckInput {
  channel: 'email' | 'linkedin_note';
  listId: string;
}

/**
 * Run the check in shadow and log one structured line: counts by kind and the
 * lead list ID, never draft text. Synchronous and CPU-only, so it adds no
 * awaited work to the draft path; any error is swallowed so it can never fail
 * the draft. `check` is injectable for the error-path test only.
 */
export function logOutreachClaimCheckShadow(
  input: OutreachClaimShadowInput,
  check: (input: OutreachClaimCheckInput) => OutreachClaimCheckResult = findUnsupportedSenderClaims,
): void {
  try {
    const result = check(input);
    const byKind: Record<OutreachClaimKind, number> = {
      percentage: 0, money: 0, number_with_unit: 0, named_entity: 0,
    };
    if (result.status === 'checked') {
      for (const claim of result.unsupported) byKind[claim.kind] += 1;
    }
    console.log(JSON.stringify({
      event: 'outreach_claim_check_shadow',
      channel: input.channel,
      listId: input.listId,
      status: result.status,
      unsupportedTotal: result.status === 'checked' ? result.unsupported.length : 0,
      unsupportedByKind: byKind,
    }));
  } catch {
    // Shadow measurement only: never let it affect the draft.
    try {
      console.log(JSON.stringify({
        event: 'outreach_claim_check_shadow', channel: input?.channel, listId: input?.listId, status: 'error',
      }));
    } catch { /* nothing left to do */ }
  }
}
