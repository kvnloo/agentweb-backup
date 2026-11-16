/**
 * ENG-3079 acceptance: client health reports whether the Meta optimisation event is arriving.
 *  2. recent when a pixel reported the optimisation event in the monitor's window, missing in
 *     the monitor's confirmed case; window and matching are the monitor's own evaluator.
 *  3. no conversion ad set, no usable connection, or a failed read -> unknown (never missing).
 *  4. a slow or failing read is bounded and falls back to unknown.
 *  5. reconnect_required is unchanged.
 *  6. the Meta read is mocked; no live call.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), getAllUsers: jest.fn() },
}));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserId: jest.fn() }));
jest.mock('../services/spendProjectionDb', () => ({ getProjectionsBatch: jest.fn() }));
jest.mock('../services/v0Service', () => ({
  getLandingPagesByOwner: jest.fn().mockResolvedValue([]),
  getLandingPagesByOrg: jest.fn().mockResolvedValue([]),
}));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('shared-token') }));
jest.mock('../utils/metaApiFetch', () => ({ fetchWithRetryAndPaging: jest.fn().mockResolvedValue({ data: [] }) }));
jest.mock('../services/adsThresholdsDb', () => ({ getThresholdsForAccount: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }),
}));
// Only the network read is replaced. The evaluator and selectedEventState are the real ones.
jest.mock('../services/metaOptimisationCoverage', () => ({
  ...jest.requireActual('../services/metaOptimisationCoverage'),
  fetchOptimisationInputs: jest.fn(),
}));

import { assessClientHealth, readSelectedEventState } from '../services/clientHealthService';
import {
  evaluateAccountOptimisationCoverage,
  fetchOptimisationInputs,
  selectedEventState,
  type OptimisationInputs,
} from '../services/metaOptimisationCoverage';

const { userDb } = require('../services/db');
const { getAccountsByUserId } = require('../services/connectedAccountsDb');
const mockRead = fetchOptimisationInputs as jest.Mock;

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const TODAY = day(0);
const purchaseAdSet = (over: any = {}) => ({
  id: 'as1',
  name: 'Purchase ad set',
  effective_status: 'ACTIVE',
  promoted_object: { custom_event_type: 'PURCHASE', pixel_id: 'px1' },
  ...over,
});
// Four spending days ending yesterday with no purchase: a full absence streak, still delivering.
const absentDays = { as1: [4, 3, 2, 1].map((n) => ({ date: day(n), spend: 25, families: [] as string[] })) };

const ok = (over: Partial<OptimisationInputs> = {}): OptimisationInputs => ({
  status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {}, ...over,
});
const ARRIVING = ok({ adSets: [purchaseAdSet()], receivedEventsByPixel: { px1: ['PageView', 'Purchase'] } });
const CONFIRMED_MISSING = ok({
  adSets: [purchaseAdSet()], receivedEventsByPixel: { px1: ['PageView'] }, spendingDaysByAdSet: absentDays,
});
const stateOf = (i: OptimisationInputs) =>
  selectedEventState(evaluateAccountOptimisationCoverage(i.adSets, i.receivedEventsByPixel, i.spendingDaysByAdSet, TODAY));

function client(accounts: any[], adAccount = '') {
  (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'admin-user', isAdmin: true });
  (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
    userId: 'client-user', email: 'client@example.com', displayName: 'Client User', adAccount,
  });
  (getAccountsByUserId as jest.Mock).mockResolvedValueOnce(accounts);
}
const metaAccount = (over: any = {}) => ({
  platform: 'meta',
  config: { account_type: 'ad_account', ad_account_id: '333333', access_token: 'tok', granted_scopes: ['ads_read'], has_meta_pages: true, ...over },
});
const healthOf = async () =>
  (await assessClientHealth('admin-user', 'client@example.com')).health.ads_layer.meta_connection_health;

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockReset();
});

describe('ENG-3079 selectedEventState (the monitor verdict, reduced to one word)', () => {
  it('recent: a pixel reported the optimisation event', () => {
    expect(stateOf(ARRIVING)).toBe('recent');
  });

  it('missing: the monitor-confirmed case (pixel silent on the event, full absence streak, still delivering)', () => {
    expect(stateOf(CONFIRMED_MISSING)).toBe('missing');
  });

  it('missing wins when one ad set is arriving and another is confirmed missing', () => {
    const mixed = ok({
      adSets: [purchaseAdSet(), purchaseAdSet({ id: 'as2', promoted_object: { custom_event_type: 'LEAD', pixel_id: 'px2' } })],
      receivedEventsByPixel: { px1: ['PageView'], px2: ['Lead'] },
      spendingDaysByAdSet: absentDays,
    });
    expect(stateOf(mixed)).toBe('missing');
  });

  it('unknown: no conversion-optimised ad set', () => {
    expect(stateOf(ok({ adSets: [{ id: 'as1', effective_status: 'ACTIVE' }] }))).toBe('unknown');
  });

  it('unknown: the pixel reported nothing, so its silence proves nothing', () => {
    expect(stateOf(ok({ adSets: [purchaseAdSet()], spendingDaysByAdSet: absentDays }))).toBe('unknown');
  });

  it('unknown: pixel silent on the event but no confirmed streak (the monitor logs, does not alert)', () => {
    expect(stateOf(ok({ adSets: [purchaseAdSet()], receivedEventsByPixel: { px1: ['PageView'] } }))).toBe('unknown');
  });

  it('unknown: a paused ad set whose pixel reports the event (the event may come from elsewhere; nothing is delivering)', () => {
    expect(stateOf(ok({
      adSets: [purchaseAdSet({ effective_status: 'PAUSED' })],
      receivedEventsByPixel: { px1: ['PageView', 'Purchase'] },
    }))).toBe('unknown');
  });

  it('recent: a delivering ad set is arriving beside a paused one on the same pixel', () => {
    expect(stateOf(ok({
      adSets: [purchaseAdSet({ id: 'as0', effective_status: 'PAUSED' }), purchaseAdSet()],
      receivedEventsByPixel: { px1: ['PageView', 'Purchase'] },
    }))).toBe('recent');
  });

  it('unknown: a paused ad set with a silent event (the monitor never alerts on these)', () => {
    const paused = ok({
      adSets: [purchaseAdSet({ effective_status: 'PAUSED' })],
      receivedEventsByPixel: { px1: ['PageView'] },
      spendingDaysByAdSet: absentDays,
    });
    expect(stateOf(paused)).toBe('unknown');
  });
});

describe('ENG-3079 assess_client_health selected_event', () => {
  it('recent, read with the client\'s own ad account and token', async () => {
    client([metaAccount()]);
    mockRead.mockResolvedValueOnce(ARRIVING);
    const health = await healthOf();
    expect(health.selected_event).toBe('recent');
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockRead).toHaveBeenCalledWith('333333', 'tok');
  });

  it('missing does not ask for a reconnect', async () => {
    client([metaAccount()]);
    mockRead.mockResolvedValueOnce(CONFIRMED_MISSING);
    const health = await healthOf();
    expect(health.selected_event).toBe('missing');
    expect(health.reconnect_required).toBe(false);
    expect(health.reconnect_instructions).toBeUndefined();
  });

  it('a failed Meta read is unknown, never missing', async () => {
    client([metaAccount()]);
    mockRead.mockResolvedValueOnce({ ...CONFIRMED_MISSING, status: 'fetch_error', error: 'HTTP 500' });
    expect((await healthOf()).selected_event).toBe('unknown');
  });

  it('a read that throws is unknown and the health check still succeeds', async () => {
    client([metaAccount()]);
    mockRead.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await assessClientHealth('admin-user', 'client@example.com');
    expect(result.success).toBe(true);
    expect(result.health.ads_layer.meta_connection_health.selected_event).toBe('unknown');
  });

  it('no conversion-optimised ad set is unknown', async () => {
    client([metaAccount()]);
    mockRead.mockResolvedValueOnce(ok({ adSets: [{ id: 'as1', effective_status: 'ACTIVE' }] }));
    expect((await healthOf()).selected_event).toBe('unknown');
  });

  it('no connected Meta ad account: nothing is read', async () => {
    client([], '999999');
    const result = await assessClientHealth('admin-user', 'client@example.com');
    expect(result.success).toBe(true);
    expect(result.health.ads_layer.meta_connection_health).toBeUndefined();
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('ENG-3079 readSelectedEventState bound', () => {
  it('a read that never answers falls back to unknown at the timeout', async () => {
    mockRead.mockReturnValueOnce(new Promise(() => undefined));
    const started = Date.now();
    await expect(readSelectedEventState('333333', 'tok', 30)).resolves.toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a read that answers in time is used', async () => {
    mockRead.mockResolvedValueOnce(ARRIVING);
    await expect(readSelectedEventState('333333', 'tok', 30)).resolves.toBe('recent');
  });
});
