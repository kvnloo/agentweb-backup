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
const CLEAN_TRACKING = {
  healthy: 1, accountsChecked: 1, blackouts: 0, tokenErrors: 0, fetchErrors: 0,
  unclassifiable: 0, idle: 0, optimisationAlerts: 0, capturedAlerts: [],
};

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
  it('leaves genuine_demand_drop unchecked (never supported — no CTV access) and rules out normal_variance when a campaign is in drought', async () => {
    mockMonitorLeadVolume.mockResolvedValue({
      success: true,
      reports: [{ accountId: ACCOUNT_ID, campaigns: [{ status: 'drought', reason: 'below p5 floor', requiresTrackingValidation: true }] }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'genuine_demand_drop')?.verdict).toBe('unchecked');
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
  it.each([
    { healthy: 0, blackouts: 0, tokenErrors: 1 },
    { healthy: 0, blackouts: 0, accountsChecked: 0 },
    { healthy: 1, blackouts: 0, tokenErrors: 1 },
    { healthy: 1, blackouts: 0, fetchErrors: 1 },
    { healthy: 1, blackouts: 0, unclassifiable: 1 },
    { healthy: 1, blackouts: 1 },
    { healthy: 1, blackouts: 0, accountsChecked: 0 },
    { healthy: NaN, blackouts: 0 },
    { optimisationAlerts: 1 },
    { idle: 1 },
    { fetchErrors: undefined },
    { accountsChecked: 2 },
  ])('leaves incomplete tracking evidence unchecked: %j', async summary => {
    mockRunMetaTrackingMonitor.mockResolvedValue({ ...CLEAN_TRACKING, ...summary });
    const result = await diagnoseLeadsAtZero('caller-1', CLIENT.email, true);
    const pixel = result.diagnoses?.[0].causes.find(c => c.cause === 'pixel_capi_broken');
    expect(pixel?.verdict).toBe('unchecked');
    expect(pixel?.evidence).toMatch(/did not return a usable summary/);
  });

  it.each(['meta-attribution-blackout', 'meta-optimisation-event-missing'])('keeps matching positive %s evidence despite sweep errors', async alertClass => {
    mockRunMetaTrackingMonitor.mockResolvedValue({ healthy: 0, tokenErrors: 1, capturedAlerts: [
      { message: 'confirmed failure', context: { 'Alert Class': alertClass, 'Ad Account': ACCOUNT_ID } },
    ] });
    const result = await diagnoseLeadsAtZero('caller-1', CLIENT.email, true);
    expect(result.diagnoses?.[0].causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).toBe('supported');
  });

  it('does not borrow healthy evidence or a foreign alert for a failed sibling account', async () => {
    mockGetAccounts.mockResolvedValue([ACCOUNT_ID, 'act-other'].map(account_id => ({
      platform: 'meta', account_id, config: { account_type: 'ad_account' },
    })));
    mockRunMetaTrackingMonitor.mockImplementation(async ({ adAccountId }: { adAccountId: string }) =>
      adAccountId === ACCOUNT_ID ? CLEAN_TRACKING : {
        healthy: 0, blackouts: 0, tokenErrors: 1, capturedAlerts: [
          { message: 'foreign failure', context: { 'Alert Class': 'meta-attribution-blackout', 'Ad Account': ACCOUNT_ID } },
        ],
      });
    const result = await diagnoseLeadsAtZero('caller-1', CLIENT.email, true);
    expect(result.diagnoses?.[0].causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).toBe('ruled_out');
    expect(result.diagnoses?.[1].causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).toBe('unchecked');
  });

  it('does not use a normal campaign to dismiss missing sibling campaign history', async () => {
    mockMonitorLeadVolume.mockResolvedValue({ success: true, reports: [{ accountId: ACCOUNT_ID, campaigns: [
      { status: 'normal', reason: 'within floor' },
      { status: 'insufficient_history', reason: 'missing history' },
    ] }] });
    const result = await diagnoseLeadsAtZero('caller-1', CLIENT.email, true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'genuine_demand_drop')?.verdict).toBe('unchecked');
    expect(causes.find(c => c.cause === 'normal_variance')?.verdict).toBe('unchecked');
  });

  it('does not treat missing destination completeness as confirmed reachability', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({ healthy: 1, blackouts: 0, destinationOk: 1, capturedAlerts: [] });
    const result = await diagnoseLeadsAtZero('caller-1', CLIENT.email, true);
    expect(result.diagnoses?.[0].causes.find(c => c.cause === 'landing_page_unreachable')?.verdict).toBe('unchecked');
  });
  it('rules out pixel_capi_broken when the tracking sweep is clean', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue(CLEAN_TRACKING);
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).toBe('ruled_out');
  });

  // Regression: an earlier draft matched capturedAlerts against a hand-typed 'meta-blackout'
  // string. The real alert class is 'meta-attribution-blackout' (BLACKOUT_ALERT_CLASS in
  // metaTrackingMonitor.ts) — the typo silently ruled out a genuine full attribution blackout
  // instead of supporting pixel_capi_broken on it.
  it('supports pixel_capi_broken on a real attribution-blackout alert, not just an optimisation-event alert', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({
      healthy: 0, blackouts: 1, capturedAlerts: [{
        subject: 'blackout', message: 'full attribution blackout',
        context: { 'Alert Class': 'meta-attribution-blackout', 'Ad Account': ACCOUNT_ID },
      }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'pixel_capi_broken')?.verdict).toBe('supported');
  });

  it('supports landing_page_unreachable on a real destination alert for this account', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({
      healthy: 1, blackouts: 0, destinationAlerts: 1, destinationOk: 0,
      capturedAlerts: [{ subject: 'dest', message: 'destination unreachable', context: { 'Alert Class': 'meta-destination-unmeasured', 'Ad Account': ACCOUNT_ID } }],
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    const landingPage = causes.find(c => c.cause === 'landing_page_unreachable');
    expect(landingPage?.verdict).toBe('supported');
    expect(landingPage?.evidence).toBe('destination unreachable');
  });

  it('rules out landing_page_unreachable when destinations are confirmed ok', async () => {
    mockRunMetaTrackingMonitor.mockResolvedValue({ healthy: 1, blackouts: 0, destinationAlerts: 0, destinationOk: 5, destinationUnverifiable: 0, capturedAlerts: [] });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const causes = result.diagnoses?.[0].causes ?? [];
    expect(causes.find(c => c.cause === 'landing_page_unreachable')?.verdict).toBe('ruled_out');
  });

  it('sweeps each connected ad account separately, passing its own adAccountId', async () => {
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'act-A', config: { account_type: 'ad_account' } },
      { platform: 'meta', account_id: 'act-B', config: { account_type: 'ad_account' } },
    ]);
    await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const calledAccountIds = mockRunMetaTrackingMonitor.mock.calls.map((c: any[]) => c[0]?.adAccountId).sort();
    expect(calledAccountIds).toEqual(['act-A', 'act-B']);
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

  // Regression: `evaluateLandingPageUnreachable` used to read `destinationAlerts`/`destinationOk`
  // off a summary that (before the per-account sweep fix) aggregated across every account the
  // sweep call covered — so account A's destination alert made account B's diagnosis falsely
  // 'supported' too. Each account is now swept separately (`adAccountId` scoped), simulated here
  // by returning a genuinely different summary per call.
  it('never leaks one account\'s destination alert into another account\'s landing_page_unreachable verdict', async () => {
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'act-A', config: { account_type: 'ad_account' } },
      { platform: 'meta', account_id: 'act-B', config: { account_type: 'ad_account' } },
    ]);
    mockRunMetaTrackingMonitor.mockImplementation(async (opts: any) => {
      if (opts?.adAccountId === 'act-A') {
        return {
          healthy: 0, blackouts: 0, destinationAlerts: 1, destinationOk: 0, destinationUnverifiable: 0,
          capturedAlerts: [{ subject: 'dest', message: 'A only', context: { 'Alert Class': 'meta-destination-unmeasured', 'Ad Account': 'act-A' } }],
        };
      }
      return { healthy: 1, blackouts: 0, destinationAlerts: 0, destinationOk: 4, destinationUnverifiable: 0, capturedAlerts: [] };
    });
    const result = await diagnoseLeadsAtZero('caller-1', 'haven@example.com', true);
    const diagA = result.diagnoses?.find(d => d.accountId === 'act-A');
    const diagB = result.diagnoses?.find(d => d.accountId === 'act-B');
    expect(diagA?.causes.find(c => c.cause === 'landing_page_unreachable')?.verdict).toBe('supported');
    expect(diagB?.causes.find(c => c.cause === 'landing_page_unreachable')?.verdict).toBe('ruled_out');
  });
});
