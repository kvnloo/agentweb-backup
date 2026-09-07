import { diagnoseLeadsAtZero } from '../services/l2DiagnoseService';
import { userDb } from '../services/db';
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { monitorLeadVolume } from '../services/leadVolumeMonitorService';
import { runMetaTrackingMonitor } from '../cron/metaTrackingMonitorCron';

jest.mock('../services/db');
jest.mock('../services/connectedAccountsDb');
jest.mock('../services/leadVolumeMonitorService');
jest.mock('../cron/metaTrackingMonitorCron');

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockGetAccounts = getAccountsByUserId as jest.Mock;
const mockMonitorLeadVolume = monitorLeadVolume as jest.Mock;
const mockRunMetaTrackingMonitor = runMetaTrackingMonitor as jest.Mock;

const CLIENT = { userId: 'client-1', email: 'haven@example.com', displayName: 'Haven' };
const ACCOUNT_ID = 'act123';

beforeEach(() => {
  jest.clearAllMocks();
  (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(CLIENT);
  mockGetAccounts.mockResolvedValue([{ platform: 'meta', account_id: ACCOUNT_ID, config: { account_type: 'ad_account' } }]);
  mockMonitorLeadVolume.mockResolvedValue({ success: true, reports: [] });
  mockRunMetaTrackingMonitor.mockResolvedValue({ healthy: 1, blackouts: 0, destinationAlerts: 0, destinationOk: 0, capturedAlerts: [] });
});

describe('diagnoseLeadsAtZero — authorization', () => {
  it('refuses a non-admin caller', async () => {
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Admin access required/);
    expect(mockGetAccounts).not.toHaveBeenCalled();
  });
});

describe('diagnoseLeadsAtZero — the real regression case', () => {
  it('reaches determined (pixel_capi_broken) even though budget_exhausted is permanently unchecked', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({
      healthy: 0,
      blackouts: 1,
      destinationAlerts: 0,
      destinationOk: 3,
      destinationUnverifiable: 0,
      capturedAlerts: [{
        subject: 'pixel event missing',
        message: 'no CompleteRegistration on the pixel in 24h',
        context: { 'Alert Class': 'meta-optimisation-event-missing', 'Ad Account': ACCOUNT_ID },
      }],
    });
    mockMonitorLeadVolume.mockResolvedValue({
      success: true,
      reports: [{ accountId: ACCOUNT_ID, campaigns: [{ status: 'normal', reason: 'within historical floor' }] }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    expect(result.success).toBe(true);
    const diag = result.diagnoses?.[0];
    expect(diag?.outcome).toBe('determined');
    expect(diag?.concludedCause).toBe('pixel_capi_broken');
    const budgetCause = diag?.causes.find(c => c.cause === 'budget_exhausted');
    expect(budgetCause?.verdict).toBe('unchecked');
  });
});

describe('diagnoseLeadsAtZero — demand drop vs normal variance mapping', () => {
  it('supports genuine_demand_drop and rules out normal_variance when a campaign is in drought', async () => {
    mockMonitorLeadVolume.mockResolvedValue({
      success: true,
      reports: [{ accountId: ACCOUNT_ID, campaigns: [{ status: 'drought', reason: 'below p5 floor' }] }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'genuine_demand_drop')?.verdict).toBe('supported');
    expect(causes.find(c => c.cause === 'normal_variance')?.verdict).toBe('ruled_out');
  });

  it('supports normal_variance and rules out genuine_demand_drop when status is normal', async () => {
    mockMonitorLeadVolume.mockResolvedValue({
      success: true,
      reports: [{ accountId: ACCOUNT_ID, campaigns: [{ status: 'normal', reason: 'within floor' }] }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'normal_variance')?.verdict).toBe('supported');
    expect(causes.find(c => c.cause === 'genuine_demand_drop')?.verdict).toBe('ruled_out');
  });

  it('leaves both unchecked when status is insufficient_history', async () => {
    mockMonitorLeadVolume.mockResolvedValue({
      success: true,
      reports: [{ accountId: ACCOUNT_ID, campaigns: [{ status: 'insufficient_history', reason: 'not enough days' }] }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'normal_variance')?.verdict).toBe('unchecked');
    expect(causes.find(c => c.cause === 'genuine_demand_drop')?.verdict).toBe('unchecked');
  });
});

describe('diagnoseLeadsAtZero — pixel/CAPI and destination evidence mapping', () => {
  it('rules out pixel_capi_broken when the tracking sweep is clean', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({ healthy: 1, blackouts: 0, capturedAlerts: [] });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).toBe('ruled_out');
  });

  it('supports landing_page_unreachable on a real destination alert for this account', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({
      healthy: 1, blackouts: 0, destinationAlerts: 1, destinationOk: 0,
      capturedAlerts: [{ subject: 'dest', message: 'destination unreachable', context: { 'Alert Class': 'meta-destination-coverage', 'Ad Account': ACCOUNT_ID } }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'landing_page_unreachable')?.verdict).toBe('supported');
  });

  it('rules out landing_page_unreachable when destinations are confirmed ok', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({ healthy: 1, blackouts: 0, destinationAlerts: 0, destinationOk: 5, destinationUnverifiable: 0, capturedAlerts: [] });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'landing_page_unreachable')?.verdict).toBe('ruled_out');
  });
});

describe('diagnoseLeadsAtZero — client/account resolution', () => {
  it('returns not-found for an unresolvable client', async () => {
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(null);
    (mockUserDb.getAllUsers as jest.Mock).mockResolvedValue([]);
    const result = await diagnoseLeadsAtZero('caller-1', 'nobody@example.com', true);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Client not found/);
  });

  it('excludes a connected account with platform=meta but account_type != ad_account', async () => {
    mockGetAccounts.mockResolvedValue([{ platform: 'meta', account_id: 'ig-123', config: { account_type: 'instagram_business' } }]);
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    expect(result.diagnoses).toEqual([]);
  });

  it('returns empty diagnoses with a message when the client has no Meta ad accounts', async () => {
    mockGetAccounts.mockResolvedValue([]);
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    expect(result.success).toBe(true);
    expect(result.diagnoses).toEqual([]);
    expect(result.message).toMatch(/No connected Meta ad accounts/);
  });

  it('never leaks one account\'s tracking alert into another account\'s diagnosis', async () => {
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'act-A', config: { account_type: 'ad_account' } },
      { platform: 'meta', account_id: 'act-B', config: { account_type: 'ad_account' } },
    ]);
    mockRunMetaTrackingMonitor.mockResolvedValue({
      healthy: 1, blackouts: 0, capturedAlerts: [
        { subject: 'x', message: 'broken on A only', context: { 'Alert Class': 'meta-optimisation-event-missing', 'Ad Account': 'act-A' } },
      ],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const diagA = result.diagnoses?.find(d => d.accountId === 'act-A');
    const diagB = result.diagnoses?.find(d => d.accountId === 'act-B');
    expect(diagA?.causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).toBe('supported');
    expect(diagB?.causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).not.toBe('supported');
  });
});
