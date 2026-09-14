import {
  assertOpenRouterResponseHasChoices,
  isMalformedOpenRouterResponseError,
  MALFORMED_OPENROUTER_RESPONSE_PREFIX,
} from '../openRouterResponseValidation';

describe('assertOpenRouterResponseHasChoices (ENG-1681)', () => {
  it('does not throw when choices is a present array (even empty)', () => {
    expect(() => assertOpenRouterResponseHasChoices({ choices: [] }, 'gpt-5.5')).not.toThrow();
    expect(() => assertOpenRouterResponseHasChoices(
      { choices: [{ message: { content: 'hi' } }] }, 'gpt-5.5',
    )).not.toThrow();
  });

  it('throws a MALFORMED_OPENROUTER_RESPONSE error naming the model when choices is missing', () => {
    expect(() => assertOpenRouterResponseHasChoices({ usage: {} }, 'gpt-5.5'))
      .toThrow(new RegExp(`${MALFORMED_OPENROUTER_RESPONSE_PREFIX}.*gpt-5\\.5`));
  });

  it('throws when choices is present but not an array', () => {
    expect(() => assertOpenRouterResponseHasChoices({ choices: 'not-an-array' }, 'gpt-5.5'))
      .toThrow(MALFORMED_OPENROUTER_RESPONSE_PREFIX);
  });

  it('throws when the response itself is null or undefined', () => {
    expect(() => assertOpenRouterResponseHasChoices(null, 'gpt-5.5')).toThrow(MALFORMED_OPENROUTER_RESPONSE_PREFIX);
    expect(() => assertOpenRouterResponseHasChoices(undefined, 'gpt-5.5')).toThrow(MALFORMED_OPENROUTER_RESPONSE_PREFIX);
  });
});

describe('isMalformedOpenRouterResponseError (ENG-1681)', () => {
  it('matches the SDK JSON-parse-failure message', () => {
    const error = new Error(
      'invalid json response body at https://openrouter.ai/api/v1/chat/completions reason: Unexpected end of JSON input',
    );
    expect(isMalformedOpenRouterResponseError(error)).toBe(true);
  });

  it('matches the MALFORMED_OPENROUTER_RESPONSE error thrown by assertOpenRouterResponseHasChoices', () => {
    let thrown: unknown;
    try {
      assertOpenRouterResponseHasChoices({}, 'gpt-5.5');
    } catch (err) {
      thrown = err;
    }
    expect(isMalformedOpenRouterResponseError(thrown)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMalformedOpenRouterResponseError(new Error('UNEXPECTED END OF JSON INPUT'))).toBe(true);
  });

  it('does NOT match unrelated errors, including the two still-open OpenRouter routing signatures', () => {
    expect(isMalformedOpenRouterResponseError(new Error('rate limited'))).toBe(false);
    expect(isMalformedOpenRouterResponseError(Object.assign(new Error('Provider returned error'), { status: 400 }))).toBe(false);
    expect(isMalformedOpenRouterResponseError(Object.assign(
      new Error('No endpoints found that can handle the requested parameters'), { status: 404 },
    ))).toBe(false);
  });

  it('handles a non-Error thrown value without throwing itself', () => {
    expect(isMalformedOpenRouterResponseError('invalid json response body')).toBe(true);
    expect(isMalformedOpenRouterResponseError(undefined)).toBe(false);
  });
});
