/**
 * Tests for resolveOrCreateBookingList (ENG-524 CRM-forward) — finds or
 * creates the idempotent, system-managed "Calendly Bookings" list a
 * customer's booking lands in when they haven't explicitly picked one.
 *
 * Race-safety (gap 7): uses a deterministic listId (`list_calendly_bookings_
 * <userId>`) plus crmDb.createLeadList's conditional-write support, so two
 * concurrent callers — even across different backend instances, not just
 * within one process — can't create duplicate lists. A caller that loses the
 * create race gets a ConditionalCheckFailedException and falls back to
 * fetching the winner's record directly. The in-memory singleflight map is
 * kept only as a same-process optimization to avoid redundant DB round
 * trips; it's no longer the sole thing preventing duplicates.
 */

const mockGetLeadListById = jest.fn();
const mockCreateLeadList = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...a: any[]) => mockGetLeadListById(...a),
    createLeadList: (...a: any[]) => mockCreateLeadList(...a),
  },
}));

import { resolveOrCreateBookingList } from '../routes/calendlyWebhook';

const USER_ID = 'user-abc';
const DETERMINISTIC_ID = `list_calendly_bookings_${USER_ID}`;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveOrCreateBookingList', () => {
  it('returns the existing list at the deterministic ID without creating one', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: DETERMINISTIC_ID, name: 'Calendly Bookings' });

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe(DETERMINISTIC_ID);
    expect(mockGetLeadListById).toHaveBeenCalledWith(DETERMINISTIC_ID);
    expect(mockCreateLeadList).not.toHaveBeenCalled();
  });

  it('creates a new system-managed list at the deterministic ID when none exists', async () => {
    mockGetLeadListById.mockResolvedValue(null);
    mockCreateLeadList.mockResolvedValue({ listId: DETERMINISTIC_ID });

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe(DETERMINISTIC_ID);
    const [userIdArg, nameArg, , , , , , , , listTypeArg, isSystemManagedArg, explicitIdArg] = mockCreateLeadList.mock.calls[0];
    expect(userIdArg).toBe(USER_ID);
    expect(nameArg).toBe('Calendly Bookings');
    expect(listTypeArg).toBe('sales');
    expect(isSystemManagedArg).toBe(true);
    expect(explicitIdArg).toBe(DETERMINISTIC_ID);
  });

  it('falls back to the winner\'s record when it loses the create race (ConditionalCheckFailedException)', async () => {
    mockGetLeadListById
      .mockResolvedValueOnce(null) // first check: doesn't exist yet
      .mockResolvedValueOnce({ listId: DETERMINISTIC_ID, name: 'Calendly Bookings' }); // fallback: winner's record
    const conditionalError: any = new Error('The conditional request failed');
    conditionalError.code = 'ConditionalCheckFailedException';
    mockCreateLeadList.mockRejectedValue(conditionalError);

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe(DETERMINISTIC_ID);
    expect(mockGetLeadListById).toHaveBeenCalledTimes(2);
  });

  it('throws when it loses the create race but the fallback lookup still finds nothing (inconsistent state)', async () => {
    mockGetLeadListById.mockResolvedValue(null); // both the pre-check and the fallback return null
    const conditionalError: any = new Error('The conditional request failed');
    conditionalError.code = 'ConditionalCheckFailedException';
    mockCreateLeadList.mockRejectedValue(conditionalError);

    await expect(resolveOrCreateBookingList(USER_ID)).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
  });

  it('shares one in-flight resolution across concurrent calls for the same user (singleflight)', async () => {
    mockGetLeadListById.mockResolvedValue(null);
    mockCreateLeadList.mockResolvedValue({ listId: DETERMINISTIC_ID });

    const [a, b] = await Promise.all([
      resolveOrCreateBookingList(USER_ID),
      resolveOrCreateBookingList(USER_ID),
    ]);

    expect(a).toBe(DETERMINISTIC_ID);
    expect(b).toBe(DETERMINISTIC_ID);
    expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
  });

  it('retries once on a transient (non-conditional) failure before giving up', async () => {
    mockGetLeadListById
      .mockRejectedValueOnce(new Error('DynamoDB blip'))
      .mockResolvedValueOnce(null);
    mockCreateLeadList.mockResolvedValue({ listId: DETERMINISTIC_ID });

    const id = await resolveOrCreateBookingList(USER_ID);

    expect(id).toBe(DETERMINISTIC_ID);
    expect(mockGetLeadListById).toHaveBeenCalledTimes(2);
  });

  it('propagates the error when both attempts fail — never falls back silently', async () => {
    mockGetLeadListById.mockRejectedValue(new Error('DynamoDB down'));

    await expect(resolveOrCreateBookingList(USER_ID)).rejects.toThrow('DynamoDB down');
  });
});
