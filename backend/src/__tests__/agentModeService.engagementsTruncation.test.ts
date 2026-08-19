/**
 * ENG-1207 AC2 — `get_lead_engagements` reported a truncated page as a total.
 *
 * The same defect ENG-1200 turned on, in a tool the earlier fix did not reach.
 * `searchLeads` and `getLeads` were corrected in #2407; this one kept saying:
 *
 *     const limitedEngagements = engagements.slice(0, effectiveLimit);
 *     message: `Found ${limitedEngagements.length} engagement(s) for ...`
 *
 * A lead with 143 engagements returned "Found 20 engagement(s)". A model reads
 * that as "there are 20" and stops — which is precisely how a 107-lead job wrote
 * 17 records and reported success.
 *
 * This one is BETTER placed than searchLeads to satisfy the ticket literally.
 * `searchLeads` deliberately does not report "of N", because both scans break at
 * the caller's limit and any total would be invented. Here the true total is
 * already fetched and sitting unused in the same response:
 *
 *     const [engagementCount, engagementsResult] = await Promise.all([
 *       crmDb.getLeadEngagementCount(...),   // <- authoritative total
 *       crmDb.getLeadEngagements(...),       // <- unlimited, sliced afterwards
 *     ]);
 *
 * So the honest message is available for free, and AC1's example wording
 * ("Showing 20 of 98") is achievable rather than invented.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
    getLeadById: jest.fn(),
    getLeadEngagementCount: jest.fn(),
    getLeadEngagements: jest.fn(),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const userId = 'user-1';
const listId = 'list-1';
const leadId = 'lead-1';

const buildEngagements = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    engagementId: `eng-${i}`,
    type: 'linkedin_message',
    createdAt: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));

describe('ENG-1207 — get_lead_engagements must not report a page as a total', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId, userId, name: 'L' });
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    (mockCrmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId, listId, firstName: 'Ada', lastName: 'Lovelace',
    });
  });

  it('says how many of how many when the page is truncated', async () => {
    // 143 engagements, default page of 20. The old message claimed 20 existed.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
      total: 143, last7Days: 4, totalAllMessages: 143,
    });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(143),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.success).toBe(true);
    // The count returned is still the page, which is correct.
    expect(result.engagements).toHaveLength(20);
    // The MESSAGE must not present that page as the whole truth.
    expect(result.message).not.toMatch(/^Found 20 engagement\(s\)/);
    expect(result.message).toContain('20');
    expect(result.message).toContain('143');
    // And it has to say what to do about it, or the model has a number and no move.
    expect(result.message).toMatch(/limit/i);
  });

  it('still reads as a plain total when nothing was truncated', async () => {
    // The control. Over-qualifying a complete answer trains the model to distrust
    // every count, which is its own failure mode.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
      total: 3, last7Days: 1, totalAllMessages: 3,
    });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(3),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.engagements).toHaveLength(3);
    expect(result.message).toMatch(/Found 3 engagement\(s\)/);
    expect(result.message).not.toMatch(/more|limit/i);
  });

  it('BOUNDARY: exactly at the limit is not truncated and must not claim to be', async () => {
    // 20 of 20 with a limit of 20. `slice` returns everything, so a naive
    // "did I slice?" check would false-positive here and warn about nothing.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
      total: 20, last7Days: 0, totalAllMessages: 20,
    });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(20),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.engagements).toHaveLength(20);
    expect(result.message).toMatch(/Found 20 engagement\(s\)/);
    expect(result.message).not.toMatch(/more|limit/i);
  });

  it('BOUNDARY: one past the limit does warn', async () => {
    // The other side of the same edge — 21 with a limit of 20 is truncation by
    // exactly one, and silence there is the same lie as silence at 143.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
      total: 21, last7Days: 0, totalAllMessages: 21,
    });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(21),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.message).toContain('21');
    expect(result.message).toMatch(/limit/i);
  });

  it('INVALID INPUT: a failed count query cannot break the message', async () => {
    // The total is taken from the array being sliced, not from the separate count
    // query, so this path has no dependency to fail. Pinned because the obvious
    // implementation reaches for `engagementCount.total` and then has to decide
    // what to print when it is missing — `of undefined`, `of 0`, or nothing.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({});
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(50),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.message).not.toMatch(/undefined|NaN/);
    expect(result.message).toContain('50');
    expect(result.message).toMatch(/limit/i);
  });

  it('the stated total agrees with the rows returned, even if the count query disagrees', async () => {
    // `engagementCount` is a different query over a possibly different population.
    // If the message quoted it, "20 of 999" would sit beside 20 rows drawn from a
    // set of 143 — two numbers describing different things, which is exactly the
    // kind of inconsistency a model resolves by guessing.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
      total: 999, last7Days: 0, totalAllMessages: 999,
    });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(143),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.message).toContain('143');
    expect(result.message).not.toContain('999');
  });

  it('states the exact message, with the lead name normalised', async () => {
    // Pinning the whole string rather than fragments (CodeRabbit, #2490). The
    // message is the tool's entire contract with the model — a stray double space
    // or a dangling preposition is a real defect in a sentence a model parses, and
    // fragment assertions let both through.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({ total: 143 });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(143),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.message).toBe(
      'Showing the first 20 of 143 engagement(s) for Ada Lovelace — raise limit to see more.',
    );
  });

  it('BOUNDARY: a lead with NO name does not leave a dangling "for"', async () => {
    // `${firstName || ''} ${lastName || ''}` collapses to an empty label, which
    // reads as "... engagement(s) for  — raise limit". Trimming the whole message
    // does not help: the gap is in the middle.
    (mockCrmDb.getLeadById as jest.Mock).mockResolvedValue({ leadId, listId });
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({ total: 143 });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(143),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.message).not.toMatch(/\s{2,}/);
    expect(result.message).not.toMatch(/for\s*—/);
    expect(result.message).toContain('20');
    expect(result.message).toContain('143');
  });

  it('BOUNDARY: a lead with only a LAST name reads naturally', async () => {
    (mockCrmDb.getLeadById as jest.Mock).mockResolvedValue({ leadId, listId, lastName: 'Lovelace' });
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({ total: 3 });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(3),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.message).toBe('Found 3 engagement(s) for Lovelace');
  });

  it('ERROR PATH: a REJECTED count query must not take the whole tool down', async () => {
    // Distinct from the malformed-shape case above, and sharper: the count is
    // fetched in the same `Promise.all` as the engagements, so a rejection there
    // rejects both — even though the message no longer uses the count at all. The
    // data the caller asked for is sitting right there in the other promise.
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockRejectedValue(new Error('count query failed'));
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(143),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.engagements).toHaveLength(20);
    expect(result.message).toContain('143');
  });

  it('honours an explicit limit and reports against it', async () => {
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
      total: 143, last7Days: 4, totalAllMessages: 143,
    });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
      engagements: buildEngagements(143),
    });

    const result = await service.getLeadEngagements(listId, leadId, userId, 5);

    expect(result.engagements).toHaveLength(5);
    expect(result.message).toContain('5');
    expect(result.message).toContain('143');
  });
});
