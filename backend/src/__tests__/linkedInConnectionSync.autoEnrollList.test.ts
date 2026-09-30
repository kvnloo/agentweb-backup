/**
 * Tests that enrollNewConnections respects autoEnrollListIds — only enrolls
 * leads from lists configured on the sequence, not every list the user owns.
 */

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { listConnections: jest.fn() },
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn(),
  getLatestConnectedAt: jest.fn().mockResolvedValue(null),
  normalizeLinkedInUrl: jest.fn((url: string) => url.replace(/\/$/, '').toLowerCase()),
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getAllSequencesByTriggerType: jest.fn(),
    getExistingEnrollment: jest.fn(),
    enrollLead: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

import { enrollNewConnections } from '../cron/linkedInConnectionSyncCron';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { crmDb } from '../services/db';

const mockDripDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const NEW_CONNECTION = {
  accountId: 'account-1',
  memberId: 'member-abc',
  publicProfileUrl: 'https://www.linkedin.com/in/john-prospect',
  memberUrn: '',
  connectionUrn: '',
  firstName: 'John',
  lastName: 'Prospect',
  headline: 'CTO',
  connectedAt: Date.now(),
  syncedAt: new Date().toISOString(),
};

const SEQUENCE_WITH_FILTER = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'LinkedIn Drip',
  status: 'active',
  enrollmentTrigger: { type: 'linkedin_connection_accepted' },
  // A connection-accepted sequence sends LinkedIn DMs. The fixture had no steps at all,
  // which makes requiredChannels fall back to email — so it could not show whether this
  // path serves the LinkedIn-only leads it exists for.
  steps: [{ stepId: 's1', stepNumber: 1, name: 'DM', channel: 'linkedin', delayDays: 0, messageText: 'hi' }],
  autoEnrollListIds: ['list-correct'],
};

const SEQUENCE_NO_FILTER = {
  ...SEQUENCE_WITH_FILTER,
  autoEnrollListIds: undefined,
};

const CORRECT_LIST = { listId: 'list-correct', name: 'Outreach List' };
const WRONG_LIST   = { listId: 'list-wrong',   name: 'Some Other List' };

const MATCHING_LEAD = {
  leadId: 'lead-1',
  email: 'john@acme.io',
  linkedin: 'https://www.linkedin.com/in/john-prospect',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDripDb.getExistingEnrollment.mockResolvedValue(null);
  mockDripDb.enrollLead.mockResolvedValue({} as any);
  // Auto-enroll kill-switch defaults to muted; enable it so these tests exercise
  // the real enrollment logic. A dedicated test below covers muted-by-default.
  process.env.LINKEDIN_CONNECTION_ENROLL = 'true';
});

afterAll(() => {
  delete process.env.LINKEDIN_CONNECTION_ENROLL;
});

describe('enrollNewConnections - kill-switch', () => {
  it('is muted by default: enrolls nothing when LINKEDIN_CONNECTION_ENROLL is unset', async () => {
    delete process.env.LINKEDIN_CONNECTION_ENROLL;
    mockDripDb.getAllSequencesByTriggerType.mockResolvedValue([SEQUENCE_WITH_FILTER] as any);
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([CORRECT_LIST] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [MATCHING_LEAD], lastEvaluatedKey: null, hasMore: false } as any);

    const enrolled = await enrollNewConnections([NEW_CONNECTION]);

    expect(enrolled).toBe(0);
    expect(mockDripDb.getAllSequencesByTriggerType).not.toHaveBeenCalled();
    expect(mockDripDb.enrollLead).not.toHaveBeenCalled();
  });
});

describe('enrollNewConnections - autoEnrollListIds filter', () => {
  it('only enrolls lead from the configured autoEnrollListId, not from other lists', async () => {
    mockDripDb.getAllSequencesByTriggerType.mockResolvedValue([SEQUENCE_WITH_FILTER] as any);
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([CORRECT_LIST, WRONG_LIST] as any);
    mockCrmDb.getLeadsByListId.mockImplementation(async (listId: string) => {
      if (listId === 'list-correct') return { items: [MATCHING_LEAD], lastEvaluatedKey: null, hasMore: false };
      return { items: [MATCHING_LEAD], lastEvaluatedKey: null, hasMore: false }; // same lead in wrong list too
    });

    await enrollNewConnections([NEW_CONNECTION]);

    expect(mockDripDb.enrollLead).toHaveBeenCalledTimes(1);
    expect(mockDripDb.enrollLead).toHaveBeenCalledWith(
      expect.objectContaining({ listId: 'list-correct' }),
    );
  });

  it('does not query leads from lists not in autoEnrollListIds', async () => {
    mockDripDb.getAllSequencesByTriggerType.mockResolvedValue([SEQUENCE_WITH_FILTER] as any);
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([CORRECT_LIST, WRONG_LIST] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);

    await enrollNewConnections([NEW_CONNECTION]);

    const calledListIds = mockCrmDb.getLeadsByListId.mock.calls.map((c: any[]) => c[0]);
    expect(calledListIds).not.toContain('list-wrong');
    expect(calledListIds).toContain('list-correct');
  });

  it('searches all lists when autoEnrollListIds is not set', async () => {
    mockDripDb.getAllSequencesByTriggerType.mockResolvedValue([SEQUENCE_NO_FILTER] as any);
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([CORRECT_LIST, WRONG_LIST] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);

    await enrollNewConnections([NEW_CONNECTION]);

    const calledListIds = mockCrmDb.getLeadsByListId.mock.calls.map((c: any[]) => c[0]);
    expect(calledListIds).toContain('list-correct');
    expect(calledListIds).toContain('list-wrong');
  });

  it('skips enrollment when lead is already enrolled', async () => {
    mockDripDb.getAllSequencesByTriggerType.mockResolvedValue([SEQUENCE_WITH_FILTER] as any);
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([CORRECT_LIST] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [MATCHING_LEAD], lastEvaluatedKey: null, hasMore: false } as any);
    mockDripDb.getExistingEnrollment.mockResolvedValue({ enrollmentId: 'existing' } as any);

    await enrollNewConnections([NEW_CONNECTION]);

    expect(mockDripDb.enrollLead).not.toHaveBeenCalled();
  });
});

/**
 * Review round 2, finding 3. enrollNewConnections is the FIFTH enrolment path, and it
 * was the one left behind: `if (!lead.linkedin || !lead.email) continue;` — the exact
 * email-only gate removed from the other four — on the path whose trigger is literally
 * "a LinkedIn connection was accepted". It also keyed the row on `lead.email` raw
 * rather than the shared identity, so the same person could be stored under two
 * different identities by two different paths and neither dedup check saw the other.
 */
describe('enrollNewConnections serves LinkedIn-only leads', () => {
  const LI_ONLY_LEAD = {
    leadId: 'lead-li',
    linkedin: 'https://www.linkedin.com/in/john-prospect',
  };

  beforeEach(() => {
    mockDripDb.getAllSequencesByTriggerType.mockResolvedValue([SEQUENCE_WITH_FILTER] as any);
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([CORRECT_LIST] as any);
  });

  it('enrols a lead with a profile and NO email — the lead this cron exists for', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue(
      { items: [LI_ONLY_LEAD], lastEvaluatedKey: null, hasMore: false } as any,
    );

    const enrolled = await enrollNewConnections([NEW_CONNECTION]);

    expect(enrolled).toBe(1);
    expect(mockDripDb.enrollLead).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-li', leadEmail: 'https://www.linkedin.com/in/john-prospect/' }),
    );
  });

  it('keys on the shared identity, not the raw address, so paths agree on one person', async () => {
    // A junk address plus a good profile: the routes key this on the profile URL. Keying
    // it on the junk address here made one person two enrollments.
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{ ...LI_ONLY_LEAD, email: 'a@x..com' }], lastEvaluatedKey: null, hasMore: false,
    } as any);

    await enrollNewConnections([NEW_CONNECTION]);

    expect(mockDripDb.enrollLead).toHaveBeenCalledWith(
      expect.objectContaining({ leadEmail: 'https://www.linkedin.com/in/john-prospect/' }),
    );
  });

  it('looks for an existing enrollment under BOTH identities before enrolling again', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{ ...LI_ONLY_LEAD, email: 'john@acme.io' }], lastEvaluatedKey: null, hasMore: false,
    } as any);
    // Already enrolled under the profile URL by another path; today's identity is the
    // address, so a single-key check would miss it and re-deliver the sequence.
    mockDripDb.getExistingEnrollment.mockImplementation(async (_seq: string, identity: string) => (
      identity === 'https://www.linkedin.com/in/john-prospect/' ? ({ enrollmentId: 'old' } as any) : null
    ));

    const enrolled = await enrollNewConnections([NEW_CONNECTION]);

    expect(enrolled).toBe(0);
    expect(mockDripDb.enrollLead).not.toHaveBeenCalled();
  });

  it('still refuses a lead with neither a usable profile nor an address', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [{ leadId: 'lead-x', linkedin: 'https://www.linkedin.com/company/acme' }],
      lastEvaluatedKey: null, hasMore: false,
    } as any);

    const enrolled = await enrollNewConnections([NEW_CONNECTION]);

    expect(enrolled).toBe(0);
    expect(mockDripDb.enrollLead).not.toHaveBeenCalled();
  });
});
