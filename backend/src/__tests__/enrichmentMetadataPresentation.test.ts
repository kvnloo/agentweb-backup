// Sanitizer for CRM-history Tier 0 metadata before sending to the customer-portal.
// Internal storage retains source: 'crm-history' + siblingLeadId/ListId/UserId
// for audit; the response API surface remaps source to 'agentweb' and strips
// the sibling fields.

const mockIsEnigmaEnabled = jest.fn();
jest.mock('../services/enigmaCardRevenueEnrichment', () => ({
  isEnigmaEnrichmentEnabledForUser: (...args: any[]) => mockIsEnigmaEnabled(...args),
}));

import {
  sanitizeEnrichmentFieldMeta,
  sanitizeEnrichmentMetadataForResponse,
  sanitizeLeadForResponse,
} from '../utils/enrichmentMetadataPresentation';

describe('sanitizeEnrichmentFieldMeta', () => {
  it('rewrites source:crm-history to agentweb', () => {
    const result = sanitizeEnrichmentFieldMeta({
      source: 'crm-history',
      provider: 'agentweb',
      enrichedAt: '2026-05-12T00:00:00Z',
    });
    expect(result?.source).toBe('agentweb');
  });

  it('strips siblingLeadId / siblingListId / siblingUserId', () => {
    const result = sanitizeEnrichmentFieldMeta({
      source: 'crm-history',
      siblingLeadId: 'lead-x',
      siblingListId: 'list-y',
      siblingUserId: 'user-z',
      enrichedAt: '2026-05-12T00:00:00Z',
    });
    expect(result).not.toHaveProperty('siblingLeadId');
    expect(result).not.toHaveProperty('siblingListId');
    expect(result).not.toHaveProperty('siblingUserId');
  });

  it('does not modify other source values', () => {
    const result = sanitizeEnrichmentFieldMeta({
      source: 'api',
      provider: 'apollo',
      enrichedAt: '2026-05-12T00:00:00Z',
    });
    expect(result?.source).toBe('api');
    expect(result?.provider).toBe('apollo');
  });

  it('returns the input unchanged when it is null/undefined', () => {
    expect(sanitizeEnrichmentFieldMeta(undefined)).toBeUndefined();
    expect(sanitizeEnrichmentFieldMeta(null)).toBeNull();
  });

  it('preserves verified/rejected/criticVerdict and other fields', () => {
    const result = sanitizeEnrichmentFieldMeta({
      source: 'crm-history',
      siblingLeadId: 'lead-x',
      verifiedBy: { userId: 'u1', at: '2026-05-12T00:00:00Z' },
      criticVerdict: 'supported',
      enrichedAt: '2026-05-12T00:00:00Z',
    });
    expect(result?.verifiedBy).toEqual({ userId: 'u1', at: '2026-05-12T00:00:00Z' });
    expect(result?.criticVerdict).toBe('supported');
  });
});

describe('sanitizeEnrichmentMetadataForResponse', () => {
  it('sanitizes every field meta in the map', () => {
    const result = sanitizeEnrichmentMetadataForResponse({
      firstName: { source: 'crm-history', siblingLeadId: 'a', enrichedAt: 't' },
      lastName: { source: 'api', provider: 'apollo', enrichedAt: 't' },
      company: { source: 'crm-history', siblingUserId: 'u', enrichedAt: 't' },
    });
    expect(result?.firstName.source).toBe('agentweb');
    expect(result?.firstName).not.toHaveProperty('siblingLeadId');
    expect(result?.lastName.source).toBe('api');
    expect(result?.company.source).toBe('agentweb');
    expect(result?.company).not.toHaveProperty('siblingUserId');
  });

  it('returns input unchanged when undefined/empty', () => {
    expect(sanitizeEnrichmentMetadataForResponse(undefined)).toBeUndefined();
    expect(sanitizeEnrichmentMetadataForResponse({})).toEqual({});
  });
});

describe('sanitizeLeadForResponse', () => {
  it('replaces enrichmentMetadata with the sanitized version', () => {
    const lead = {
      leadId: 'lead-1',
      firstName: 'Jane',
      enrichmentMetadata: {
        firstName: { source: 'crm-history', siblingLeadId: 'sib', enrichedAt: 't' },
      },
    };
    const out = sanitizeLeadForResponse(lead);
    expect(out?.enrichmentMetadata.firstName.source).toBe('agentweb');
    expect(out?.enrichmentMetadata.firstName).not.toHaveProperty('siblingLeadId');
    // Caller's lead is untouched (shallow clone)
    expect(lead.enrichmentMetadata.firstName).toHaveProperty('siblingLeadId');
  });

  it('returns the lead unchanged when it has no enrichmentMetadata', () => {
    const lead: { leadId: string; firstName: string; enrichmentMetadata?: any } = { leadId: 'lead-1', firstName: 'Jane' };
    expect(sanitizeLeadForResponse(lead)).toBe(lead);
  });

  it.each([undefined, 'allowlisted-admin', 'org-mate'])('hides the internal send claim for viewer %s without changing the stored lead', (viewer) => {
    mockIsEnigmaEnabled.mockReturnValue(viewer === 'allowlisted-admin');
    const lead = {
      leadId: 'lead-claimed',
      emailDraftSendClaimedAt: '2026-11-13T21:28:04.142Z#claim-token',
      emailDraft: { subject: 'Draft', htmlContent: '<p>Hello</p>' },
      customFields: { industry: 'Software' },
    };
    const out = sanitizeLeadForResponse(lead, viewer)!;
    expect(out).not.toHaveProperty('emailDraftSendClaimedAt');
    expect(out.emailDraft).toEqual(lead.emailDraft);
    expect(out.customFields.industry).toBe('Software');
    expect(lead.emailDraftSendClaimedAt).toContain('claim-token');
  });

  it('handles null / undefined leads', () => {
    expect(sanitizeLeadForResponse(null)).toBeNull();
    expect(sanitizeLeadForResponse(undefined)).toBeUndefined();
  });
});

// ENG-1388/ENG-1930: the Enigma allowlist gates who can TRIGGER a paid lookup,
// but canAccessCrmList's org-sharing path lets any same-org member READ a
// lead once it exists — with no allowlist check at all. That's the actual
// display boundary Enigma's internal-use-only licence needs, and it was
// missing until CodeRabbit caught it on agentweb#3061 (a same-org member who
// was never allowlisted could already read a co-worker's card revenue).
describe('sanitizeLeadForResponse — viewerUserId (card-revenue display boundary)', () => {
  const leadWithCardRevenue = () => ({
    leadId: 'lead-1',
    company: 'Acme',
    customFields: {
      card_revenue_12m: '4250000',
      card_revenue_period_end: '2026-06-30',
      card_revenue_yoy_growth: '0.07',
      industry: 'Software', // never gated — must survive every case below
    },
    enrichmentMetadata: {
      card_revenue_12m: { source: 'api', provider: 'enigma', enrichedAt: 't' },
      industry: { source: 'api', provider: 'apollo', enrichedAt: 't' },
    },
  });

  beforeEach(() => jest.clearAllMocks());

  it('strips card-revenue fields when the viewer is not Enigma-allowlisted', () => {
    mockIsEnigmaEnabled.mockReturnValue(false);
    const out = sanitizeLeadForResponse(leadWithCardRevenue(), 'org-mate-not-allowlisted')!;

    expect(out.customFields).not.toHaveProperty('card_revenue_12m');
    expect(out.customFields).not.toHaveProperty('card_revenue_period_end');
    expect(out.customFields).not.toHaveProperty('card_revenue_yoy_growth');
    expect(out.customFields.industry).toBe('Software');
    expect(out.enrichmentMetadata).not.toHaveProperty('card_revenue_12m');
    expect(out.enrichmentMetadata.industry).toBeDefined();
    expect(mockIsEnigmaEnabled).toHaveBeenCalledWith('org-mate-not-allowlisted');
  });

  it('keeps card-revenue fields when the viewer IS Enigma-allowlisted', () => {
    mockIsEnigmaEnabled.mockReturnValue(true);
    const out = sanitizeLeadForResponse(leadWithCardRevenue(), 'allowlisted-admin')!;

    expect(out.customFields.card_revenue_12m).toBe('4250000');
    expect(out.enrichmentMetadata.card_revenue_12m).toBeDefined();
  });

  it('does NOT filter when no viewerUserId is passed (explicit opt-in, not opt-out)', () => {
    // No call sites should actually do this in crm.ts — this pins the
    // documented fallback so a future caller isn't silently unsafe by default.
    const out = sanitizeLeadForResponse(leadWithCardRevenue())!;
    expect(out.customFields.card_revenue_12m).toBe('4250000');
    expect(mockIsEnigmaEnabled).not.toHaveBeenCalled();
  });

  it('does not mutate the caller\'s original lead object', () => {
    mockIsEnigmaEnabled.mockReturnValue(false);
    const lead = leadWithCardRevenue();
    sanitizeLeadForResponse(lead, 'org-mate-not-allowlisted');
    expect(lead.customFields.card_revenue_12m).toBe('4250000');
  });

  it('strips card revenue even on a lead with no enrichmentMetadata at all', () => {
    mockIsEnigmaEnabled.mockReturnValue(false);
    const lead = { leadId: 'lead-2', customFields: { card_revenue_12m: '900000' } };
    const out = sanitizeLeadForResponse(lead, 'org-mate-not-allowlisted')!;
    expect(out.customFields).not.toHaveProperty('card_revenue_12m');
  });
});
