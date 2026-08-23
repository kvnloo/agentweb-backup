import {
  DEFAULT_NEW_CHAT_HERO_GREETING,
  parseNewChatHeroGreetingSetting,
  validateNewChatHeroGreeting,
} from '../utils/newChatHeroGreeting';

describe('New Chat hero greeting presentation contract', () => {
  it('keeps the approved named and anonymous defaults', () => {
    expect(DEFAULT_NEW_CHAT_HERO_GREETING).toEqual({
      namedTemplate: "Hey {firstName}! Let's get after it",
      anonymousText: "Hey! Let's get after it",
    });
  });

  it('accepts the approved configuration', () => {
    expect(validateNewChatHeroGreeting(DEFAULT_NEW_CHAT_HERO_GREETING)).toBeNull();
  });

  it.each([
    [{ namedTemplate: 'Hey {email}', anonymousText: 'Hey!' }, /firstName/],
    [{ namedTemplate: 'Hey there', anonymousText: 'Hey!' }, /exactly one/],
    [{ namedTemplate: 'Hey {firstName}', anonymousText: 'Hey {firstName}' }, /does not support/],
    [{ namedTemplate: '<strong>Hey</strong>', anonymousText: 'Hey!' }, /plain text/],
    [{ namedTemplate: 'Hey {firstName}', anonymousText: '' }, /required/],
  ])('rejects unsafe or unsupported configuration %#', (value, expected) => {
    expect(validateNewChatHeroGreeting(value)).toMatch(expected as RegExp);
  });

  it('accepts the 120-character boundary for both greeting fields', () => {
    const namedTemplate = `{firstName}${'a'.repeat(109)}`;
    const anonymousText = 'a'.repeat(120);

    expect(validateNewChatHeroGreeting({ namedTemplate, anonymousText })).toBeNull();
  });

  it.each(['\u0085', '\u2028', '\u2029'])('rejects Unicode line separator %j', (separator) => {
    expect(validateNewChatHeroGreeting({
      namedTemplate: `Hey${separator}{firstName}`,
      anonymousText: 'Hey!',
    })).toMatch(/single line/);
  });

  it.each([
    { namedTemplate: `{firstName}${'a'.repeat(110)}`, anonymousText: 'a'.repeat(120) },
    { namedTemplate: `{firstName}${'a'.repeat(109)}`, anonymousText: 'a'.repeat(121) },
  ])('rejects a greeting field over the 120-character boundary', (value) => {
    expect(validateNewChatHeroGreeting(value)).toMatch(/120 characters/);
  });

  it('parses valid stored JSON and trims the two values', () => {
    expect(parseNewChatHeroGreetingSetting(JSON.stringify({
      namedTemplate: ' Welcome back, {firstName} ',
      anonymousText: ' Welcome back ',
    }))).toEqual({
      namedTemplate: 'Welcome back, {firstName}',
      anonymousText: 'Welcome back',
    });
  });

  it.each(['not json', null, [], { namedTemplate: 'Hey {email}', anonymousText: 'Hey!' }])(
    'falls back atomically for malformed storage: %#',
    (value) => {
      expect(parseNewChatHeroGreetingSetting(value)).toEqual(DEFAULT_NEW_CHAT_HERO_GREETING);
    },
  );
});
