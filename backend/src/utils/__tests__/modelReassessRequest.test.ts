/**
 * ENG-1565 — behavioral contract:
 * 1. A message that reads as a model-change/reassess request, followed by a turn
 *    that ran on the same model as before, gets an explicit acknowledgement that
 *    the model didn't change.
 * 2. A transcript with no such request never gets the acknowledgement (no false
 *    positives).
 */

import {
  looksLikeModelChangeRequest,
  findLastAssistantModel,
  reconcileModelReassessAck,
} from '../modelReassessRequest';

describe('looksLikeModelChangeRequest', () => {
  it.each([
    'reassess using a new model',
    'Can you reassess this with a different model?',
    'please switch to a different model',
    'try another model for this one',
    'switch models',
    'change models please',
    'use a different model this time',
    'can you pick another model',
  ])('detects %p', (text) => {
    expect(looksLikeModelChangeRequest(text)).toBe(true);
  });

  it.each([
    'reassess the situation for me',
    'update the pricing model',
    'change the business model to a subscription model',
    'what data model does this use?',
    'write me a haiku',
    'can you use sonnet for a poem',
    'change the report format',
    // CodeRabbit (PR #2642): negation and explanatory questions are not requests.
    'Do not switch to a different model',
    "please don't try another model",
    'never switch to a different model without asking me first',
    'What does it mean to switch to a different model?',
    'What is a different model in this context?',
    'Why would I switch to a different model?',
    '',
    null,
    undefined,
  ])('does NOT flag %p (no false positive)', (text) => {
    expect(looksLikeModelChangeRequest(text as any)).toBe(false);
  });
});

describe('findLastAssistantModel', () => {
  it('returns the last assistant turn\'s recorded model', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', llm: 'gpt-5.6' },
      { role: 'user', content: 'again' },
      { role: 'assistant', llm: 'gemini-3.7-flash' },
    ];
    expect(findLastAssistantModel(messages)).toBe('gemini-3.7-flash');
  });

  it('skips trailing non-assistant messages', () => {
    const messages = [
      { role: 'assistant', llm: 'gemini-3.7-flash' },
      { role: 'user', content: 'ok' },
    ];
    expect(findLastAssistantModel(messages)).toBe('gemini-3.7-flash');
  });

  it('returns null when the last assistant turn recorded no model', () => {
    const messages = [{ role: 'assistant', content: 'hi' }];
    expect(findLastAssistantModel(messages)).toBeNull();
  });

  it('returns null for empty/missing history', () => {
    expect(findLastAssistantModel([])).toBeNull();
    expect(findLastAssistantModel(null)).toBeNull();
    expect(findLastAssistantModel(undefined)).toBeNull();
  });
});

describe('reconcileModelReassessAck', () => {
  const CONTENT = 'Here is the daily activity report.';

  it('appends the acknowledgement when the request matches and the model is unchanged', () => {
    const result = reconcileModelReassessAck(
      CONTENT,
      'reassess using a new model',
      'gemini-3.7-flash',
      'gemini-3.7-flash',
    );
    expect(result).toContain(CONTENT);
    expect(result).toContain("can't switch models from a chat message");
    expect(result).toContain('gemini-3.7-flash');
  });

  it('does NOT append when the message is not a model-change request', () => {
    const result = reconcileModelReassessAck(
      CONTENT,
      'can you also check the CRM for new leads',
      'gemini-3.7-flash',
      'gemini-3.7-flash',
    );
    expect(result).toBe(CONTENT);
  });

  it('does NOT append when the model actually changed (e.g. picker flipped in the same request)', () => {
    const result = reconcileModelReassessAck(
      CONTENT,
      'reassess using a new model',
      'gemini-3.7-flash',
      'claude-sonnet-5',
    );
    expect(result).toBe(CONTENT);
  });

  it('does NOT append when there is no prior model to compare against (unknown history)', () => {
    const result = reconcileModelReassessAck(
      CONTENT,
      'reassess using a new model',
      null,
      'gemini-3.7-flash',
    );
    expect(result).toBe(CONTENT);
  });

  it('is a no-op on empty content', () => {
    const result = reconcileModelReassessAck(
      '',
      'reassess using a new model',
      'gemini-3.7-flash',
      'gemini-3.7-flash',
    );
    expect(result).toBe('');
  });
});
