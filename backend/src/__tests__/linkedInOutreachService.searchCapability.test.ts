/**
 * ENG-975 — people-search capability canary.
 *
 * An account can lose its people-search capability (an open Unipile incident as
 * of 2026-08 — LinkedIn is rolling out Classic Search changes account by
 * account — or a commercial-use limit / search restriction) while leaving
 * profile reads and invitation lists fully functional. Unipile relays that as
 * HTTP 200 with `items: []` and
 * `paging.total_count: 0` — byte for byte identical to a genuine no-match, so a
 * caller cannot tell "nobody matches" from "search is broken". Confirmed in
 * production: every query on one account returned that exact payload while
 * get-profile on the same account returned a full live profile.
 *
 * `probeSearchCapability` is the discriminator: it re-runs one maximally broad
 * control query on the same account. A zero on THAT proves the account cannot
 * search at all.
 */

jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
}));

import { LinkedInOutreachService } from '../services/linkedInOutreachService';

function makeService(send: jest.Mock) {
  const svc = new LinkedInOutreachService();
  jest.spyOn(svc, 'getClient').mockResolvedValue({ request: { send } } as any);
  return svc;
}

/** The exact payload production returned for every query on the broken account. */
const EMPTY_SEARCH_PAYLOAD = {
  object: 'LinkedinSearch',
  items: [],
  config: { params: { api: 'classic', category: 'people' } },
  paging: { start: 0, page_count: 0, total_count: 0 },
  cursor: null,
};

describe('LinkedInOutreachService.probeSearchCapability (ENG-975)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports degraded when the broad control query also returns zero people', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_SEARCH_PAYLOAD);
    const svc = makeService(send);

    await expect(svc.probeSearchCapability('acct-broken')).resolves.toBe('degraded');
  });

  it('reports ok when the control query returns people (a zero elsewhere is a real no-match)', async () => {
    const send = jest.fn().mockResolvedValue({
      object: 'LinkedinSearch',
      items: [{ provider_id: 'p-1' }],
      paging: { start: 0, page_count: 1, total_count: 300 },
      cursor: 'c1',
    });
    const svc = makeService(send);

    await expect(svc.probeSearchCapability('acct-ok')).resolves.toBe('ok');
  });

  it('sends a keyword-only classic people search on the SAME account', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_SEARCH_PAYLOAD);
    const svc = makeService(send);

    await svc.probeSearchCapability('acct-1');

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: ['linkedin', 'search'],
      parameters: { account_id: 'acct-1' },
      body: expect.objectContaining({ api: 'classic', category: 'people' }),
    }));
    const body = send.mock.calls[0][0].body;
    expect(typeof body.keywords).toBe('string');
    expect(body.keywords.length).toBeGreaterThan(0);
  });

  // Same philosophy as the ENG-281 session probe: a probe that could not run
  // proves nothing, so it must never be reported as a proven breakage — and
  // must never be cached, or one blip suppresses the account for the window.
  it('reports unknown (and does not cache) when the probe itself fails', async () => {
    const send = jest.fn().mockRejectedValue(new Error('upstream 502'));
    const svc = makeService(send);

    await expect(svc.probeSearchCapability('acct-flaky')).resolves.toBe('unknown');

    send.mockResolvedValue(EMPTY_SEARCH_PAYLOAD);
    await expect(svc.probeSearchCapability('acct-flaky')).resolves.toBe('degraded');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('caches a determinate verdict per account so a paging/multi-query run pays one probe', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_SEARCH_PAYLOAD);
    const svc = makeService(send);

    await expect(svc.probeSearchCapability('acct-2')).resolves.toBe('degraded');
    await expect(svc.probeSearchCapability('acct-2')).resolves.toBe('degraded');
    await expect(svc.probeSearchCapability('acct-2')).resolves.toBe('degraded');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('scopes the verdict per account — one broken account never condemns another', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce(EMPTY_SEARCH_PAYLOAD)
      .mockResolvedValueOnce({ items: [{ provider_id: 'p-1' }] });
    const svc = makeService(send);

    await expect(svc.probeSearchCapability('acct-broken')).resolves.toBe('degraded');
    await expect(svc.probeSearchCapability('acct-healthy')).resolves.toBe('ok');
  });

  it('clearSearchCapabilityCache forces the next probe to re-run', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_SEARCH_PAYLOAD);
    const svc = makeService(send);

    await svc.probeSearchCapability('acct-3');
    svc.clearSearchCapabilityCache('acct-3');
    await svc.probeSearchCapability('acct-3');

    expect(send).toHaveBeenCalledTimes(2);
  });

  // searchPeople itself must stay a thin pass-through: enrichment runs narrow
  // name searches that legitimately return zero all day, and probing there would
  // double every one of those calls against LinkedIn's rate limits.
  it('searchPeople does not probe on its own — the guard belongs to the agent-facing callers', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_SEARCH_PAYLOAD);
    const svc = makeService(send);

    const result = await svc.searchPeople('acct-4', { keywords: 'someone very specific' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual(EMPTY_SEARCH_PAYLOAD);
  });
});
