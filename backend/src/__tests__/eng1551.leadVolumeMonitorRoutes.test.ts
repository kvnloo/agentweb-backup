/**
 * ENG-1551 — lead volume monitor route, focused on input validation.
 *
 * `monitorLeadVolume` itself is covered exhaustively in `eng1551.leadVolumeMonitorService.test.ts`
 * (mocked here); this file only re-proves the route's own validation, not the service's logic.
 */

import request from 'supertest';
import express from 'express';
import leadVolumeMonitorRoutes from '../routes/leadVolumeMonitor';
import * as service from '../services/leadVolumeMonitorService';

jest.mock('../services/leadVolumeMonitorService');

const mockMonitor = service.monitorLeadVolume as jest.Mock;

// This router does not apply authenticateToken/isAdmin itself — those are mounted around it in
// app.ts (`app.use("/api/lead-volume-monitor", authenticateToken, isAdmin, leadVolumeMonitorRoutes)`),
// same as its sibling `clientHealth.ts`. So the isolated test app injects req.user directly rather
// than mocking a module this router never imports.
function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.user = { userId: 'caller-1', isAdmin: true };
    next();
  });
  a.use('/api/lead-volume-monitor', leadVolumeMonitorRoutes);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMonitor.mockResolvedValue({ success: true, reports: [], truncated: false });
});

describe('since/until validation', () => {
  it('accepts a request with no since/until at all', async () => {
    const res = await request(app()).get('/api/lead-volume-monitor/haven@example.com');
    expect(res.status).toBe(200);
    expect(mockMonitor).toHaveBeenCalledTimes(1);
  });

  it('accepts well-formed since and until', async () => {
    const res = await request(app()).get('/api/lead-volume-monitor/haven@example.com?since=2026-01-01&until=2026-01-31');
    expect(res.status).toBe(200);
  });

  it.each(['2026/01/01', 'Jan 1 2026', 'not-a-date', '2026-1-1', ''])(
    'rejects a malformed since %p with 400, not a silent empty result',
    async badSince => {
      const res = await request(app()).get(`/api/lead-volume-monitor/haven@example.com?since=${encodeURIComponent(badSince)}`);
      expect(res.status).toBe(400);
      expect(mockMonitor).not.toHaveBeenCalled();
    },
  );

  it('rejects a malformed until with 400', async () => {
    const res = await request(app()).get('/api/lead-volume-monitor/haven@example.com?until=not-a-date');
    expect(res.status).toBe(400);
    expect(mockMonitor).not.toHaveBeenCalled();
  });

  it('rejects since after until', async () => {
    const res = await request(app()).get('/api/lead-volume-monitor/haven@example.com?since=2026-02-01&until=2026-01-01');
    expect(res.status).toBe(400);
    expect(mockMonitor).not.toHaveBeenCalled();
  });

  it('accepts since equal to until (a single-day window)', async () => {
    const res = await request(app()).get('/api/lead-volume-monitor/haven@example.com?since=2026-01-01&until=2026-01-01');
    expect(res.status).toBe(200);
  });

  it('rejects a window wider than the configured cap', async () => {
    const res = await request(app()).get('/api/lead-volume-monitor/haven@example.com?since=2020-01-01&until=2026-01-01');
    expect(res.status).toBe(400);
    expect(mockMonitor).not.toHaveBeenCalled();
  });
});

describe('truncated pass-through', () => {
  it('surfaces truncated: true from the service in the response body', async () => {
    mockMonitor.mockResolvedValue({ success: true, reports: [], truncated: true });
    const res = await request(app()).get('/api/lead-volume-monitor/haven@example.com');
    expect(res.body.truncated).toBe(true);
  });
});
