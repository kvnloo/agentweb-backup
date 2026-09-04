/**
 * Regression test for ENG-1351: runLinkedInConnectionSync must trigger the
 * owner-facing disconnect notification when a per-account sync fails with a
 * definitively-disconnected session, and must NOT trigger it for an
 * indeterminate failure (timeout/5xx) that proves nothing about the session.
 */

const notifyMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/linkedInDisconnectNotifyService', () => ({
  notifyAccountOwnerOfDisconnect: (...args: any[]) => notifyMock(...args),
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    listConnections: jest.fn(),
    probeAccountSession: jest.fn(),
  },
  // The cron always calls this before probeAccountSession's definitive check —
  // stub it out so the mock module shape matches the real one (ENG-1351 PR was
  // opened before main gained this export; see tasks/lessons.md).
  isProvenDisconnectError: jest.fn().mockReturnValue(false),
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn(),
  getLatestConnectedAt: jest.fn().mockResolvedValue(null),
  getFullSyncCompletedAt: jest.fn().mockResolvedValue(Date.now()), // not a backfill
  markFullSyncCompleted: jest.fn().mockResolvedValue(undefined),
  normalizeLinkedInUrl: jest.fn((url: string) => url),
}));

jest.mock('../services/linkedInSentInvitationsSyncService', () => ({
  syncSentInvitationsForAccount: jest.fn().mockResolvedValue(undefined),
  sentInvitationChanged: jest.fn(),
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: jest.fn().mockResolvedValue([]) },
}));

/*
 * `userDb` is required, not optional: ENG-1197 (7954cb266) changed
 * `getAllUnipileAccountIds` to also scan per-user connected_accounts via
 * `userDb.scanWithFilter`, and deliberately left that call OUTSIDE a try/catch so a real DB
 * failure propagates. That commit updated linkedInConnectionSyncCron.walkPacing.test.ts but not
 * this suite, so every test here died on `Cannot read properties of undefined (reading
 * 'scanWithFilter')` before reaching its assertion.
 *
 * Resolving to `[]` keeps this suite's subject intact: the account under test (`acct-disc`)
 * comes from the site-wide settings source, and having no per-user record is what makes its
 * owner `undefined` in the notify assertion below. Same stub the sibling suites use.
 */
jest.mock('../services/db', () => ({
  crmDb: {},
  userDb: { scanWithFilter: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {},
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue({
      settingValue: JSON.stringify([{ enabled: true, account_id: 'acct-disc' }]),
    }),
  },
}));

import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { runLinkedInConnectionSync } from '../cron/linkedInConnectionSyncCron';

const listConnections = linkedInOutreachService.listConnections as jest.Mock;
const probeAccountSession = linkedInOutreachService.probeAccountSession as jest.Mock;

describe('runLinkedInConnectionSync — owner disconnect notify wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('notifies the owner when a sync failure is classified as a definitive disconnect', async () => {
    listConnections.mockRejectedValue(new Error('boom'));
    probeAccountSession.mockResolvedValue('disconnected');

    await runLinkedInConnectionSync();

    expect(notifyMock).toHaveBeenCalledWith('acct-disc', undefined);
  });

  it('does not notify the owner when the failure is indeterminate (timeout/5xx)', async () => {
    listConnections.mockRejectedValue(new Error('timeout'));
    probeAccountSession.mockResolvedValue('unknown');

    await runLinkedInConnectionSync();

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does not notify the owner when the sync succeeds', async () => {
    listConnections.mockResolvedValue({ items: [] });

    await runLinkedInConnectionSync();

    expect(probeAccountSession).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
