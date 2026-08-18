/**
 * ENG-926 §G — how the destination check behaves when the ENG-941 gate misbehaves.
 *
 * The gate is mocked HERE and only here. The other fetch suite deliberately runs the real
 * one, because that is what proves the seam works; this file proves the seam survives the
 * gate returning a shape it never returns today, or throwing outright. Both matter: the gate
 * is a dependency this module does not own, and its contract can change without this one
 * being touched.
 */

const preflightMetaTrackingGate = jest.fn();
jest.mock('../services/metaTrackingPreflight', () => ({
  preflightMetaTrackingGate: (...a: any[]) => preflightMetaTrackingGate(...a),
}));

import {
  fetchDestinationInputs,
  evaluateDestinationCoverage,
} from '../services/metaDestinationCoverage';

const ADS = {
  data: [{
    id: '111',
    name: 'Lead Ad',
    campaign: { id: 'c1', name: 'Camp', objective: 'OUTCOME_LEADS' },
    creative: { object_story_spec: { link_data: { link: 'https://lander.test/lp' } } },
  }],
};
const PIXELS = { data: [{ id: '910841031004192' }] };

const metaImpl = () => jest.fn(async (url: string) => ({
  ok: true, status: 200,
  json: async () => (url.includes('/adspixels') ? PIXELS : ADS),
})) as any;

beforeEach(() => {
  preflightMetaTrackingGate.mockReset();
});

describe('the ENG-941 gate seam', () => {
  it('passes the injected fetchHtml through when one is given', async () => {
    preflightMetaTrackingGate.mockResolvedValue({ results: [] });
    const fetchHtml = async () => '<html></html>';

    await fetchDestinationInputs('123', 'tok', { fetchImpl: metaImpl(), fetchHtml });

    expect(preflightMetaTrackingGate).toHaveBeenCalledWith(
      ['https://lander.test/lp'], ['910841031004192'], { fetchHtml },
    );
  });

  it('passes NO fetchHtml in production, so the gate uses its own SSRF-guarded fetcher', async () => {
    // Forwarding `{ fetchHtml: undefined }` would override the gate's default with undefined
    // in any implementation that checks presence rather than truthiness — bypassing the
    // redirect follower and the SSRF guard, which is exactly what must not happen.
    preflightMetaTrackingGate.mockResolvedValue({ results: [] });

    await fetchDestinationInputs('123', 'tok', { fetchImpl: metaImpl() });

    expect(preflightMetaTrackingGate).toHaveBeenCalledWith(
      ['https://lander.test/lp'], ['910841031004192'], {},
    );
  });

  it('tolerates a gate result with no results array', async () => {
    preflightMetaTrackingGate.mockResolvedValue({});
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: metaImpl() });
    expect(inputs.status).toBe('ok');
    expect(inputs.observations).toEqual({});
  });

  it('tolerates a result with no mechanisms array', async () => {
    preflightMetaTrackingGate.mockResolvedValue({
      results: [{ url: 'https://lander.test/lp', status: 'unmeasured' }],
    });
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: metaImpl() });
    expect(inputs.observations['https://lander.test/lp'].detectedPixelIds).toEqual([]);
  });

  it('a gate that THROWS leaves the account judgeable but unverified — and pages nobody', async () => {
    // The Meta reads already succeeded, so discarding the ad list too would throw away good
    // work. Every destination becomes unverifiable, which is logged and alerts no one.
    preflightMetaTrackingGate.mockRejectedValue(new Error('gate exploded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: metaImpl() });

    expect(inputs.status).toBe('ok');
    expect(inputs.ads).toHaveLength(1);
    expect(inputs.observations).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gate exploded'));

    const verdict = evaluateDestinationCoverage(inputs.ads, inputs.observations, inputs.ownedPixelIds);
    expect(verdict.alerting).toEqual([]);
    expect(verdict.unverifiable).toHaveLength(1);
    warn.mockRestore();
  });

  it('a non-Error throw from the gate still logs something readable', async () => {
    preflightMetaTrackingGate.mockRejectedValue('just a string');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: metaImpl() });

    expect(inputs.status).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('§G destination fetch failed'));
    warn.mockRestore();
  });

  it('passes no fetchHtml when called with no deps object at all', async () => {
    // The production call site passes no deps. Pinned separately from the "deps without
    // fetchHtml" case because `deps?.fetchHtml` and `deps.fetchHtml` fail differently.
    preflightMetaTrackingGate.mockResolvedValue({ results: [] });
    const previous = (global as any).fetch;
    (global as any).fetch = jest.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url.includes('/adspixels') ? PIXELS : ADS),
    }));
    try {
      await fetchDestinationInputs('123', 'tok');
      expect(preflightMetaTrackingGate).toHaveBeenCalledWith(
        ['https://lander.test/lp'], ['910841031004192'], {},
      );
    } finally {
      (global as any).fetch = previous;
    }
  });

  it('a gate rejecting with null still logs, and still alerts nobody', async () => {
    preflightMetaTrackingGate.mockRejectedValue(null);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: metaImpl() });

    expect(inputs.status).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('§G destination fetch failed'));
    warn.mockRestore();
  });

  it('never calls the gate at all when there is nothing to check', async () => {
    // An account whose every ad is a lead form should cost zero HTTP fetches.
    const noDestinations = jest.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url.includes('/adspixels') ? PIXELS : { data: [{ id: '1', creative: {} }] }),
    })) as any;

    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: noDestinations });

    expect(preflightMetaTrackingGate).not.toHaveBeenCalled();
    expect(inputs.status).toBe('ok');
  });
});
