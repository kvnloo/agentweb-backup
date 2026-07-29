/**
 * Unit tests for the scheduled-report recipient-authorization guard (ENG-500).
 * Covers cross-account sensitivity detection and the admin/owner/fail-closed
 * recipient filtering that gates distribution of reports containing other
 * accounts' data.
 */

import {
  CROSS_ACCOUNT_USER_DATA_TOOLS,
  reportContainsCrossAccountData,
  resolveAuthorizedReportRecipients,
} from '../services/scheduledReportAccess';
import { userDb } from '../services/db';

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn() },
}));

const mockGetUserByEmail = userDb.getUserByEmail as jest.Mock;

// admin@x.com is an admin; everyone else is a non-admin; unknown@x.com missing.
beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserByEmail.mockImplementation(async (email: string) => {
    const e = (email || '').toLowerCase();
    if (e === 'admin@x.com' || e === 'admin2@x.com') return { userId: e, email: e, isAdmin: true };
    if (e === 'unknown@x.com') return undefined;
    return { userId: e, email: e, isAdmin: false };
  });
});

describe('reportContainsCrossAccountData', () => {
  it('flags a run that called an admin cross-account tool (map form)', () => {
    expect(reportContainsCrossAccountData({ list_all_clients: 1, get_chat_history: 1 })).toBe(true);
  });

  it('flags a run that called an admin cross-account tool (array form)', () => {
    expect(reportContainsCrossAccountData(['search_tool_response', 'assess_client_health'])).toBe(true);
  });

  it('does not flag an ordinary report with no cross-account tools', () => {
    expect(reportContainsCrossAccountData({ install_skills: 1, post_on_connected_account: 2 })).toBe(false);
  });

  it('treats missing/empty calledFunctions as non-sensitive', () => {
    expect(reportContainsCrossAccountData(undefined)).toBe(false);
    expect(reportContainsCrossAccountData(null)).toBe(false);
    expect(reportContainsCrossAccountData({})).toBe(false);
  });

  it('lists list_all_clients and get_chat_history as cross-account tools', () => {
    expect(CROSS_ACCOUNT_USER_DATA_TOOLS).toEqual(expect.arrayContaining(['list_all_clients', 'get_chat_history']));
  });
});

describe('resolveAuthorizedReportRecipients', () => {
  it('is a pass-through for a non-sensitive report (no lookups, nothing withheld)', async () => {
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['a@x.com', 'b@x.com'],
      ownerEmail: 'admin@x.com',
      isSensitive: false,
    });
    expect(r.restricted).toBe(false);
    expect(r.authorized).toEqual(['a@x.com', 'b@x.com']);
    expect(r.withheld).toEqual([]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('keeps admin recipients and delivers unchanged when all are admins', async () => {
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['admin@x.com', 'admin2@x.com'],
      ownerEmail: 'admin@x.com',
      isSensitive: true,
    });
    expect(r.authorized).toEqual(['admin@x.com', 'admin2@x.com']);
    expect(r.withheld).toEqual([]);
    expect(r.restricted).toBe(true);
  });

  it('withholds non-admin recipients and adds the owner so the notice lands', async () => {
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['admin2@x.com', 'nonadmin@x.com'],
      ownerEmail: 'admin@x.com', // owner not in the list
      isSensitive: true,
    });
    expect(r.authorized).toEqual(expect.arrayContaining(['admin2@x.com', 'admin@x.com']));
    expect(r.authorized).not.toContain('nonadmin@x.com');
    expect(r.withheld).toEqual(['nonadmin@x.com']);
  });

  it('falls back to owner-only when every configured recipient is unauthorized', async () => {
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['nonadmin@x.com', 'someone@x.com'],
      ownerEmail: 'admin@x.com',
      isSensitive: true,
    });
    expect(r.authorized).toEqual(['admin@x.com']);
    expect(r.withheld).toEqual(['nonadmin@x.com', 'someone@x.com']);
  });

  it('always authorizes the owner without a lookup, even if not an admin record', async () => {
    // owner present in recipient list — must be kept regardless of lookup
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['owner@x.com', 'nonadmin@x.com'],
      ownerEmail: 'owner@x.com',
      isSensitive: true,
    });
    expect(r.authorized).toContain('owner@x.com');
    expect(r.withheld).toEqual(['nonadmin@x.com']);
    // owner was matched by email, not looked up
    expect(mockGetUserByEmail).not.toHaveBeenCalledWith('owner@x.com');
  });

  it('fail-closed: a recipient whose lookup THROWS is withheld', async () => {
    mockGetUserByEmail.mockImplementation(async (email: string) => {
      if (email === 'boom@x.com') throw new Error('DynamoDB throttled');
      return { isAdmin: true };
    });
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['admin@x.com', 'boom@x.com'],
      ownerEmail: 'admin@x.com',
      isSensitive: true,
    });
    expect(r.authorized).not.toContain('boom@x.com');
    expect(r.withheld).toEqual(['boom@x.com']);
  });

  it('does not duplicate the owner when the owner is already an authorized recipient', async () => {
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['admin@x.com', 'nonadmin@x.com'],
      ownerEmail: 'admin@x.com',
      isSensitive: true,
    });
    expect(r.authorized.filter((e) => e === 'admin@x.com')).toHaveLength(1);
    expect(r.withheld).toEqual(['nonadmin@x.com']);
  });
});
