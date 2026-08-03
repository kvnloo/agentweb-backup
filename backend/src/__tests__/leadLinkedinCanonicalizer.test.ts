// ENG-787: one-time repair of legacy lead.linkedin values. This is the least
// reversible code in the change — it rewrites a GSI key across a customer's leads —
// so the no-write cases (unsupported values, dry-run) matter as much as the rewrites.

const getLeadsByListId = jest.fn();
const updateLead = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadsByListId: (...a: any[]) => getLeadsByListId(...a),
    updateLead: (...a: any[]) => updateLead(...a),
  },
}));

import { normalizeListLinkedinUrls } from '../services/leadLinkedinCanonicalizer';

const LIST = 'list_1782945941846_b0ptvsguv';
const silent = { log: () => {}, warn: () => {} };

/** Serve `pages` one call at a time, mirroring crmDb.getLeadsByListId's shape. */
function servePages(pages: any[][]) {
  let call = 0;
  getLeadsByListId.mockImplementation(async () => {
    const items = pages[call] ?? [];
    const last = call >= pages.length - 1;
    call++;
    return { items, lastEvaluatedKey: last ? null : { k: call }, hasMore: !last };
  });
}

describe('normalizeListLinkedinUrls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateLead.mockResolvedValue({});
    servePages([[]]);
  });

  // ---- FAIL / no-op cases ----

  it('returns zeros and reads nothing without a listId', async () => {
    const res = await normalizeListLinkedinUrls('', { logger: silent });
    expect(res.total).toBe(0);
    expect(getLeadsByListId).not.toHaveBeenCalled();
  });

  it('ignores leads with no linkedin value', async () => {
    servePages([[
      { leadId: 'a' },
      { leadId: 'b', linkedin: '' },
      { leadId: 'c', linkedin: '   ' },
    ]]);
    const res = await normalizeListLinkedinUrls(LIST, { logger: silent });
    expect(res.total).toBe(3);
    expect(res.withLinkedin).toBe(0);
    expect(updateLead).not.toHaveBeenCalled();
  });

  it('never writes a value it cannot canonicalize — that would DELETE the field', async () => {
    // updateLead REMOVEs linkedin when handed an empty value, so a company page or
    // free text must be left strictly alone rather than normalized to ''.
    servePages([[
      { leadId: 'a', linkedin: 'https://www.linkedin.com/company/acme' },
      { leadId: 'b', linkedin: 'jane on linkedin, ask sales' },
    ]]);
    const res = await normalizeListLinkedinUrls(LIST, { logger: silent });
    expect(res.unsupported).toBe(2);
    expect(res.normalized).toBe(0);
    expect(updateLead).not.toHaveBeenCalled();
  });

  it('writes nothing at all under dryRun while still reporting the rewrites', async () => {
    servePages([[
      { leadId: 'a', linkedin: 'http://LinkedIn.com/in/Jane-Doe/' },
      { leadId: 'b', linkedin: 'https://www.linkedin.com/in/already' },
    ]]);
    const res = await normalizeListLinkedinUrls(LIST, { dryRun: true, logger: silent });
    expect(res.normalized).toBe(1);
    expect(res.alreadyCanonical).toBe(1);
    expect(updateLead).not.toHaveBeenCalled();
  });

  it('propagates a write failure rather than reporting a repair that did not happen', async () => {
    servePages([[{ leadId: 'a', linkedin: 'http://linkedin.com/in/jane-doe/' }]]);
    updateLead.mockRejectedValue(new Error('dynamo down'));
    await expect(normalizeListLinkedinUrls(LIST, { logger: silent })).rejects.toThrow('dynamo down');
  });

  // ---- SUCCESS ----

  it('rewrites legacy formats to canonical and leaves canonical rows untouched', async () => {
    servePages([[
      { leadId: 'mixed_case', linkedin: 'https://www.linkedin.com/in/David-Yao' },
      { leadId: 'no_www', linkedin: 'https://linkedin.com/in/bala-s' },
      { leadId: 'http_scheme', linkedin: 'http://www.linkedin.com/in/anthony' },
      { leadId: 'trailing_slash', linkedin: 'https://www.linkedin.com/in/sheila/' },
      { leadId: 'tracking', linkedin: 'https://www.linkedin.com/in/rachel?miniProfileUrn=abc' },
      { leadId: 'canonical', linkedin: 'https://www.linkedin.com/in/already' },
    ]]);

    const res = await normalizeListLinkedinUrls(LIST, { logger: silent });

    expect(res.withLinkedin).toBe(6);
    expect(res.normalized).toBe(5);
    expect(res.alreadyCanonical).toBe(1);
    expect(updateLead).toHaveBeenCalledTimes(5);
    expect(updateLead).toHaveBeenCalledWith(LIST, 'mixed_case', { linkedin: 'https://www.linkedin.com/in/david-yao' });
    expect(updateLead).toHaveBeenCalledWith(LIST, 'no_www', { linkedin: 'https://www.linkedin.com/in/bala-s' });
    expect(updateLead).toHaveBeenCalledWith(LIST, 'http_scheme', { linkedin: 'https://www.linkedin.com/in/anthony' });
    expect(updateLead).toHaveBeenCalledWith(LIST, 'trailing_slash', { linkedin: 'https://www.linkedin.com/in/sheila' });
    expect(updateLead).toHaveBeenCalledWith(LIST, 'tracking', { linkedin: 'https://www.linkedin.com/in/rachel' });
    expect(updateLead).not.toHaveBeenCalledWith(LIST, 'canonical', expect.anything());
  });

  it('follows pagination instead of repairing only the first page', async () => {
    servePages([
      [{ leadId: 'p1', linkedin: 'http://linkedin.com/in/one/' }],
      [{ leadId: 'p2', linkedin: 'http://linkedin.com/in/two/' }],
    ]);
    const res = await normalizeListLinkedinUrls(LIST, { logger: silent });
    expect(res.total).toBe(2);
    expect(res.normalized).toBe(2);
    expect(getLeadsByListId).toHaveBeenCalledTimes(2);
  });

  it('reports duplicates surfaced by canonicalization without merging them', async () => {
    // Two rows for one person, stored differently — normalizing makes them collide.
    // Merging is a CRM decision; the repair only has to make it visible.
    servePages([[
      { leadId: 'dup_a', linkedin: 'https://www.linkedin.com/in/David-Yao' },
      { leadId: 'dup_b', linkedin: 'http://linkedin.com/in/david-yao/' },
      { leadId: 'unique', linkedin: 'https://www.linkedin.com/in/solo' },
    ]]);

    const res = await normalizeListLinkedinUrls(LIST, { logger: silent });

    expect(res.collisions).toBe(1);
    expect(res.collisionGroups).toEqual([
      { canonical: 'https://www.linkedin.com/in/david-yao', leadIds: ['dup_a', 'dup_b'] },
    ]);
    // Both rows still get canonicalized — the duplicate is surfaced, not hidden.
    expect(updateLead).toHaveBeenCalledTimes(2);
  });

  it('detects collisions across pages, not just within one', async () => {
    servePages([
      [{ leadId: 'a', linkedin: 'https://www.linkedin.com/in/David-Yao' }],
      [{ leadId: 'b', linkedin: 'https://www.linkedin.com/in/david-yao' }],
    ]);
    const res = await normalizeListLinkedinUrls(LIST, { logger: silent });
    expect(res.collisions).toBe(1);
    expect(res.collisionGroups[0].leadIds).toEqual(['a', 'b']);
  });
});
