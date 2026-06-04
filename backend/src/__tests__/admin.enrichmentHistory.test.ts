// Tests for enrichment-history-related DB methods and admin routes.
//
// Covers:
//   1. crmDb.parseEnrichmentNextToken — base64 decode + JSON parse, 400 on bad input
//   2. GET /api/admin/lead-lists route — userId param routing + error handling
//   3. getEnrichmentSnapshotsByJobId — Limit cap (201) and _meta row exclusion

// ─── AWS SDK mock (must be first, before any import of db.ts) ────────────────

const queryPromiseMock = jest.fn();
const scanPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const querySpy = jest.fn(() => ({ promise: queryPromiseMock }));
const scanSpy = jest.fn(() => ({ promise: scanPromiseMock }));
const getSpy = jest.fn(() => ({ promise: getPromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: getSpy,
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      query: querySpy,
      scan: scanSpy,
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Responses: {} }) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

// Side-effect-free service mocks needed by db.ts module load
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn().mockResolvedValue({ event: {}, deduplicated: false }) },
  normalizeContactId: (raw: string) => raw.trim().toLowerCase(),
}));

// ─── Route-level mocks (for /api/admin/lead-lists) ───────────────────────────

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/waitlistDb', () => ({ waitlistDb: { list: jest.fn() } }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));
jest.mock('../services/workflowDb', () => ({}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { crmDb } from '../services/db';
import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

// ─── parseEnrichmentNextToken ─────────────────────────────────────────────────

describe('crmDb.parseEnrichmentNextToken', () => {
  // FAIL: completely invalid base64 that also isn't valid JSON → throws 400
  it('throws with statusCode 400 for a non-base64 / invalid string', () => {
    expect(() => crmDb.parseEnrichmentNextToken('!!!not-valid-base64!!!')).toThrow();
    try {
      crmDb.parseEnrichmentNextToken('!!!not-valid-base64!!!');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/invalid pagination token/i);
    }
  });

  // FAIL: valid base64 but the decoded content is not JSON
  it('throws with statusCode 400 when base64 decodes to non-JSON', () => {
    const notJson = Buffer.from('this is not json').toString('base64');
    expect(() => crmDb.parseEnrichmentNextToken(notJson)).toThrow();
    try {
      crmDb.parseEnrichmentNextToken(notJson);
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });

  // SUCCESS: valid base64-encoded JSON returns the parsed object
  it('returns parsed object for valid base64-encoded JSON', () => {
    const payload = { jobId: 'job-1', leadId: 'lead-2', createdAt: '2026-01-01T00:00:00Z' };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    const result = crmDb.parseEnrichmentNextToken(token);
    expect(result).toEqual(payload);
  });
});

// ─── GET /api/admin/lead-lists ───────────────────────────────────────────────

describe('GET /api/admin/lead-lists', () => {
  const mockLists = [
    { listId: 'list-1', name: 'Alpha', userId: 'user-1' },
    { listId: 'list-2', name: 'Beta', userId: 'user-2' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL: no userId param → calls getAllLeadLists (scan-based)
  it('calls getAllLeadLists when no userId param is provided', async () => {
    scanPromiseMock.mockResolvedValue({ Items: mockLists });

    const res = await request(app).get('/api/admin/lead-lists').expect(200);

    expect(scanSpy).toHaveBeenCalled();
    expect(res.body).toEqual(
      mockLists.map(l => ({ listId: l.listId, name: l.name, userId: l.userId })),
    );
  });

  // FAIL: userId param → calls getLeadListsByUserId (query-based)
  it('calls getLeadListsByUserId when userId param is provided', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [mockLists[0]] });

    const res = await request(app)
      .get('/api/admin/lead-lists?userId=user-1')
      .expect(200);

    expect(querySpy).toHaveBeenCalled();
    const calledParams = (querySpy.mock.calls as any[])[0]?.[0];
    expect(calledParams?.ExpressionAttributeValues[':userId']).toBe('user-1');
    expect(res.body).toEqual([{ listId: 'list-1', name: 'Alpha', userId: 'user-1' }]);
  });

  // FAIL: DB scan throws → route returns 500
  it('returns 500 when the DB call throws', async () => {
    scanPromiseMock.mockRejectedValue(new Error('DynamoDB connection error'));

    const res = await request(app).get('/api/admin/lead-lists').expect(500);

    expect(res.body.message).toMatch(/failed to fetch lead lists/i);
  });

  // SUCCESS: response maps list objects to {listId, name, userId}
  it('returns mapped {listId, name, userId} objects', async () => {
    const rawItems = [
      { listId: 'list-3', name: 'Gamma', userId: 'user-3', extraField: 'should_be_stripped' },
    ];
    scanPromiseMock.mockResolvedValue({ Items: rawItems });

    const res = await request(app).get('/api/admin/lead-lists').expect(200);

    expect(res.body).toEqual([{ listId: 'list-3', name: 'Gamma', userId: 'user-3' }]);
    expect(res.body[0]).not.toHaveProperty('extraField');
  });
});

// ─── getEnrichmentSnapshotsByJobId cap behavior ───────────────────────────────

describe('crmDb.getEnrichmentSnapshotsByJobId — cap and _meta filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Returns max 200 snapshots (Limit: 201, slice to 200)
  it('returns at most 200 snapshots when DB returns 201 items', async () => {
    const items: any[] = Array.from({ length: 201 }, (_, i) => ({
      jobId: 'job-cap',
      leadId: `lead-${i}`,
      previousCustomFields: {},
    }));
    queryPromiseMock.mockResolvedValue({ Items: items });

    const result = await crmDb.getEnrichmentSnapshotsByJobId('job-cap');

    expect(result).toHaveLength(200);
    // Verify Limit was 201 (cap + 1 for _meta)
    const calledParams = (querySpy.mock.calls as any[])[0]?.[0];
    expect(calledParams?.Limit).toBe(201);
  });

  // _meta rows are excluded from results
  it('excludes _meta row from returned snapshots', async () => {
    const items: any[] = [
      { jobId: 'job-meta', leadId: '_meta', status: 'completed' },
      { jobId: 'job-meta', leadId: 'lead-1', previousCustomFields: { company_name: 'Acme' } },
      { jobId: 'job-meta', leadId: 'lead-2', previousCustomFields: {} },
    ];
    queryPromiseMock.mockResolvedValue({ Items: items });

    const result = await crmDb.getEnrichmentSnapshotsByJobId('job-meta');

    const metaRows = result.filter((r: any) => r.leadId === '_meta');
    expect(metaRows).toHaveLength(0);
    expect(result).toHaveLength(2);
  });
});

// ─── getEnrichmentJobMeta (B9) ────────────────────────────────────────────────

describe('crmDb.getEnrichmentJobMeta', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the _meta item when found', async () => {
    const metaItem = { jobId: 'job-b9', leadId: '_meta', processedCount: 6, listId: 'list-1' };
    getPromiseMock.mockResolvedValue({ Item: metaItem });

    const result = await crmDb.getEnrichmentJobMeta('job-b9');

    expect(getSpy).toHaveBeenCalledTimes(1);
    const params = (getSpy.mock.calls as any[])[0][0];
    expect(params.Key).toEqual({ jobId: 'job-b9', leadId: '_meta' });
    expect(result).toEqual(metaItem);
  });

  it('returns null when item does not exist', async () => {
    getPromiseMock.mockResolvedValue({ Item: undefined });

    const result = await crmDb.getEnrichmentJobMeta('nonexistent-job');

    expect(result).toBeNull();
  });
});

// ─── getEnrichmentJobsByListId — date filter + pagination (B5/B2) ─────────────

describe('crmDb.getEnrichmentJobsByListId — date filter and pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns jobs and base64 nextToken when LastEvaluatedKey present', async () => {
    const mockJob = { jobId: 'j1', leadId: '_meta', listId: 'list-1', createdAt: '2026-01-01T00:00:00Z' };
    const lastKey = { jobId: 'j1', leadId: '_meta' };
    queryPromiseMock.mockResolvedValue({ Items: [mockJob], LastEvaluatedKey: lastKey });

    const result = await crmDb.getEnrichmentJobsByListId('list-1');

    expect(result.jobs).toHaveLength(1);
    expect(typeof result.nextToken).toBe('string');
    expect(JSON.parse(Buffer.from(result.nextToken!, 'base64').toString())).toEqual(lastKey);
  });

  it('returns undefined nextToken when no more pages', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

    const result = await crmDb.getEnrichmentJobsByListId('list-1');

    expect(result.nextToken).toBeUndefined();
  });

  it('uses BETWEEN key expression when both startDate and endDate provided', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [] });

    await crmDb.getEnrichmentJobsByListId('list-1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');

    const params = (querySpy.mock.calls as any[])[0][0];
    expect(params.KeyConditionExpression).toContain('BETWEEN');
    expect(params.ExpressionAttributeValues[':start']).toBe('2026-01-01T00:00:00Z');
    expect(params.ExpressionAttributeValues[':end']).toBe('2026-02-01T00:00:00Z');
  });

  it('does NOT add :start/:end when only startDate provided — prevents DynamoDB ValidationException', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [] });

    await crmDb.getEnrichmentJobsByListId('list-1', '2026-01-01T00:00:00Z');

    const params = (querySpy.mock.calls as any[])[0][0];
    expect(params.KeyConditionExpression).not.toContain('BETWEEN');
    expect(params.ExpressionAttributeValues[':start']).toBeUndefined();
    expect(params.ExpressionAttributeValues[':end']).toBeUndefined();
  });

  it('filters out non-_meta rows from results', async () => {
    queryPromiseMock.mockResolvedValue({
      Items: [
        { jobId: 'j1', leadId: '_meta', listId: 'list-1' },
        { jobId: 'j1', leadId: 'lead-1', listId: 'list-1' },
      ],
    });

    const result = await crmDb.getEnrichmentJobsByListId('list-1');

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].leadId).toBe('_meta');
  });
});

// ─── Admin detail route — B9 (uses getEnrichmentJobMeta not scan+filter) ──────

describe('GET /api/admin/lists/:listId/enrichment-jobs/:jobId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns job + snapshots when meta found for listId', async () => {
    const metaItem = { jobId: 'job-detail', leadId: '_meta', listId: 'list-detail', processedCount: 3 };
    getPromiseMock.mockResolvedValue({ Item: metaItem });
    queryPromiseMock.mockResolvedValue({ Items: [
      { jobId: 'job-detail', leadId: 'lead-1', previousCustomFields: {} },
    ]});

    const res = await request(app)
      .get('/api/admin/lists/list-detail/enrichment-jobs/job-detail')
      .expect(200);

    expect(res.body.job).toEqual(metaItem);
    expect(res.body.leads).toHaveLength(1);
  });

  it('returns 404 when job not found', async () => {
    getPromiseMock.mockResolvedValue({ Item: undefined });
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const res = await request(app)
      .get('/api/admin/lists/list-x/enrichment-jobs/nonexistent')
      .expect(404);

    expect(res.body.message).toMatch(/not found/i);
  });

  it('returns 404 when job belongs to different listId', async () => {
    const metaItem = { jobId: 'job-other', leadId: '_meta', listId: 'list-OTHER', processedCount: 1 };
    getPromiseMock.mockResolvedValue({ Item: metaItem });
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const res = await request(app)
      .get('/api/admin/lists/list-WRONG/enrichment-jobs/job-other')
      .expect(404);

    expect(res.body.message).toMatch(/not found/i);
  });
});
