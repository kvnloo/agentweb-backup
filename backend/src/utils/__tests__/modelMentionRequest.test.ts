/**
 * ENG-1205 AC3/AC4 — behavioral contract:
 *
 * 1. A message that NAMES a model, where the turn did not run on that model,
 *    gets an explicit note saying what ran and why.
 * 2. A message that named the model that actually ran gets nothing.
 * 3. No false positives: ordinary prose that happens to contain a model name,
 *    a negated mention, and an explanatory question all stay silent — including
 *    every non-request string ENG-1565's own suite already pins.
 */

import {
  buildModelMentionIndex,
  findModelMention,
  buildModelMentionAck,
  reconcileModelMentionAck,
} from '../modelMentionRequest';

/** Shaped exactly like `agentModeService.getModelMentionCatalog()` returns. */
const CATALOG = [
  { id: 'anthropic.claude-opus-5', name: 'Claude Opus 5', family: 'claude-opus' },
  { id: 'anthropic.claude-opus-4-8', name: 'Claude Opus 4.8', family: 'claude-opus' },
  { id: 'anthropic.claude-opus-4-6-v1', name: 'Claude Opus 4.6', family: 'claude-opus' },
  { id: 'anthropic.claude-sonnet-5', name: 'Claude Sonnet 5', family: 'claude-sonnet' },
  { id: 'anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', family: 'gemini-flash' },
  { id: 'gpt-5.4', name: 'GPT-5.4', family: 'gpt5-chat' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', family: 'gpt5-nano' },
  { id: 'openrouter/x-ai/grok-4.6', name: 'Grok 4.6' },
];

const index = buildModelMentionIndex(CATALOG);
const OPUS_5 = 'anthropic.claude-opus-5';
const FLASH_LITE = 'gemini-3.1-flash-lite';
const alwaysSelectable = () => true;

describe('findModelMention', () => {
  it.each([
    // THE message from the ENG-1205 production session (d5898ffd, 2026-08-14).
    ['Use Opus 5 model, and make sure you sort all of the 107 leads by revenue', OPUS_5],
    ['switch to Opus 5', OPUS_5],
    ['can you use claude opus 5 for this', OPUS_5],
    ['please use anthropic.claude-opus-5', OPUS_5],
    ['rerun this with Gemini 3.1 Flash Lite', FLASH_LITE],
    ['try gpt-5.4 nano instead', 'gpt-5.4-nano'],
    ['swap to Claude Haiku 4.5 for the rest', 'anthropic.claude-haiku-4-5-20251001-v1:0'],
  ])('reads %p as a request for %s', (text, expected) => {
    expect(findModelMention(text, index)?.modelId).toBe(expected);
  });

  it('prefers the longest matching name over a shorter alias of another model', () => {
    // "Claude Opus 4.8" must not be shortened into a match for "Opus 4".
    expect(findModelMention('switch to claude opus 4.8', index)?.modelId)
      .toBe('anthropic.claude-opus-4-8');
  });

  describe('verb-to-mention distance boundary', () => {
    // The window is a DISTANCE from the mention, so five tokens may intervene.
    // Pinned in both directions: a silently widened window costs precision, a
    // silently narrowed one drops real requests.
    const withGap = (n: number) => `use ${'word '.repeat(n)}Opus 5`;

    it.each([0, 1, 2, 3, 4, 5])('matches with %i intervening token(s)', (n) => {
      expect(findModelMention(withGap(n), index)?.modelId).toBe(OPUS_5);
    });

    it.each([6, 7])('does not match with %i intervening tokens', (n) => {
      expect(findModelMention(withGap(n), index)).toBeNull();
    });
  });

  describe('a dotted version is not a sentence boundary', () => {
    // CodeRabbit, PR #2707. Most of the registry carries a dotted version, and
    // treating "3.7" as two sentences truncated the range handed to the
    // explanatory-question guard — so the question mark fell outside it and a
    // plain question was read as a request. Reproduced before fixing:
    //   "What does it mean to use GPT 4.1?"          -> MATCHED (wrong)
    //   "What does it mean to use Gemini 3.7 Flash?" -> MATCHED (wrong)
    //   "What does it mean to use Opus 5?"           -> null (right, no dot)
    it.each([
      'What does it mean to use Gemini 3.1 Flash Lite?',
      'What would it cost to use Claude Opus 4.8?',
      "don't use Gemini 3.1 Flash Lite",
      'never use Claude Opus 4.8 for this',
    ])('stays silent on %p', (text) => {
      expect(findModelMention(text, index)).toBeNull();
    });

    it.each([
      'use Gemini 3.1 Flash Lite',
      'switch to Claude Opus 4.8',
      // A real sentence really does end after a dotted version.
      'That ran on Claude Opus 4.8. Use Opus 5 instead.',
    ])('still fires on %p', (text) => {
      expect(findModelMention(text, index)).not.toBeNull();
    });

    it('treats a spaced "3. 7" as a real break, not a decimal', () => {
      // The verb is severed from the mention by the break, so no request.
      expect(findModelMention('use 3. 7 Claude Opus 4.8', index)).toBeNull();
    });
  });

  describe('negation is scoped to the mention, not the whole message', () => {
    // Found by a real production verification turn on 2026-09-01: the message
    // below named Opus 5 in its own sentence and got silence, because "Do not"
    // appeared in a LATER, unrelated sentence. A whole-message guard answers a
    // legitimate request with exactly the silence this ticket exists to remove.
    it.each([
      'Use Opus 5 model and reply with just the word OK. Do not call any tools.',
      "Use Opus 5 and don't use tables",
      'Switch to Opus 5, no need to summarise first',
      // The ENG-1200 complaint, almost verbatim.
      "Use Opus 5 — I can't get good output from Flash",
      'Do not call any tools. Use Opus 5.',
    ])('still fires on %p', (text) => {
      expect(findModelMention(text, index)?.modelId).toBe(OPUS_5);
    });

    it.each([
      // A negation BEFORE the mention, in its own sentence, still suppresses.
      "don't use Opus 5",
      'never switch to Opus 5 without asking me first',
      "Please don't switch to Opus 5 for this one",
      // An explanatory question about the mention likewise.
      'What does it mean to use Opus 5?',
      // ...even when another sentence would have matched on its own.
      'Summarise the leads. What does it mean to use Opus 5?',
    ])('still stays silent on %p', (text) => {
      expect(findModelMention(text, index)).toBeNull();
    });
  });

  it.each([
    // No request verb — a mention is not a request.
    'the Opus 5 write-up looks good',
    'Opus 5 wrote the last draft',
    // Verb severed from the mention by a sentence break.
    'Use the CSV. Opus 5 wrote the last one.',
    // ENG-1565's guards, which this detector reuses rather than re-deriving.
    "don't use Opus 5",
    'never switch to Opus 5 without asking me first',
    'What does it mean to use Opus 5?',
    'Why would I switch to Claude Opus 5?',
    // Ordinary prose. Every one of these is also pinned by ENG-1565's suite.
    'update the pricing model',
    'change the business model to a subscription model',
    'can you use sonnet for a poem',
    'write me a haiku',
    'use a different model this time',
    'switch models',
    // A bare version number must never match a vendor-stripped alias ("GPT-5.4"
    // must not register the key "5 4").
    'use the 5 4 split from the spreadsheet',
    '',
    null,
    undefined,
  ])('does NOT flag %p (no false positive)', (text) => {
    expect(findModelMention(text as any, index)).toBeNull();
  });
});

describe('findModelMention — auto-added double vendor-prefix (ENG-2293 Opslane finding)', () => {
  // Shaped exactly like modelCatalogRefresh.ts's auto-added entries: the
  // OpenRouter-sourced name is "<Vendor>: <Family> <Version>" (two leading
  // vendor/family tokens), unlike a hand-curated entry's "<Family> <Version>"
  // (one). A single-strip vendor alias left the longer entry unreachable and
  // let the shorter sibling's "sonnet 5" key silently swallow the first two
  // tokens of "Sonnet 5.5".
  const sonnet55Catalog = [
    ...CATALOG,
    { id: 'openrouter/anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', family: 'claude-sonnet' },
  ];
  const sonnet55Index = buildModelMentionIndex(sonnet55Catalog);
  const SONNET_5 = 'anthropic.claude-sonnet-5';
  const SONNET_5_5 = 'openrouter/anthropic/claude-sonnet-5.5';

  it.each([
    ['use Sonnet 5.5 for this', SONNET_5_5],
    ['switch to Claude Sonnet 5.5', SONNET_5_5],
    ['use Sonnet 5 for this', SONNET_5],
    ['switch to Claude Sonnet 5', SONNET_5],
  ])('reads %p as a request for the correct, distinct model', (text, expected) => {
    expect(findModelMention(text, sonnet55Index)?.modelId).toBe(expected);
  });
});

describe('findModelMention — vendor name with an internal dot (ENG-2293 Opslane finding)', () => {
  // "Z.ai" is a real auto-added vendor name (modelCatalogRefresh.ts's
  // PROVIDERS map). Its internal dot is not a sentence boundary, but
  // EXPLANATORY_QUESTION_PATTERN's [^.!]* scan can't tell the difference and
  // stops dead on it, same failure as a version dot — so the real trailing
  // "?" is never reached and the question is misread as a request.
  const glmCatalog = [
    ...CATALOG,
    { id: 'openrouter/z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', family: 'glm' },
  ];
  const glmIndex = buildModelMentionIndex(glmCatalog);

  it.each([
    'What does it mean to use Z.ai: GLM 5.3?',
    'What would it cost to use Z.ai: GLM 5.3?',
    'Why would I switch to Z.ai: GLM 5.3?',
  ])('stays silent on the explanatory question %p', (text) => {
    expect(findModelMention(text, glmIndex)).toBeNull();
  });

  it('still fires on a genuine request naming the same model', () => {
    expect(findModelMention('use Z.ai: GLM 5.3 for this', glmIndex)?.modelId).toBe('openrouter/z-ai/glm-5.3');
  });
});

describe('findModelMention — Z.ai vendor-prefix stripping (ENG-2293 fresh-eyes review finding)', () => {
  // "Z.ai" tokenizes to "z" + "ai" (the dot is a token separator, same as
  // everywhere else here), so it never matched the combined "zai" entry in
  // VENDOR_TOKENS and the strip loop stopped at position 0 — the bare family
  // name people actually type ("GLM 5.3") was unreachable; only the fully
  // vendor-prefixed form worked.
  const glmCatalog = [
    ...CATALOG,
    { id: 'openrouter/z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', family: 'glm' },
    { id: 'openrouter/z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', family: 'glm-flash' },
  ];
  const glmIndex = buildModelMentionIndex(glmCatalog);

  it('resolves the bare family name with no vendor prefix', () => {
    expect(findModelMention('switch to GLM 5.3', glmIndex)?.modelId).toBe('openrouter/z-ai/glm-5.3');
  });

  it('distinguishes the bare family name from its Flash sibling', () => {
    expect(findModelMention('switch to GLM 5.3 Flash', glmIndex)?.modelId).toBe('openrouter/z-ai/glm-5.3-flash');
  });
});

describe('buildModelMentionAck', () => {
  const mention = { modelId: OPUS_5, matchedText: 'Opus 5' };

  it('names both models when the request is selectable but was not applied', () => {
    const note = buildModelMentionAck(mention, FLASH_LITE, true, index);
    expect(note).toContain('Gemini 3.1 Flash Lite');
    expect(note).toContain('Claude Opus 5');
    expect(note).toMatch(/model selector/i);
  });

  it('says the model cannot be SELECTED, not that it is unavailable', () => {
    // ENG-759 made Opus 5 the fleet default while the picker still refuses opus
    // for a non-admin, so "isn't available on your account" would contradict the
    // badge on that same user's earlier turns. Selection is what is blocked.
    const note = buildModelMentionAck(mention, FLASH_LITE, false, index);
    expect(note).toMatch(/can't be selected on your account/i);
    expect(note).not.toMatch(/isn't available on your account/i);
    expect(note).toContain('Gemini 3.1 Flash Lite');
  });

  it('never uses banned or removed vocabulary (ENG-1117, ENG-1211 AC5)', () => {
    for (const selectable of [true, false]) {
      const note = buildModelMentionAck(mention, FLASH_LITE, selectable, index);
      expect(note).not.toMatch(/downgrad|throttl|soft cap|optimi[sz]ed mode|token|\$/i);
    }
  });

  it('falls back to the raw id for a model missing from the catalog', () => {
    expect(buildModelMentionAck(mention, 'some-unregistered-model', true, index))
      .toContain('some-unregistered-model');
  });
});

describe('reconcileModelMentionAck', () => {
  const reply = 'Here are the 107 leads.';

  it('reproduces the ENG-1205 session: Opus 5 asked for, Flash Lite ran', () => {
    const out = reconcileModelMentionAck(
      reply,
      'Use Opus 5 model, and make sure you sort all of the 107 leads',
      FLASH_LITE,
      index,
      alwaysSelectable,
    );
    expect(out).toContain(reply);
    expect(out).toContain('Claude Opus 5');
    expect(out).toContain('Gemini 3.1 Flash Lite');
  });

  it('is append-only — the reply itself is never rewritten', () => {
    const out = reconcileModelMentionAck(reply, 'use Opus 5', FLASH_LITE, index, alwaysSelectable);
    expect(out.startsWith(reply)).toBe(true);
  });

  it('stays silent when the turn already ran on the model that was asked for', () => {
    expect(reconcileModelMentionAck(reply, 'use Opus 5', OPUS_5, index, alwaysSelectable))
      .toBe(reply);
  });

  it('stays silent when the message named no model', () => {
    expect(reconcileModelMentionAck(reply, 'sort these by revenue', FLASH_LITE, index, alwaysSelectable))
      .toBe(reply);
  });

  it('stays silent when the model that ran is unknown', () => {
    expect(reconcileModelMentionAck(reply, 'use Opus 5', null, index, alwaysSelectable))
      .toBe(reply);
  });

  it('is a no-op on empty content', () => {
    expect(reconcileModelMentionAck('', 'use Opus 5', FLASH_LITE, index, alwaysSelectable))
      .toBe('');
  });

  it('consults selectability for the model that was ASKED for, not the one that ran', () => {
    const isSelectable = jest.fn().mockReturnValue(false);
    const out = reconcileModelMentionAck(reply, 'use Opus 5', FLASH_LITE, index, isSelectable);
    expect(isSelectable).toHaveBeenCalledWith(OPUS_5);
    expect(out).toMatch(/can't be selected on your account/i);
  });
});

describe('findModelMention — a dot between two words is not a vendor abbreviation (ENG-2293 Opslane finding, run 151)', () => {
  // The Z.ai exemption must stay narrow: a single-letter prefix ("Z.ai"), not
  // any letter-dot-letter. "CSV.Opus 5" is a typo for "CSV. Opus 5" — a real
  // sentence end with the space dropped — and must not turn the next
  // sentence's model name into a request.
  const idx = buildModelMentionIndex([
    ...CATALOG,
    { id: 'openrouter/z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', family: 'glm' },
  ]);

  it.each([
    'Use the CSV.Opus 5 wrote the last one',
    'Try the draft.Gemini 3.1 Flash Lite made it',
  ])('stays silent when a spaceless sentence end precedes the model name: %p', (text) => {
    expect(findModelMention(text, idx)).toBeNull();
  });

  it('still reads Z.ai as one vendor name', () => {
    expect(findModelMention('switch to Z.ai: GLM 5.3', idx)?.modelId).toBe('openrouter/z-ai/glm-5.3');
    expect(findModelMention('What does it mean to use Z.ai: GLM 5.3?', idx)).toBeNull();
  });
});

describe('findModelMention — a key never matches part of a dotted version (ENG-2646)', () => {
  // "5.5" tokenizes to "5" + "5", and the scan is position-first, so the shorter sibling's id key
  // "anthropic claude sonnet 5" used to match at "Anthropic" and win before the scan reached
  // "Claude Sonnet 5.5". Only the auto-added entry's "Anthropic: ..." name happened to hide this.
  const index = buildModelMentionIndex([
    ...CATALOG,
    { id: 'openrouter/anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', family: 'claude-sonnet' },
  ]);
  const SONNET_5 = 'anthropic.claude-sonnet-5';
  const SONNET_5_5 = 'openrouter/anthropic/claude-sonnet-5.5';

  it.each([
    ['use Anthropic: Claude Sonnet 5.5 for this', SONNET_5_5],
    ['use Anthropic Claude Sonnet 5.5', SONNET_5_5],
    ['switch to Claude Sonnet 5.5', SONNET_5_5],
    ['use Sonnet 5.5 for this', SONNET_5_5],
    ['use Anthropic Claude Sonnet 5 for this', SONNET_5],
    ['switch to Claude Sonnet 5. Then summarise.', SONNET_5],
    ['use Sonnet 5', SONNET_5],
  ])('reads %p as a request for the correct model', (text, expected) => {
    expect(findModelMention(text, index)?.modelId).toBe(expected);
  });
});
