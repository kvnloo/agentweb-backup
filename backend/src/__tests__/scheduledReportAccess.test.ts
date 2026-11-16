/**
 * Unit tests for the scheduled-report recipient-authorization guard (ENG-500).
 * Covers cross-account sensitivity detection and the admin/owner/fail-closed
 * recipient filtering that gates distribution of reports containing other
 * accounts' data.
 */

import {
  CROSS_ACCOUNT_USER_DATA_TOOLS,
  reportContainsCrossAccountData,
  messagesReferenceCrossAccountTool,
  resolveAuthorizedReportRecipients,
  scheduleLikelySensitive,
  checkScheduleActivationRecipients,
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

describe('messagesReferenceCrossAccountTool (authoritative fallback for the swallowed counter)', () => {
  it('detects a cross-account tool in an assistant message tool_calls', () => {
    expect(messagesReferenceCrossAccountTool([
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'list_all_clients' } }] },
    ])).toBe(true);
  });

  it('detects a cross-account tool in a tool-result message name', () => {
    expect(messagesReferenceCrossAccountTool([
      { role: 'assistant', content: 'thinking' },
      { role: 'tool', name: 'get_chat_history', content: '...' },
    ])).toBe(true);
  });

  it('returns false when only non-cross-account tools appear', () => {
    expect(messagesReferenceCrossAccountTool([
      { role: 'assistant', tool_calls: [{ function: { name: 'install_skills' } }] },
      { role: 'tool', name: 'search_tool_response' },
    ])).toBe(false);
  });

  it('returns false for empty/missing message lists', () => {
    expect(messagesReferenceCrossAccountTool([])).toBe(false);
    expect(messagesReferenceCrossAccountTool(null)).toBe(false);
    expect(messagesReferenceCrossAccountTool(undefined)).toBe(false);
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

  it('withholds an owner whose admin access was revoked (no email special-casing)', async () => {
    // owner is present in the recipient list but is no longer an admin — must be
    // verified by current role and withheld, not trusted by email match.
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['nonadmin@x.com', 'admin2@x.com'],
      ownerEmail: 'nonadmin@x.com', // former admin, now revoked
      isSensitive: true,
    });
    expect(r.authorized).toEqual(['admin2@x.com']); // owner NOT re-added
    expect(r.withheld).toContain('nonadmin@x.com');
    expect(mockGetUserByEmail).toHaveBeenCalledWith('nonadmin@x.com');
  });

  it('authorizes the owner only when the owner is currently an admin', async () => {
    const r = await resolveAuthorizedReportRecipients({
      recipients: ['nonadmin@x.com'],
      ownerEmail: 'admin@x.com', // current admin, not in the recipient list
      isSensitive: true,
    });
    expect(r.authorized).toEqual(['admin@x.com']); // added because currently admin
    expect(r.withheld).toEqual(['nonadmin@x.com']);
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

// ENG-2785: Meta Ads tools are customer-facing; only admin callers can reach
// another account with them, so a verified non-admin owner's report is not
// sensitive on their account alone.
describe('ENG-2785 owner-scoped Meta Ads classification', () => {
  const metaRun = { list_meta_ads_campaigns: 1, get_meta_ads_metrics: 2, call_meta_ads_insights_api: 1 };

  it('does not flag Meta-only runs for a verified non-admin owner', () => {
    expect(reportContainsCrossAccountData(metaRun, { ownerIsAdmin: false })).toBe(false);
    expect(
      messagesReferenceCrossAccountTool(
        [{ role: 'assistant', tool_calls: [{ function: { name: 'get_meta_ads_metrics' } }] }, { role: 'tool', name: 'list_meta_ads_campaigns' }],
        { ownerIsAdmin: false },
      ),
    ).toBe(false);
  });

  it('still flags Meta runs for an admin owner or an owner of unknown status', () => {
    expect(reportContainsCrossAccountData(metaRun, { ownerIsAdmin: true })).toBe(true);
    expect(reportContainsCrossAccountData(metaRun)).toBe(true);
    expect(messagesReferenceCrossAccountTool([{ role: 'tool', name: 'get_meta_ads_metrics' }])).toBe(true);
  });

  it('negative: admin-only tools stay sensitive even for a non-admin owner', () => {
    expect(reportContainsCrossAccountData({ ...metaRun, list_all_clients: 1 }, { ownerIsAdmin: false })).toBe(true);
    expect(messagesReferenceCrossAccountTool([{ role: 'tool', name: 'get_chat_history' }], { ownerIsAdmin: false })).toBe(true);
  });

  it('schedule preflight: required Meta tools do not mark a non-admin owner schedule sensitive', () => {
    const schedule = { requiredFunctionCalls: ['get_meta_ads_metrics'] };
    expect(scheduleLikelySensitive(schedule, { ownerIsAdmin: false })).toBe(false);
    expect(scheduleLikelySensitive(schedule)).toBe(true);
    // the run-recorded breadcrumb is still honoured
    expect(scheduleLikelySensitive({ ...schedule, lastKnownSensitive: true }, { ownerIsAdmin: false })).toBe(true);
    expect(scheduleLikelySensitive({ requiredFunctionCalls: ['list_all_clients'] }, { ownerIsAdmin: false })).toBe(true);
  });

  it('activation gate passes a non-admin customer schedule using Meta tools', async () => {
    const remediation = await checkScheduleActivationRecipients({
      scheduleId: 's1',
      recipients: ['sary@customer.com'],
      ownerEmail: 'sary@customer.com',
      schedule: { requiredFunctionCalls: ['get_meta_ads_metrics'] },
      ownerIsAdmin: false,
    });
    expect(remediation).toBeNull();
  });
});
