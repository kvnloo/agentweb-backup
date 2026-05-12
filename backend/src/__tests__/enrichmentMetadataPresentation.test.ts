// Sanitizer for CRM-history Tier 0 metadata before sending to the customer-portal.
// Internal storage retains source: 'crm-history' + siblingLeadId/ListId/UserId
// for audit; the response API surface remaps source to 'agentweb' and strips
// the sibling fields.

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

  it('handles null / undefined leads', () => {
    expect(sanitizeLeadForResponse(null)).toBeNull();
    expect(sanitizeLeadForResponse(undefined)).toBeUndefined();
  });
});
