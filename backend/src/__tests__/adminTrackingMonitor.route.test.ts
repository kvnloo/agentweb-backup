/**
 * ENG-926 §49 — the admin dry-run route's input contract.
 *
 * These are the invalid-input cases CLAUDE.md Rule 2 asks for and the original PR did not
 * write. Their absence is why the widening bug below shipped.
 */

const runMetaTrackingMonitor = jest.fn();
jest.mock('../cron/metaTrackingMonitorCron', () => ({
  runMetaTrackingMonitor: (...a: any[]) => runMetaTrackingMonitor(...a),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/adminTrackingMonitor';

const app = express();
app.use(express.json());
app.use('/api/admin/tracking-monitor', router);

beforeEach(() => {
  runMetaTrackingMonitor.mockReset();
  runMetaTrackingMonitor.mockResolvedValue({ usersScanned: 0, capturedAlerts: [] });
});

describe('invalid scope is REJECTED, never silently widened', () => {
  it('400s on a numeric adAccountId instead of sweeping the whole fleet', async () => {
    // The shipped bug: `typeof 12345 === 'string'` is false, so it became `undefined`, which
    // reads as "no scope" — a one-account probe turned into a fleet-wide run.
    const res = await request(app).post('/api/admin/tracking-monitor/run').send({ adAccountId: 12345 });

    expect(res.status).toBe(400);
    expect(runMetaTrackingMonitor).not.toHaveBeenCalled();
  });

  it('400s on a numeric userId', async () => {
    const res = await request(app).post('/api/admin/tracking-monitor/run').send({ userId: 42 });
    expect(res.status).toBe(400);
    expect(runMetaTrackingMonitor).not.toHaveBeenCalled();
  });

  it('400s on an empty / whitespace-only scope', async () => {
    for (const body of [{ adAccountId: '' }, { adAccountId: '   ' }, { userId: '' }]) {
      const res = await request(app).post('/api/admin/tracking-monitor/run').send(body);
      expect(res.status).toBe(400);
    }
    expect(runMetaTrackingMonitor).not.toHaveBeenCalled();
  });

  it('400s on a structured value that would stringify into nonsense', async () => {
    const res = await request(app)
      .post('/api/admin/tracking-monitor/run')
      .send({ adAccountId: { id: '448692064923397' } });
    expect(res.status).toBe(400);
    expect(runMetaTrackingMonitor).not.toHaveBeenCalled();
  });
});

describe('valid input still works', () => {
  it('an OMITTED scope is unscoped — the only way to get a fleet-wide run', async () => {
    const res = await request(app).post('/api/admin/tracking-monitor/run').send({});
    expect(res.status).toBe(200);
    expect(runMetaTrackingMonitor).toHaveBeenCalledWith({
      dryRun: true,
      userId: undefined,
      adAccountId: undefined,
    });
  });

  it('defaults dryRun to true when omitted', async () => {
    await request(app).post('/api/admin/tracking-monitor/run').send({ adAccountId: '123' });
    expect(runMetaTrackingMonitor.mock.calls[0][0].dryRun).toBe(true);
  });

  it('honours an explicit dryRun:false', async () => {
    await request(app).post('/api/admin/tracking-monitor/run').send({ dryRun: false, adAccountId: '123' });
    expect(runMetaTrackingMonitor.mock.calls[0][0].dryRun).toBe(false);
  });

  it('strips the act_ prefix operators paste from Ads Manager', async () => {
    await request(app).post('/api/admin/tracking-monitor/run').send({ adAccountId: 'act_448692064923397' });
    expect(runMetaTrackingMonitor.mock.calls[0][0].adAccountId).toBe('448692064923397');
  });

  it('500s without leaking the underlying error to the caller', async () => {
    runMetaTrackingMonitor.mockRejectedValue(new Error('boom: token abc123'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/admin/tracking-monitor/run').send({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('abc123');
    errSpy.mockRestore();
  });
});
