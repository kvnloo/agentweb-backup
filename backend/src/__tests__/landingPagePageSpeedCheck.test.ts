/**
 * ENG-2193 (ENG-2128 B): PageSpeed Insights (Lighthouse) performance/accessibility check for
 * deployed landing pages.
 */
jest.mock('../services/seoService', () => ({
  getPageSpeedApiKey: jest.fn(),
}));

import { getPageSpeedApiKey } from '../services/seoService';
import { runLandingPagePageSpeedCheck } from '../services/landingPagePageSpeedCheck';

const mockedGetPageSpeedApiKey = getPageSpeedApiKey as jest.MockedFunction<typeof getPageSpeedApiKey>;

describe('runLandingPagePageSpeedCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fails fast with no URL', async () => {
    const result = await runLandingPagePageSpeedCheck(undefined);
    expect(result).toMatchObject({ ok: false, error: 'no URL to check' });
    expect(mockedGetPageSpeedApiKey).not.toHaveBeenCalled();
  });

  it('fails when no PageSpeed API key is configured', async () => {
    mockedGetPageSpeedApiKey.mockResolvedValue(null);
    const result = await runLandingPagePageSpeedCheck('https://example.com/lander');
    expect(result).toMatchObject({ ok: false, error: 'PageSpeed API key unavailable' });
  });

  it('requests performance + accessibility (not seo) in one call, and reads both scores', async () => {
    mockedGetPageSpeedApiKey.mockResolvedValue('test-key');
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        lighthouseResult: {
          categories: {
            performance: { score: 0.87 },
            accessibility: { score: 0.95 },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await runLandingPagePageSpeedCheck('https://example.com/lander');

    expect(result).toMatchObject({ ok: true, performanceScore: 87, accessibilityScore: 95 });
    expect(result.checkedAt).toEqual(expect.any(String));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
    );
    expect(calledUrl.searchParams.get('url')).toBe('https://example.com/lander');
    expect(calledUrl.searchParams.getAll('category')).toEqual(['performance', 'accessibility']);
    expect(calledUrl.searchParams.get('category')).not.toBe('seo');
    expect(calledUrl.searchParams.get('strategy')).toBe('mobile');
    expect(calledUrl.searchParams.get('key')).toBe('test-key');
  });

  it('reports a non-ok HTTP response as a failed result, not a throw', async () => {
    mockedGetPageSpeedApiKey.mockResolvedValue('test-key');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: { message: 'quota exceeded' } }),
    }) as unknown as typeof fetch;

    const result = await runLandingPagePageSpeedCheck('https://example.com/lander');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('429');
    expect(result.error).toContain('quota exceeded');
  });

  it('reports a missing performance/accessibility score as a failed result', async () => {
    mockedGetPageSpeedApiKey.mockResolvedValue('test-key');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lighthouseResult: { categories: {} } }),
    }) as unknown as typeof fetch;

    const result = await runLandingPagePageSpeedCheck('https://example.com/lander');
    expect(result).toMatchObject({
      ok: false,
      error: 'PageSpeed response had no performance or accessibility score',
    });
  });

  it('never throws — a network error comes back as a failed result', async () => {
    mockedGetPageSpeedApiKey.mockResolvedValue('test-key');
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

    const result = await runLandingPagePageSpeedCheck('https://example.com/lander');
    expect(result).toMatchObject({ ok: false, error: 'ECONNRESET' });
  });
});
