/**
 * ENG-1205 AC3 — an in-chat request for a specific model must get an explicit
 * answer naming the model that actually ran.
 *
 * ENG-1565 already closed the GENERIC half of this: "reassess using a new model"
 * / "switch models" now gets an acknowledgement (see ./modelReassessRequest.ts).
 * Its detector deliberately requires the words `new|different|another|other`
 * next to `model`, so it does not — and was never meant to — fire on a message
 * that names the model it wants. The production message that filed ENG-1205,
 *
 *     "Use Opus 5 model, and make sure you sort all of the 107 leads..."
 *
 * misses that pattern entirely, and so did every one of the nine turns that
 * followed it on session d5898ffd-358c-4d5c-9f68-2d1bb31097db. The user was told
 * nothing and reported the product as broken.
 *
 * This module closes the NAMED half. It does not build in-chat model switching —
 * that remains a materially larger feature (intent parsing wired to picker and
 * session state, confirmation UX) and is explicitly out of scope on both
 * tickets. It closes the silence only.
 *
 * Everything here is pure and registry-driven: the catalog is passed in, so
 * adding a model to `agentModeService.llmModels` extends coverage automatically
 * and no model name is ever hardcoded (the ENG-1137 "do not scatter checks for
 * individual model names" rule).
 *
 * ## Scope: a NAMED model, never a bare family word
 *
 * "switch to opus" and "run this on flash" are NOT matched, deliberately. A
 * family word is one token and an ordinary English word — ENG-1565's own test
 * suite already pins `"can you use sonnet for a poem"` and `"write me a haiku"`
 * as messages that must never be read as model requests, and a one-token
 * matcher cannot tell those apart from a real request. Every key here is at
 * least two tokens ("opus 5", "claude opus 5", "gemini 3.1 flash lite",
 * "anthropic.claude-opus-5"), which is the same precision-over-recall bias
 * ENG-1565 chose and for the same reason: a false positive tells the user
 * something FALSE about a message that was never about models, while a missed
 * mention only leaves today's silence, which is no worse than before.
 */

import { hasNegation, isExplanatoryQuestion } from './modelReassessRequest';

export interface ModelCatalogEntry {
  id: string;
  name?: string;
  family?: string;
}

export interface ModelMention {
  /** Canonical registry id the message asked for. */
  modelId: string;
  /** The text that matched, as the user wrote it. */
  matchedText: string;
}

export interface ModelMentionIndex {
  /** Normalized key -> model id, longest key first so "claude opus 5" beats "opus 5". */
  keys: Array<{ key: string; modelId: string }>;
  /** id -> display label, for the acknowledgement copy. */
  labels: Map<string, string>;
}

/**
 * Vendor words, stripped from the front of a display name to produce the short
 * alias people actually type ("Claude Opus 5" -> "opus 5").
 */
const VENDOR_TOKENS = new Set([
  'anthropic', 'claude', 'openai', 'gpt', 'google', 'gemini', 'openrouter',
  'xai', 'grok', 'deepseek', 'qwen', 'moonshotai', 'kimi', 'zai', 'glm',
  'mistralai', 'mistral', 'perplexity', 'meta', 'llama',
]);

/**
 * A mention only counts as a REQUEST when one of these leads it. Without it,
 * "the Opus 5 write-up looks good" reads as a request to switch to Opus 5.
 * Deliberately excludes soft verbs like "want"/"prefer"/"like", which appear
 * constantly in ordinary copy review.
 */
const REQUEST_VERBS = new Set([
  'use', 'using', 'switch', 'switching', 'change', 'changing', 'run', 'running',
  'rerun', 'retry', 'try', 'pick', 'select', 'reassess', 'redo', 'move', 'swap',
  'route', 'reroute',
]);

/**
 * How far back to look for the request verb, measured in tokens from the model
 * name. The verb may sit up to this many positions before the mention, so at
 * most FIVE tokens intervene: "switch this session over to Opus 5" matches,
 * one word longer does not.
 *
 * (CodeRabbit read the previous one-line comment as "six may sit between" and
 * proposed widening the window by one. The window is a distance, which is what
 * the constant is named for; the comment was what was wrong. Pinned by the
 * boundary tests in __tests__/modelMentionRequest.test.ts so it cannot drift
 * back into ambiguity.)
 */
const MAX_VERB_DISTANCE_TOKENS = 6;

interface Token {
  text: string;
  start: number;
  end: number;
  /** True when `.`/`!`/`?`/newline sits immediately before this token. */
  followsSentenceBreak: boolean;
}

/**
 * Is the gap between two tokens a sentence boundary?
 *
 * The subtlety is the full stop. Most of the registry carries a dotted version
 * — "Gemini 3.7 Flash", "GPT 4.1", "Claude Opus 4.8" — and a naive `/[.!?\n]/`
 * test splits "3.7" into two sentences. That is not cosmetic: it truncated the
 * sentence range `findModelMention` hands the explanatory-question guard, so
 * "What does it mean to use Gemini 3.7 Flash?" lost its own question mark and
 * was read as a REQUEST for that model. Caught by CodeRabbit on PR #2707 and
 * reproduced before fixing; pinned by tests below.
 *
 * A dot flanked by digits with no whitespace is a decimal point. A dot after a
 * SINGLE letter with no whitespace (ENG-2293 Opslane finding on PR #3276:
 * "Z.ai", a real auto-added vendor name) is a vendor abbreviation. It must stay
 * that narrow: people do drop the space after a real sentence end ("the
 * CSV.Opus 5 wrote it"), and a general letter-dot-letter rule let that read
 * as a request for Opus 5 (Opslane run 151). Anything else — including "3. 7" and the "3.7. Use..." that ends a
 * real sentence — is a break.
 */
function isSentenceBreak(gap: string, previousToken: Token | undefined, nextChar: string): boolean {
  if (/[!?\n]/.test(gap)) return true;
  if (!gap.includes('.')) return false;
  const isAbbreviationPoint =
    gap === '.'
    && !!previousToken
    && (
      (/\d$/.test(previousToken.text) && /^\d/.test(nextChar))
      || (previousToken.text.length === 1 && /^[a-z]$/i.test(previousToken.text) && /^[a-z]/i.test(nextChar))
    );
  return !isAbbreviationPoint;
}

/**
 * Remove the dot from a dotted version ("3.7" -> "37") and from a dotted
 * vendor abbreviation ("Z.ai" -> "Zai"), for guard matching only.
 *
 * `EXPLANATORY_QUESTION_PATTERN` (ENG-1565) spans `[^.!]*` between its opening
 * phrase and the "?", deliberately, so it cannot reach across a sentence. A
 * version dot is not a sentence, but it stops that scan dead — which is why
 * "What does it mean to use Gemini 3.1 Flash Lite?" survived the sentence-range
 * fix and was still read as a request. Fixing it here rather than widening the
 * shared pattern keeps ENG-1565's detector untouched.
 *
 * Same failure, different character class (ENG-2293 Opslane finding on PR
 * #3276): "What does it mean to use Z.ai: GLM 5.3?" was read as a request
 * because the dot inside the vendor name "Z.ai" stopped the scan before it
 * ever reached the real "?". Only a dot after a single letter is stripped,
 * matching `isSentenceBreak` (a longer word before the dot is a sentence end).
 *
 * Used only to answer a yes/no question about the text; never for offsets or
 * for anything the customer sees.
 */
function stripVersionDots(text: string): string {
  return text.replace(/(\d)\.(?=\d)/g, '$1').replace(/\b([A-Za-z])\.(?=[A-Za-z])/g, '$1');
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[a-z0-9]+/gi;
  let match: RegExpExecArray | null;
  let previousEnd = 0;
  while ((match = re.exec(text)) !== null) {
    tokens.push({
      text: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
      followsSentenceBreak: isSentenceBreak(
        text.slice(previousEnd, match.index),
        tokens[tokens.length - 1],
        match[0],
      ),
    });
    previousEnd = match.index + match[0].length;
  }
  return tokens;
}

const isVersionToken = (token: string): boolean => /\d/.test(token);

/**
 * Build the lookup once per catalog. Keys come from the model id AND the display
 * name, plus the display name with its vendor prefix removed — which is the form
 * people actually type. The vendor-stripped alias is registered only when what
 * remains still contains a word, so "GPT-5.4" does not register the key "5 4"
 * and match a stray version number anywhere in a message.
 */
export function buildModelMentionIndex(
  catalog: readonly ModelCatalogEntry[],
): ModelMentionIndex {
  const byKey = new Map<string, string>();
  const labels = new Map<string, string>();

  const register = (tokens: string[], modelId: string): void => {
    // Single-token keys are never registered — see the scope note above.
    if (tokens.length < 2) return;
    const key = tokens.join(' ');
    // First registration wins, so a specific model never has its alias stolen
    // by a later entry that happens to normalize the same way.
    if (!byKey.has(key)) byKey.set(key, modelId);
  };

  for (const entry of catalog) {
    if (!entry?.id) continue;
    const displayLabel = entry.name?.trim() || entry.id;
    labels.set(entry.id, displayLabel);

    register(tokenize(entry.id).map((t) => t.text), entry.id);

    const nameTokens = tokenize(displayLabel).map((t) => t.text);
    register(nameTokens, entry.id);
    // Register an alias at EVERY leading-vendor-token strip depth, not just
    // the deepest one: an auto-added entry's name is "<Vendor>: <Family>
    // <Version>" (e.g. "Anthropic: Claude Sonnet 5.5"), two vendor tokens
    // deep, while a hand-curated entry is just "<Family> <Version>" (e.g.
    // "Claude Sonnet 5"), one deep. Registering only the fully-stripped alias
    // ("sonnet 5 5") left the natural middle form ("Claude Sonnet 5.5",
    // company name dropped but family name kept) unregistered, so it fell
    // through to the shorter, already-registered "claude sonnet 5" and
    // silently matched the wrong, pre-existing sibling model instead.
    let vendorRun = 0;
    while (vendorRun < nameTokens.length) {
      if (VENDOR_TOKENS.has(nameTokens[vendorRun])) { vendorRun++; continue; }
      // "Z.ai" tokenizes to "z" + "ai" (the dot is a token separator, same as
      // everywhere else in this file), so it never matches the combined "zai"
      // entry above and the strip loop stopped at position 0 — "GLM 5.3" and
      // "GLM 5.3 Flash" (the Z.ai-branded auto-added entries) were unreachable
      // by their bare family name. Treat the pair as that one vendor token.
      if (nameTokens[vendorRun] === 'z' && nameTokens[vendorRun + 1] === 'ai') { vendorRun += 2; continue; }
      break;
    }
    for (let strippedStart = 1; strippedStart <= vendorRun; strippedStart++) {
      const stripped = nameTokens.slice(strippedStart);
      if (stripped.some((t) => !isVersionToken(t))) register(stripped, entry.id);
    }
  }

  return {
    keys: [...byKey.entries()]
      .map(([key, modelId]) => ({ key, modelId }))
      // Longest first: "claude opus 5" must win over "opus 5".
      .sort((a, b) => b.key.length - a.key.length),
    labels,
  };
}

/** Is one of the `MAX_VERB_DISTANCE_TOKENS` tokens before `index` a request verb? */
function hasLeadingRequestVerb(tokens: Token[], index: number): boolean {
  const floor = Math.max(0, index - MAX_VERB_DISTANCE_TOKENS);
  for (let i = index; i > floor; i--) {
    // A sentence break severs the verb from the mention: "Use the CSV. Opus 5
    // wrote the last one." is not a request.
    if (tokens[i].followsSentenceBreak) return false;
    if (REQUEST_VERBS.has(tokens[i - 1].text)) return true;
  }
  return false;
}

/**
 * Does a key match stop part-way through a dotted version? "5.5" tokenizes to "5" + "5", so for
 * "use Anthropic: Claude Sonnet 5.5" the key "anthropic claude sonnet 5" (Sonnet 5's id) matched at
 * "Anthropic" before the scan ever reached "Claude Sonnet 5.5" (ENG-2646). A version is only complete
 * when the next token is not another number joined to it by a dot.
 */
function endsInsideVersion(tokens: Token[], lastIndex: number, text: string): boolean {
  const last = tokens[lastIndex];
  const next = tokens[lastIndex + 1];
  return !!next && isVersionToken(last.text) && /^\d/.test(next.text) && text.slice(last.end, next.start) === '.';
}

function matchLengthAt(tokens: Token[], index: number, key: string): number {
  const keyTokens = key.split(' ');
  if (index + keyTokens.length > tokens.length) return 0;
  for (let i = 0; i < keyTokens.length; i++) {
    if (tokens[index + i].text !== keyTokens[i]) return 0;
  }
  return keyTokens.length;
}

/**
 * The model this message asks to be used, or null.
 *
 * Guards, in order: the two ENG-1565 guards (a negated or explanatory mention is
 * not a request), then a longest-match scan for a registered model name led by a
 * request verb.
 */
/** Char range of the sentence containing `index`, using the same breaks as the verb scan. */
function sentenceBoundsAt(
  tokens: Token[],
  index: number,
  messageContent: string,
): { start: number; end: number } {
  let first = index;
  while (first > 0 && !tokens[first].followsSentenceBreak) first--;
  let afterLast = index + 1;
  while (afterLast < tokens.length && !tokens[afterLast].followsSentenceBreak) afterLast++;
  return {
    start: tokens[first].start,
    // Up to the next sentence's first token (or end of string) so the sentence's
    // own terminating "?" is inside the range — `isExplanatoryQuestion` needs it.
    end: afterLast < tokens.length ? tokens[afterLast].start : messageContent.length,
  };
}

/**
 * The model this message asks to be used, or null.
 *
 * ## Why the guards are scoped, and not applied to the whole message
 *
 * ENG-1565 tests its guards against the entire message, which is right for its
 * detector: its trigger is the bare word "model", so any nearby negation is
 * plausibly about the model. Inheriting that unchanged was a mistake here, and
 * it cost a production verification turn to find. The message
 *
 *     "Use Opus 5 model and reply with just the word OK. Do not call any tools."
 *
 * names a model unambiguously, in its own sentence — and got silence, because
 * "Do not" appeared in a LATER, unrelated sentence. Worse are the ones a real
 * customer would send:
 *
 *     "Use Opus 5 and don't use tables"
 *     "Switch to Opus 5, no need to summarise first"
 *     "Use Opus 5 — I can't get good output from Flash"
 *
 * The last is the ENG-1200 complaint almost verbatim, and a whole-message guard
 * answers it with exactly the silence this ticket exists to remove.
 *
 * So a negation only suppresses a mention when it could actually be negating it:
 * in the SAME sentence, and BEFORE it. "Don't use Opus 5" still stays silent;
 * "use Opus 5, don't use tables" no longer does. The explanatory-question guard
 * is scoped to the mention's sentence for the same reason.
 */
export function findModelMention(
  messageContent: string | null | undefined,
  index: ModelMentionIndex,
): ModelMention | null {
  if (!messageContent || typeof messageContent !== 'string') return null;

  const tokens = tokenize(messageContent);
  for (let i = 0; i < tokens.length; i++) {
    for (const { key, modelId } of index.keys) {
      const length = matchLengthAt(tokens, i, key);
      if (!length) continue;
      if (endsInsideVersion(tokens, i + length - 1, messageContent)) continue;
      if (!hasLeadingRequestVerb(tokens, i)) continue;

      const sentence = sentenceBoundsAt(tokens, i, messageContent);
      // Only text leading up to the mention can negate it.
      if (hasNegation(messageContent.slice(sentence.start, tokens[i].start))) continue;
      if (isExplanatoryQuestion(stripVersionDots(messageContent.slice(sentence.start, sentence.end)))) continue;

      return {
        modelId,
        matchedText: messageContent.slice(tokens[i].start, tokens[i + length - 1].end),
      };
    }
  }
  return null;
}

const label = (index: ModelMentionIndex, modelId: string): string =>
  index.labels.get(modelId) || modelId;

/**
 * Append-only, exactly like its neighbours at the finalize point in
 * agentModeService (`reconcileFalseFailureReport` ENG-971,
 * `reconcileUnconsumedCursors` ENG-1207 AC3, `reconcileModelReassessAck`
 * ENG-1565). Never rewrites the reply; adds one trailing note.
 *
 * Copy constraints, both load-bearing:
 *  - ENG-1117 bans "downgraded", "throttled", "soft cap" and raw cost/token
 *    language in customer-facing text.
 *  - ENG-1211 AC5 removed "optimized mode" as a customer-visible concept, so
 *    this must never reintroduce it. Below the hard cap nothing rewrites a
 *    model any more; the two honest reasons that remain are "chat can't change
 *    the model" and "that model isn't on your account".
 */
export function buildModelMentionAck(
  mention: ModelMention,
  modelThatRan: string,
  isMentionSelectable: boolean,
  index: ModelMentionIndex,
): string {
  const ranLabel = label(index, modelThatRan);
  const wantedLabel = label(index, mention.modelId);

  if (!isMentionSelectable) {
    // "can't be selected", NOT "isn't available on your account".
    //
    // The two are not the same here and the stronger claim would sometimes be
    // false: `updateSessionLlmModel` refuses Opus for a non-admin
    // (agentModeController.ts:12828), but ENG-759 made Opus 5 the configured
    // fleet default, so a non-admin can be RUNNING a model the picker will not
    // let them choose. Saying it is unavailable to them would contradict the
    // badge on their own earlier turns. Selection is the thing that is actually
    // blocked, so that is what the note says.
    return (
      `Note: ${wantedLabel} can't be selected on your account, so this reply ran ` +
      `on ${ranLabel}. The models you can choose are listed in the model selector ` +
      `above the message box.`
    );
  }
  return (
    `Note: this reply ran on ${ranLabel}, not ${wantedLabel} — I can't change ` +
    `models from a chat message. Pick ${wantedLabel} from the model selector ` +
    `above the message box, then send your next message.`
  );
}

/**
 * The whole decision in one pure call, so the service seam stays short. Returns
 * `content` unchanged whenever the message named no model, the request was
 * already honored, or the model that ran is unknown — none of those are the
 * silence this guards against.
 */
export function reconcileModelMentionAck(
  content: string,
  messageContent: string | null | undefined,
  modelThatRan: string | null | undefined,
  index: ModelMentionIndex,
  isSelectable: (modelId: string) => boolean,
): string {
  if (!content || !modelThatRan) return content;
  const mention = findModelMention(messageContent, index);
  if (!mention || mention.modelId === modelThatRan) return content;
  return `${content}\n\n${buildModelMentionAck(mention, modelThatRan, isSelectable(mention.modelId), index)}`;
}
