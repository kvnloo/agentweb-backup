/**
 * `findSiblingLeads` must tag HOW each sibling was found.
 *
 * The consumer — enrichmentIdentityResolver's cross-tenant email guard — reads that tag:
 *
 *   const weakMatch = sib.matchedBy ? sib.matchedBy === 'nameCompany' : !strongAnchor;
 *
 * It degrades GRACEFULLY when the tag is missing, which is what makes its absence
 * dangerous. With no tag, every sibling falls back to the coarse `!strongAnchor` test — so
 * a lead that HAS a linkedin (strongAnchor true) waves through name+company siblings from
 * `findLeadsByNameCompany`, a table-wide GSI query with NO listId or userId predicate.
 * A stranger's address then gets copied onto the lead, written into email-index, and the
 * lead becomes mailable at it.
 *
 * The resolver's own tests hand-fabricate siblings against a `jest.fn()`, so deleting
 * `item.matchedBy = matchedBy` here left all 1,280 enrichment tests green. This pins the
 * producer.
 */
const mockFindLeadsByEmail = jest.fn();
const mockFindLeadsByLinkedin = jest.fn();
const mockFindLeadsByNameCompany = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    findLeadsByEmail: (...a: any[]) => mockFindLeadsByEmail(...a),
    findLeadsByLinkedin: (...a: any[]) => mockFindLeadsByLinkedin(...a),
    findLeadsByNameCompany: (...a: any[]) => mockFindLeadsByNameCompany(...a),
  },
  userDb: {},
}));

import { buildIdentityDeps } from '../services/enrichmentV3RealDeps';

beforeEach(() => {
  jest.clearAllMocks();
  mockFindLeadsByEmail.mockResolvedValue([]);
  mockFindLeadsByLinkedin.mockResolvedValue([]);
  mockFindLeadsByNameCompany.mockResolvedValue([]);
});

const find = (args: any) => buildIdentityDeps('user-1').findSiblingLeads!(args);

describe('buildIdentityDeps().findSiblingLeads — matchedBy provenance', () => {
  it('tags each sibling with the anchor that found it', async () => {
    mockFindLeadsByEmail.mockResolvedValue([{ leadId: 'by-email', updatedAt: '2026-01-01' }]);
    mockFindLeadsByLinkedin.mockResolvedValue([{ leadId: 'by-li', updatedAt: '2026-01-01' }]);
    mockFindLeadsByNameCompany.mockResolvedValue([{ leadId: 'by-nc', updatedAt: '2026-01-01' }]);

    const sibs = await find({
      excludeLeadId: 'self', email: 'ada@x.com',
      linkedinUrl: 'https://linkedin.com/in/ada',
      firstName: 'Ada', lastName: 'L', company: 'Acme',
    });

    const tagged = Object.fromEntries(sibs.map((s: any) => [s.leadId, s.matchedBy]));
    expect(tagged).toEqual({ 'by-email': 'email', 'by-li': 'linkedin', 'by-nc': 'nameCompany' });
  });

  it('never leaves a sibling untagged — an untagged one silently bypasses the guard', async () => {
    mockFindLeadsByNameCompany.mockResolvedValue([
      { leadId: 'n1', updatedAt: '2026-01-02' },
      { leadId: 'n2', updatedAt: '2026-01-01' },
    ]);

    const sibs = await find({
      excludeLeadId: 'self', firstName: 'Ada', lastName: 'L', company: 'Acme',
    });

    expect(sibs).toHaveLength(2);
    // `undefined` here is what flips the resolver onto its coarse fallback.
    for (const s of sibs as any[]) expect(s.matchedBy).toBe('nameCompany');
  });

  it('tags a sibling found by BOTH email and name+company as the stronger anchor', async () => {
    const shared = { leadId: 'dup', updatedAt: '2026-01-01' };
    mockFindLeadsByEmail.mockResolvedValue([{ ...shared }]);
    mockFindLeadsByNameCompany.mockResolvedValue([{ ...shared }]);

    const sibs = await find({
      excludeLeadId: 'self', email: 'ada@x.com',
      firstName: 'Ada', lastName: 'L', company: 'Acme',
    });

    expect(sibs).toHaveLength(1);
    // Tagged `email`, not `nameCompany` — otherwise a legitimate email sibling would be
    // treated as a weak guess and refused.
    expect((sibs[0] as any).matchedBy).toBe('email');
  });

  it('excludes the lead itself', async () => {
    mockFindLeadsByEmail.mockResolvedValue([
      { leadId: 'self', updatedAt: '2026-01-01' },
      { leadId: 'other', updatedAt: '2026-01-01' },
    ]);

    const sibs = await find({ excludeLeadId: 'self', email: 'ada@x.com' });
    expect(sibs.map((s: any) => s.leadId)).toEqual(['other']);
  });
});
