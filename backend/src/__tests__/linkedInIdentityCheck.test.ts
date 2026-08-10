/**
 * ENG-1026 — LinkedIn identity cross-check before personalized sends.
 *
 * Covers the pure check (crossCheckProfileIdentity) and the shared async guard
 * (verifyLinkedInIdentityForSend) used by both the CRM REST routes and the
 * agent-mode linkedinOutreach tool paths.
 *
 * Contract:
 *  1. Company mismatch between the live profile and the lead → refuse.
 *  2. Successful cross-check → linkedinIdentityVerifiedAt + verified URL stamped
 *     via crmDb.updateLead.
 *  3. No company on the lead / no lead context → do not block, do not stamp.
 *  4. Name mismatch alone → refuse (reuses unipileNameMatches).
 *  5. Previously verified lead (stamp + same canonical URL) → skip the re-fetch.
 *  Fail OPEN on infra errors (profile fetch throws) — only positive mismatch
 *  evidence refuses.
 */

const mockGetLinkedInProfile = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    getLinkedInProfile: (...args: any[]) => mockGetLinkedInProfile(...args),
  },
}));

const mockUpdateLead = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/db', () => ({
  crmDb: {
    updateLead: (...args: any[]) => mockUpdateLead(...args),
  },
}));

import {
  crossCheckProfileIdentity,
  verifyLinkedInIdentityForSend,
} from '../services/linkedInIdentityCheck';

// The concrete production failure: lead Florence Su (VP Performance Marketing,
// Vivian Health) whose stored slug resolves to a different Florence Su (TPM at
// Snowflake).
const snowflakeProfile = {
  first_name: 'Florence',
  last_name: 'Su',
  headline: 'Technical Program Manager at Snowflake',
  work_experience: [{ position: 'Technical Program Manager', company: 'Snowflake', current: true }],
};

const vivianLead = {
  firstName: 'Florence',
  lastName: 'Su',
  company: 'Vivian Health',
  linkedin: 'https://www.linkedin.com/in/florencesu',
};

describe('crossCheckProfileIdentity (pure)', () => {
  it('refuses on company mismatch (Florence Su case)', () => {
    const res = crossCheckProfileIdentity(snowflakeProfile, vivianLead);
    expect(res.verdict).toBe('mismatch');
  });

  it('matches when the current employer equals the lead company (suffix/case tolerant)', () => {
    const res = crossCheckProfileIdentity(
      {
        first_name: 'Florence',
        last_name: 'Su',
        work_experience: [{ position: 'VP Performance Marketing', company: 'Vivian Health, Inc.', current: true }],
      },
      vivianLead,
    );
    expect(res.verdict).toBe('match');
  });

  it('matches on headline containment ("VP Marketing @ Vivian Health")', () => {
    const res = crossCheckProfileIdentity(
      { name: 'Florence Su', headline: 'VP Marketing @ Vivian Health' },
      vivianLead,
    );
    expect(res.verdict).toBe('match');
  });

  it('is unverifiable when the lead has no company', () => {
    const res = crossCheckProfileIdentity(snowflakeProfile, {
      firstName: 'Florence',
      lastName: 'Su',
    });
    expect(res.verdict).toBe('unverifiable');
  });

  it('is unverifiable when the profile carries no company or headline signal', () => {
    const res = crossCheckProfileIdentity({ first_name: 'Florence', last_name: 'Su' }, vivianLead);
    expect(res.verdict).toBe('unverifiable');
  });

  it('refuses on a clear name mismatch even when company is absent on the profile', () => {
    const res = crossCheckProfileIdentity(
      { first_name: 'Bob', last_name: 'Jones' },
      vivianLead,
    );
    expect(res.verdict).toBe('mismatch');
  });
});

describe('verifyLinkedInIdentityForSend (shared guard)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseOpts = {
    listId: 'list-1',
    leadId: 'lead-1',
    profileUrl: 'https://www.linkedin.com/in/florencesu',
    accountId: 'acct-1',
  };

  it('refuses the send with a structured error on mismatch and does not stamp', async () => {
    mockGetLinkedInProfile.mockResolvedValue(snowflakeProfile);
    const res = await verifyLinkedInIdentityForSend({ ...baseOpts, lead: vivianLead });
    expect(res.allowed).toBe(false);
    expect((res as any).refusal).toMatchObject({
      code: 'linkedin_identity_mismatch',
      details: expect.objectContaining({
        leadCompany: 'Vivian Health',
        profileName: expect.stringContaining('Florence'),
      }),
    });
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('stamps linkedinIdentityVerifiedAt + verified URL on a successful cross-check', async () => {
    mockGetLinkedInProfile.mockResolvedValue({
      first_name: 'Florence',
      last_name: 'Su',
      work_experience: [{ position: 'VP Performance Marketing', company: 'Vivian Health', current: true }],
    });
    const res = await verifyLinkedInIdentityForSend({ ...baseOpts, lead: vivianLead });
    expect(res.allowed).toBe(true);
    expect(mockUpdateLead).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({
      linkedinIdentityVerifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      linkedinIdentityVerifiedUrl: 'https://www.linkedin.com/in/florencesu',
    }));
  });

  it('does not block or stamp when the lead has no company and no name', async () => {
    const res = await verifyLinkedInIdentityForSend({
      ...baseOpts,
      lead: { linkedin: 'https://www.linkedin.com/in/florencesu' },
    });
    expect(res.allowed).toBe(true);
    expect(mockGetLinkedInProfile).not.toHaveBeenCalled();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('does not block when there is no lead context at all', async () => {
    const res = await verifyLinkedInIdentityForSend({ ...baseOpts, lead: null });
    expect(res.allowed).toBe(true);
    expect(mockGetLinkedInProfile).not.toHaveBeenCalled();
  });

  it('fails open (allows, no stamp) when the profile fetch throws', async () => {
    mockGetLinkedInProfile.mockRejectedValue(new Error('unipile 500'));
    const res = await verifyLinkedInIdentityForSend({ ...baseOpts, lead: vivianLead });
    expect(res.allowed).toBe(true);
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('skips the re-fetch entirely for a previously verified lead with the same URL', async () => {
    const res = await verifyLinkedInIdentityForSend({
      ...baseOpts,
      lead: {
        ...vivianLead,
        linkedinIdentityVerifiedAt: '2026-08-01T00:00:00.000Z',
        linkedinIdentityVerifiedUrl: 'https://linkedin.com/in/florencesu/',
      },
    });
    expect(res.allowed).toBe(true);
    expect(mockGetLinkedInProfile).not.toHaveBeenCalled();
  });

  it('re-checks when the stamped URL differs from the current lead URL', async () => {
    mockGetLinkedInProfile.mockResolvedValue(snowflakeProfile);
    const res = await verifyLinkedInIdentityForSend({
      ...baseOpts,
      lead: {
        ...vivianLead,
        linkedinIdentityVerifiedAt: '2026-08-01T00:00:00.000Z',
        linkedinIdentityVerifiedUrl: 'https://www.linkedin.com/in/some-other-slug',
      },
    });
    expect(mockGetLinkedInProfile).toHaveBeenCalled();
    expect(res.allowed).toBe(false);
  });
});
