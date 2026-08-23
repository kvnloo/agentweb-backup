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
