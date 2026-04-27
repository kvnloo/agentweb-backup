import express from 'express';
import request from 'supertest';

// Mock the crmDb module (unused in the events endpoint, but imported at module top).
jest.mock('../../services/db', () => ({
  crmDb: { getLeadById: jest.fn(), updateLead: jest.fn() },
}));

// Mock the capture hooks so we control behaviour without hitting DynamoDB.
const mockOnPublicFormSubmitted = jest.fn();
const mockOnPublicPageVisited = jest.fn();
jest.mock('../../services/contactCaptureHooks', () => ({
  onPublicFormSubmitted: (...args: any[]) => mockOnPublicFormSubmitted(...args),
  onPublicPageVisited: (...args: any[]) => mockOnPublicPageVisited(...args),
}));

// We want the REAL whitelist — don't mock contactEventsDb.
import crmPublicRouter from '../crmPublic';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/crm/public', crmPublicRouter);
  return app;
}

const happyResult = (over: Partial<any> = {}) => ({
  event: {
    contactId: 'visitor@example.com',
    eventTimestamp: '2026-04-18T00:00:00Z',
    eventId: 'evt_1',
    source: 'lead_form',
    eventType: 'form.submitted',
    payload: {},
    sourceRecordId: 'form-abc',
    createdAt: '2026-04-18T00:00:00Z',
  },
  deduplicated: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockOnPublicFormSubmitted.mockResolvedValue(happyResult());
  mockOnPublicPageVisited.mockResolvedValue(
    happyResult({
      event: { ...happyResult().event, source: 'engagement', eventType: 'page.visited' },
    })
  );
});

describe('POST /api/crm/public/events', () => {
  it('accepts form.submitted and calls onPublicFormSubmitted', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'visitor@example.com',
      eventType: 'form.submitted',
      sourceRecordId: 'form-abc',
      payload: { formName: 'lead-magnet', slug: 'seo-audit' },
    });
    expect(res.status).toBe(201);
    expect(res.body.recorded).toBe(true);
    expect(res.body.deduplicated).toBe(false);
    expect(mockOnPublicFormSubmitted).toHaveBeenCalledTimes(1);
    expect(mockOnPublicFormSubmitted.mock.calls[0][0]).toMatchObject({
      email: 'visitor@example.com',
      sourceRecordId: 'form-abc',
      formName: 'lead-magnet',
    });
  });

  it('accepts page.visited and calls onPublicPageVisited', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'visitor@example.com',
      eventType: 'page.visited',
      sourceRecordId: 'visit-xyz',
      payload: { url: 'https://agentweb.pro/pricing', referrer: 'https://google.com' },
    });
    expect(res.status).toBe(201);
    expect(mockOnPublicPageVisited).toHaveBeenCalledTimes(1);
    expect(mockOnPublicPageVisited.mock.calls[0][0]).toMatchObject({
      email: 'visitor@example.com',
      url: 'https://agentweb.pro/pricing',
      referrer: 'https://google.com',
    });
  });

  it('returns 200 (not 201) when the capture hook reports deduplicated=true', async () => {
    mockOnPublicFormSubmitted.mockResolvedValueOnce(happyResult({ deduplicated: true }));
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'visitor@example.com',
      eventType: 'form.submitted',
      sourceRecordId: 'form-abc',
    });
    expect(res.status).toBe(200);
    expect(res.body.deduplicated).toBe(true);
  });

  it('rejects non-whitelisted event types (400)', async () => {
    const app = makeApp();
    for (const eventType of [
      'user.registered',
      'contact.created',
      'payment.subscribed',
      'manual.note',
      'deal.created',
    ]) {
      const res = await request(app).post('/api/crm/public/events').send({
        email: 'visitor@example.com',
        eventType,
        sourceRecordId: 'x',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not allowed on public endpoint/i);
    }
    expect(mockOnPublicFormSubmitted).not.toHaveBeenCalled();
    expect(mockOnPublicPageVisited).not.toHaveBeenCalled();
  });

  it('rejects completely unknown event types (400)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'visitor@example.com',
      eventType: 'totally.fake.type',
      sourceRecordId: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing email (400)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      eventType: 'form.submitted',
      sourceRecordId: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email/i);
  });

  it('rejects malformed email (400)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'not-an-email',
      eventType: 'form.submitted',
      sourceRecordId: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/malformed/i);
  });

  it('rejects missing sourceRecordId (400)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'a@b.com',
      eventType: 'form.submitted',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sourceRecordId/i);
  });

  it('rejects arrays or non-object payloads (400)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'a@b.com',
      eventType: 'form.submitted',
      sourceRecordId: 'x',
      payload: ['not', 'an', 'object'],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/payload/i);
  });

  it('rejects oversized payloads (400)', async () => {
    const app = makeApp();
    const bigString = 'x'.repeat(5000);
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'a@b.com',
      eventType: 'form.submitted',
      sourceRecordId: 'x',
      payload: { big: bigString },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds/i);
  });

  it('returns 500 when the capture hook itself returns null (write failure)', async () => {
    mockOnPublicFormSubmitted.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app).post('/api/crm/public/events').send({
      email: 'a@b.com',
      eventType: 'form.submitted',
      sourceRecordId: 'x',
    });
    expect(res.status).toBe(500);
  });
});
