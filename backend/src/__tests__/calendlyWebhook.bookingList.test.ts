/**
 * Tests for resolveOrCreateBookingList (ENG-524 CRM-forward) — finds or
 * creates the idempotent, system-managed "Calendly Bookings" list a
 * customer's booking lands in when they haven't explicitly picked one.
 * Mirrors resolveOrCreateDefaultLeadList in routes/landingPageGeneration.ts.
 */

const mockGetLeadListsByUserId = jest.fn();
const mockCreateLeadList = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: (...a: any[]) => mockGetLeadListsByUserId(...a),
    createLeadList: (...a: any[]) => mockCreateLeadList(...a),
  },
}));

import { resolveOrCreateBookingList } from '../routes/calendlyWebhook';

const USER_ID = 'user-abc';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveOrCreateBookingList', () => {
  it('returns an existing system-managed "Calendly Bookings" list without creating one', async () => {
    mockGetLeadListsByUserId.mockResolvedValue([
      { listId: 'list-other', name: 'Some Other List', isSystemManaged: false },
      { listId: 'list-cal', name: 'Calendly Bookings', isSystemManaged: true },
    ]);

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe('list-cal');
    expect(mockCreateLeadList).not.toHaveBeenCalled();
  });

  it('ignores a non-system-managed list that happens to share the name', async () => {
    mockGetLeadListsByUserId.mockResolvedValue([
      { listId: 'list-user-made', name: 'Calendly Bookings', isSystemManaged: false },
    ]);
    mockCreateLeadList.mockResolvedValue({ listId: 'list-new' });

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe('list-new');
    expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
  });

  it('creates a new system-managed list when none exists', async () => {
    mockGetLeadListsByUserId.mockResolvedValue([]);
    mockCreateLeadList.mockResolvedValue({ listId: 'list-new' });

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe('list-new');
    const [userIdArg, nameArg, , , , , , , , listTypeArg, isSystemManagedArg] = mockCreateLeadList.mock.calls[0];
    expect(userIdArg).toBe(USER_ID);
    expect(nameArg).toBe('Calendly Bookings');
    expect(listTypeArg).toBe('sales');
    expect(isSystemManagedArg).toBe(true);
  });

  it('shares one in-flight resolution across concurrent calls for the same user (singleflight)', async () => {
    mockGetLeadListsByUserId.mockResolvedValue([]);
    mockCreateLeadList.mockResolvedValue({ listId: 'list-new' });

    const [a, b] = await Promise.all([
      resolveOrCreateBookingList(USER_ID),
      resolveOrCreateBookingList(USER_ID),
    ]);

    expect(a).toBe('list-new');
    expect(b).toBe('list-new');
    expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
  });

  it('retries once on a transient failure before giving up', async () => {
    mockGetLeadListsByUserId
      .mockRejectedValueOnce(new Error('DynamoDB blip'))
      .mockResolvedValueOnce([]);
    mockCreateLeadList.mockResolvedValue({ listId: 'list-new' });

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe('list-new');
    expect(mockGetLeadListsByUserId).toHaveBeenCalledTimes(2);
  });

  it('propagates the error when both attempts fail — never falls back silently', async () => {
    mockGetLeadListsByUserId.mockRejectedValue(new Error('DynamoDB down'));

    await expect(resolveOrCreateBookingList(USER_ID)).rejects.toThrow('DynamoDB down');
  });
});
