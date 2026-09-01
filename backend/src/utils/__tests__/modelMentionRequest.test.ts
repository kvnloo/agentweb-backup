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

describe('buildModelMentionAck', () => {
  const mention = { modelId: OPUS_5, matchedText: 'Opus 5' };

  it('names both models when the request is selectable but was not applied', () => {
    const note = buildModelMentionAck(mention, FLASH_LITE, true, index);
    expect(note).toContain('Gemini 3.1 Flash Lite');
    expect(note).toContain('Claude Opus 5');
    expect(note).toMatch(/model selector/i);
  });

  it('says the model is unavailable when the account cannot select it', () => {
    const note = buildModelMentionAck(mention, FLASH_LITE, false, index);
    expect(note).toMatch(/isn't available on your account/i);
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
    expect(out).toMatch(/isn't available on your account/i);
  });
});
