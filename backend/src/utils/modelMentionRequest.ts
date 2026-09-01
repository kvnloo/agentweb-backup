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

/** How many tokens may sit between the verb and the model name. */
const MAX_VERB_DISTANCE_TOKENS = 6;

interface Token {
  text: string;
  start: number;
  end: number;
  /** True when `.`/`!`/`?`/newline sits immediately before this token. */
  followsSentenceBreak: boolean;
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
      followsSentenceBreak: /[.!?\n]/.test(text.slice(previousEnd, match.index)),
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
    if (nameTokens.length > 0 && VENDOR_TOKENS.has(nameTokens[0])) {
      const stripped = nameTokens.slice(1);
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
export function findModelMention(
  messageContent: string | null | undefined,
  index: ModelMentionIndex,
): ModelMention | null {
  if (!messageContent || typeof messageContent !== 'string') return null;
  if (hasNegation(messageContent)) return null;
  if (isExplanatoryQuestion(messageContent)) return null;

  const tokens = tokenize(messageContent);
  for (let i = 0; i < tokens.length; i++) {
    for (const { key, modelId } of index.keys) {
      const length = matchLengthAt(tokens, i, key);
      if (!length) continue;
      if (!hasLeadingRequestVerb(tokens, i)) continue;
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
    return (
      `Note: ${wantedLabel} isn't available on your account, so this reply ran ` +
      `on ${ranLabel}. The models you can use are listed in the model selector ` +
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
