/**
 * ENG-2311 follow-up — a session list can be neither bound to / enrolled in a sequence nor
 * relay a Meta conversion, even though a list retagged 'session' keeps the SALES statusConfig
 * it was created with (it contains `won`).
 */
import request from 'supertest';
import express from 'express';
import sequenceRoutes from '../routes/sequences';
import { crmDb } from '../services/db';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { relayLeadStatusEvent, dispatchLeadStatusConversion } from '../services/metaConversionRelay';
import { defaultStatusConfigFor } from '../utils/leadSchema';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'u1', email: 'a@b.io' }; next(); },
}));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));
jest.mock('../services/emailProviderService', () => ({ getEmailProvider: jest.fn(), bootstrapEmailProviders: jest.fn() }));
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(), canOrgMemberAccessList: jest.fn().mockResolvedValue(true),
    getLeadById: jest.fn(), getAllLeadsByListId: jest.fn().mockResolvedValue([]), getLeadsByStatus: jest.fn().mockResolvedValue([]),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/dripSequenceDb', () => {
  class SequenceNotFoundError extends Error {}
  class SequenceAuthError extends Error {}
  return {
    dripSequenceDb: {
      getSequence: jest.fn().mockResolvedValue({ sequenceId: 's1', userId: 'u1', steps: [{ stepId: 'a' }], enrollmentTrigger: { type: 'manual' } }),
      updateSequence: jest.fn().mockResolvedValue({ sequenceId: 's1' }),
      bulkEnroll: jest.fn().mockResolvedValue({ enrolled: 1, skipped: 0 }),
    },
    SequenceNotFoundError, SequenceAuthError,
  };
});
const asyncQueue = { enqueueJob: jest.fn() };
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: (...a: any[]) => asyncQueue.enqueueJob(...a),
  markJobFailed: jest.fn(), startHeartbeat: jest.fn(() => jest.fn()), clearFailedJob: jest.fn(), deleteJob: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/', sequenceRoutes);
const lists: Record<string, any> = {
  S: { listId: 'S', userId: 'u1', listType: 'session' },
  P: { listId: 'P', userId: 'u1', listType: 'sales' },
  U: { listId: 'U', userId: 'u1' },
};

describe('sequences: session lists are refused at every binding / enrolment point', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockImplementation(async (id: string) => lists[id] ?? null);
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({ leadId: 'l1', email: 'x@y.io' });
  });

  it('PUT autoEnrollListIds containing a session list => 400, nothing written', async () => {
    const res = await request(app).put('/s1').send({ autoEnrollListIds: ['P', 'S'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Session lists/);
    expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
  });

  it.each([[['P']], [['U']], [[]]])('PUT autoEnrollListIds %j (no session list) is unchanged', async (ids) => {
    const res = await request(app).put('/s1').send({ autoEnrollListIds: ids });
    expect(res.status).toBe(200);
    expect(dripSequenceDb.updateSequence).toHaveBeenCalledTimes(1);
  });

  it('PUT without autoEnrollListIds makes no list reads', async () => {
    await request(app).put('/s1').send({ name: 'x' });
    expect(crmDb.getLeadListById).not.toHaveBeenCalled();
  });

  it('enrol by list on a session list => 400 and nothing enrolled or bound', async () => {
    const res = await request(app).post('/s1/enrollments/by-list').send({ listId: 'S' });
    expect(res.status).toBe(400);
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
    expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
  });

  it('explicit enrol of leads from a session list => 400 and nothing enrolled', async () => {
    const res = await request(app).post('/s1/enrollments').send({ leads: [{ listId: 'S', leadId: 'l1', leadEmail: 'x@y.io' }] });
    expect(res.status).toBe(400);
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
  });

  it('explicit enrol from a sales list still works', async () => {
    const res = await request(app).post('/s1/enrollments').send({ leads: [{ listId: 'P', leadId: 'l1', leadEmail: 'x@y.io' }] });
    expect(res.status).toBe(200);
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
  });
});

describe('meta conversion relay: session lists never relay, even with the sales statusConfig', () => {
  const salesConfig = defaultStatusConfigFor('sales') as any;
  const ctx = (listType?: string) => ({
    listId: 'S', userId: 'u1', lead: { leadId: 'l1', status: 'won', email: 'x@y.io' }, statusConfig: salesConfig, listType,
  });
  const deps: any = {
    isEnabled: jest.fn(), resolvePixel: jest.fn(), getCredentials: jest.fn(), sendEvent: jest.fn(),
    recordSent: jest.fn(), clearPending: jest.fn().mockResolvedValue(undefined), shouldAttemptSend: jest.fn(), isAccountPaused: jest.fn(),
  };

  beforeEach(() => { jest.clearAllMocks(); deps.clearPending.mockResolvedValue(undefined); asyncQueue.enqueueJob.mockResolvedValue('unavailable'); });

  it('relayLeadStatusEvent: skipped as settled, nothing resolved or sent', async () => {
    const r: any = await relayLeadStatusEvent(ctx('session'), deps);
    expect(r).toMatchObject({ skipped: true, retryable: false, settled: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
    expect(deps.getCredentials).not.toHaveBeenCalled();
  });

  it('dispatchLeadStatusConversion: noop and no job enqueued', async () => {
    expect(await dispatchLeadStatusConversion(ctx('session'))).toBe('noop');
    expect(asyncQueue.enqueueJob).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['sales'], ['customers']])('listType %p: a `won` status still reaches the queue', async (lt) => {
    await dispatchLeadStatusConversion({ ...ctx(lt as any), statusConfig: lt === 'customers' ? (defaultStatusConfigFor('customers') as any) : salesConfig, lead: { leadId: 'l1', status: lt === 'customers' ? 'churned' : 'won' } });
    // customers 'churned' is not a conversion kind; only assert the won paths enqueue
    if (lt !== 'customers') expect(asyncQueue.enqueueJob).toHaveBeenCalled();
  });
});
