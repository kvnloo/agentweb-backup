import { inferSearchFreshness } from '../search/searchFreshness';

describe('inferSearchFreshness', () => {
  it('requests day freshness for immediate news queries', () => {
    expect(inferSearchFreshness('Nvidia stock AI news today Reuters')).toBe('day');
    expect(inferSearchFreshness('breaking OpenAI platform outage')).toBe('day');
  });

  it('requests week freshness for latest/current/update queries', () => {
    expect(inferSearchFreshness('OpenAI latest release notes')).toBe('week');
    expect(inferSearchFreshness('current enterprise AI agent news')).toBe('week');
    expect(inferSearchFreshness('Vercel AI SDK changelog')).toBe('week');
  });

  it('does not apply a freshness filter to exact company or domain lookups', () => {
    expect(inferSearchFreshness('Charlie Moss tmg.guru AI transformation GTM advisory')).toBeUndefined();
    expect(inferSearchFreshness('site:tmg.guru')).toBeUndefined();
  });

  it('prioritizes day freshness when day and week signals both appear', () => {
    expect(inferSearchFreshness('latest Federal Reserve decision today')).toBe('day');
  });
});
