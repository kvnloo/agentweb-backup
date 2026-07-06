// Regression test for the __mocks__/twitter-api-v2.ts safety net.
//
// twitterService.test.ts and twitterAuth.test.ts both provide their own
// jest.mock('twitter-api-v2', factory), which normally takes precedence over this file.
// This test deliberately does NOT call jest.mock('twitter-api-v2', ...), so module
// resolution falls through to the moduleNameMapper entry in jest.config.js — proving that
// any test which (for whatever reason) ends up without an active per-file mock gets routed
// to this safe fallback instead of the real SDK, and fails loudly instead of silently
// making a live HTTP call to X's production API.
import { TwitterApi } from 'twitter-api-v2';

describe('twitter-api-v2 manual mock safety net', () => {
  it('throws a clear diagnostic error instead of reaching the real SDK', () => {
    const client = new TwitterApi({ clientId: 'x', clientSecret: 'y' });
    expect(() => client.refreshOAuth2Token('refresh-token')).toThrow(/real SDK was reached/);
    expect(() => client.generateOAuth2AuthLink('http://localhost/callback', { scope: [] })).toThrow(
      /real SDK was reached/
    );
    expect(() => client.loginWithOAuth2({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).toThrow(
      /real SDK was reached/
    );
  });

  it('throws for any v2/v1 client method call, not just top-level methods', () => {
    const client = new TwitterApi('access-token');
    expect(() => (client.v2 as any).tweet({ text: 'hi' })).toThrow(/real SDK was reached/);
    expect(() => (client.v1 as any).tweet('hi')).toThrow(/real SDK was reached/);
  });
});
