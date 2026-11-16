// The hot-lead call hook must not change the Slack lead alert: with the master switch off, the real
// dispatchLeadCreated makes exactly the same db, queue and Slack calls as with the hot-lead service
// stubbed out. With the switch on, the Slack-side calls (queue, writes, post) are compared, since the
// hot-lead service legitimately adds its own reads.
const hotLeadCall = { live: false, spy: jest.fn() };
jest.mock('../services/hotLeadCallService', () => ({
  dispatchHotLeadCall: (...args: unknown[]) => {
    hotLeadCall.spy(...args);
    return hotLeadCall.live
      ? jest.requireActual('../services/hotLeadCallService').dispatchHotLeadCall(...args)
      : Promise.resolve();
  },
}));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
import { callConsentRecord } from './helpers/hotLeadCallFixtures';
import { notificationLookup } from '../services/leadNotificationLookup';
const postMessage = jest.fn();
const authTest = jest.fn();
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn(() => ({ auth: { test: authTest }, chat: { postMessage } })) }));
jest.mock('../services/db', () => ({
  ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS,
  crmDb: {
    getLeadListById: jest.fn(), getLeadById: jest.fn(), claimLeadStepOnce: jest.fn(), setLeadFields: jest.fn(),
    addLeadEngagement: jest.fn(), createLeadSystemRecordOnce: jest.fn(), updateLeadSystemRecordIf: jest.fn(),
  },
  userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(),
  startHeartbeat: jest.fn(() => jest.fn()), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
import { WebClient } from '@slack/web-api';
import { crmDb, userDb, orgDb } from '../services/db';
import * as queue from '../services/asyncJobQueue';
import { dispatchLeadCreated, dispatchLeadsCreated } from '../services/orgLeadNotificationService';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { FakeLimitStore } from './helpers/fakeLimitStore';
import { setLimitStoreForTests } from '../services/voice/limitStore';
import { teamMember } from './helpers/hotLeadCallFixtures';

const mock = (fn: unknown) => fn as jest.Mock;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const slackOrg = {
  orgId: 'org-a', leadNotifications: { enabled: true, slackChannelId: 'C123' },
  connected_accounts: [{ platform: 'slack', account_id: 'T123', config: { account_type: 'bot', access_token: 'xoxb-org-a', team_id: 'T123' } }],
};
const callConfig = {
  enabled: true, team: [teamMember('+14155550100')], twilioNumber: '+14155550111',
  announcedName: 'Acme', callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};
const originalJwtSecret = process.env.JWT_SECRET;
afterAll(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});
let provider: FakeVoiceProvider;
let limits: FakeLimitStore;
let org: Record<string, unknown>;

beforeEach(() => {
  jest.resetAllMocks();
  // Only Date is faked: 12:00 in the call window (America/Chicago), so the calling-hours gate never depends on when this runs.
  jest.useFakeTimers({
    now: new Date('2026-10-19T17:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
  process.env.JWT_SECRET = 'test-secret';
  setHotLeadCallEntitledOverride(true);
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
  hotLeadCall.live = false;
  mock(notificationLookup.campaigns).mockResolvedValue({ rows: [], truncated: false });
  mock(notificationLookup.pages).mockResolvedValue([]);
  mock(WebClient).mockImplementation(() => ({ auth: { test: authTest }, chat: { postMessage } }));
  provider = new FakeVoiceProvider();
  setVoiceProviderForTests(provider);
  org = { ...slackOrg };
  mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list-a', userId: 'owner-a', name: 'Inbound' });
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a' });
  mock(orgDb.getOrgById).mockImplementation(async () => org);
  mock(crmDb.getLeadById).mockResolvedValue({
    listId: 'list-a', leadId: 'lead-a', firstName: 'Jane', email: 'jane@example.com', phone: '+12125550142',
    createdAt: new Date().toISOString(), customFields: { source: 'landing' }, system: { callConsent: callConsentRecord() },
  });
  mock(crmDb.claimLeadStepOnce).mockResolvedValue(true);
  mock(crmDb.setLeadFields).mockResolvedValue(undefined);
  mock(crmDb.createLeadSystemRecordOnce).mockResolvedValue(true);
  mock(crmDb.updateLeadSystemRecordIf).mockResolvedValue(true);
  mock(queue.enqueueJob).mockResolvedValue('enqueued');
  mock(queue.startHeartbeat).mockReturnValue(jest.fn());
  authTest.mockResolvedValue({ ok: true, team_id: 'T123', bot_id: 'B123' });
  postMessage.mockResolvedValue({ ok: true, ts: '1.2' });
});
afterEach(() => {
  jest.useRealTimers();
  setLimitStoreForTests(null);
  setHotLeadCallEnabledOverride(null);
  setHotLeadCallEntitledOverride(null);
  setVoiceProviderForTests(null);
});

const READS = [crmDb.getLeadListById, crmDb.getLeadById, userDb.getUserById, orgDb.getOrgById];
const SLACK_SIDE = [crmDb.claimLeadStepOnce, crmDb.setLeadFields, queue.enqueueJob, queue.markJobComplete, queue.markJobFailed,
  queue.startHeartbeat, postMessage, authTest, crmDb.addLeadEngagement, crmDb.createLeadSystemRecordOnce, crmDb.updateLeadSystemRecordIf];
const touched = [...READS, ...SLACK_SIDE];
const callsOf = () => touched.map(fn => mock(fn).mock.calls);
const slackSide = () => SLACK_SIDE.map(fn => mock(fn).mock.calls);

async function baseline(run: () => Promise<void>) {
  hotLeadCall.live = false;
  setHotLeadCallEnabledOverride(false);
  await run();
  await flush();
  const result = { all: callsOf(), slack: slackSide() };
  jest.clearAllMocks();
  return result;
}

describe('hot-lead call hook leaves the Slack lead alert untouched', () => {
  const create = () => dispatchLeadCreated('list-a', 'lead-a', 'form_fill');

  it('baseline sanity: the Slack alert is actually sent in this harness', async () => {
    await create();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(mock(queue.enqueueJob).mock.calls[0][0]).toBe('org_lead_notification');
  });

  it('mode off, org with a call config: identical calls to the no-op run; no reads, enqueue, provider call or write', async () => {
    org = { ...slackOrg, hotLeadCall: callConfig };
    const expected = await baseline(create);
    hotLeadCall.live = true;
    setHotLeadCallEnabledOverride(false);
    await create();
    await flush();
    expect(hotLeadCall.spy).toHaveBeenCalled();
    expect(callsOf()).toEqual(expected.all);
    expect(mock(queue.enqueueJob).mock.calls.map(c => c[0])).not.toContain('hot_lead_call');
    expect(provider.placedCalls).toEqual([]);
    expect(limits.keysTouched).toEqual([]);
  });

  it('mode on, org without a hotLeadCall config: Slack side identical, no hot_lead_call enqueue or provider call', async () => {
    const expected = await baseline(create);
    hotLeadCall.live = true;
    setHotLeadCallEnabledOverride(true);
    await create();
    await flush();
    expect(slackSide()).toEqual(expected.slack);
    expect(mock(queue.enqueueJob).mock.calls.map(c => c[0])).toEqual(['org_lead_notification']);
    expect(mock(crmDb.claimLeadStepOnce)).toHaveBeenCalledTimes(1);
    expect(mock(crmDb.addLeadEngagement)).not.toHaveBeenCalled();
    expect(provider.placedCalls).toEqual([]);
    expect(limits.keysTouched).toEqual([]);
  });

  it('mode on and fully configured: the Slack post is identical, and the call is placed', async () => {
    const expected = await baseline(create);
    org = { ...slackOrg, hotLeadCall: callConfig };
    hotLeadCall.live = true;
    setHotLeadCallEnabledOverride(true);
    await create();
    await flush();
    const sources = mock(queue.enqueueJob).mock.calls.map(c => c[0]).sort();
    expect(sources).toEqual(['hot_lead_call', 'org_lead_notification']);
    expect(postMessage.mock.calls).toEqual(expected.slack[SLACK_SIDE.indexOf(postMessage)]);
    expect(provider.placedCalls).toHaveLength(1);
    expect(limits.keysTouched.length).toBeGreaterThan(0);
    // The only claim is Slack's own; the hot-lead call takes none.
    expect(mock(crmDb.claimLeadStepOnce)).toHaveBeenCalledTimes(1);
    expect(mock(crmDb.claimLeadStepOnce).mock.calls[0][2]).toMatch(/^leadNotification_/);
  });

  it('does not wait for the call: the Slack post lands while record creation is still blocked', async () => {
    org = { ...slackOrg, hotLeadCall: callConfig };
    hotLeadCall.live = true;
    setHotLeadCallEnabledOverride(true);
    let release!: (created: boolean) => void;
    mock(crmDb.createLeadSystemRecordOnce).mockReturnValue(new Promise<boolean>(resolve => { release = resolve; }));
    const done = create();
    await flush();
    expect(crmDb.createLeadSystemRecordOnce).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    await done; // would never settle if the hook were awaited
    expect(provider.placedCalls).toHaveLength(0);
    release(true);
    await flush();
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('a failing call placement cannot fail or delay the Slack alert', async () => {
    org = { ...slackOrg, hotLeadCall: callConfig };
    hotLeadCall.live = true;
    setHotLeadCallEnabledOverride(true);
    provider.failNextPlaceCall('unknown');
    await expect(create()).resolves.toBeUndefined();
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(provider.placedCalls).toHaveLength(1);
  });
});

describe('hook wiring', () => {
  it('fires for a single create with the origin, and for a repeat submission with the submission', async () => {
    const submission = { submissionId: 's1', submittedAt: '2026-10-19T12:00:00.000Z' };
    await dispatchLeadCreated('list-a', 'lead-a', 'form_fill');
    await dispatchLeadCreated('list-a', 'lead-a', 'form_fill', submission);
    expect(hotLeadCall.spy.mock.calls).toEqual([
      ['list-a', 'lead-a', 'form_fill', undefined],
      ['list-a', 'lead-a', 'form_fill', submission],
    ]);
  });

  it('still fires for an org with no Slack routing at all (the Slack path returns early)', async () => {
    org = { orgId: 'org-a' };
    await dispatchLeadCreated('list-a', 'lead-a', 'form_fill');
    expect(postMessage).not.toHaveBeenCalled();
    expect(hotLeadCall.spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire for the batch path', async () => {
    await dispatchLeadsCreated('list-a', ['lead-a', 'lead-b'], 'form_fill');
    expect(postMessage).toHaveBeenCalled();
    expect(hotLeadCall.spy).not.toHaveBeenCalled();
  });
});
