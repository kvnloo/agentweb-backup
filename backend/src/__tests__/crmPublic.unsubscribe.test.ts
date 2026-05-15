/**
 * Tests for the HMAC-signed unsubscribe verification on
 *   POST /api/crm/public/lists/:listId/leads/:leadId/group-email-unsubscribe
 *
 * Behaviour we want:
 *  - sig is provided AND valid -> success
 *  - sig is provided AND invalid -> 403
 *  - no sig provided AND email matches lead -> success (legacy path)
 *  - no sig provided AND email mismatches lead -> 403
 */

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  userDb: {},
}));

jest.mock('../services/contactCaptureHooks', () => ({
  onPublicFormSubmitted: jest.fn(),
  onPublicPageVisited: jest.fn(),
}));

jest.mock('../services/contactEventsDb', () => ({
  PUBLIC_LOGGABLE_EVENT_TYPES: new Set(['form.submitted', 'page.visited']),
}));

const ORIGINAL_SECRET = process.env.JWT_SECRET;

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-for-unsubscribe';
});

afterAll(() => {
  process.env.JWT_SECRET = ORIGINAL_SECRET;
});

import express from 'express';
import request from 'supertest';
import publicRouter from '../routes/crmPublic';
import { crmDb } from '../services/db';
import { signUnsubscribeUrl } from '../utils/unsubscribeUrl';

const app = express();
app.use(express.json());
app.use('/api/crm/public', publicRouter);

beforeEach(() => {
  jest.clearAllMocks();
  (crmDb.getLeadById as jest.Mock).mockResolvedValue({
    leadId: 'lead-1',
    email: 'user@test.com',
  });
  (crmDb.updateLead as jest.Mock).mockResolvedValue({});
});

const path = '/api/crm/public/lists/list-1/leads/lead-1/group-email-unsubscribe';

function getSig(listId: string, leadId: string, email: string): string {
  const url = signUnsubscribeUrl({
    baseUrl: 'https://app.agentweb.pro',
    listId,
    leadId,
    email,
  });
  return new URL(url).searchParams.get('sig')!;
}

describe('POST /api/crm/public/.../group-email-unsubscribe (HMAC fix)', () => {
  it('accepts a valid signature regardless of the email-match check', async () => {
    const sig = getSig('list-1', 'lead-1', 'user@test.com');
    const res = await request(app).post(path).send({
      email: 'user@test.com',
      sig,
    });
    expect(res.status).toBe(200);
    expect(crmDb.updateLead).toHaveBeenCalled();
  });

  it('rejects with 403 when sig is provided but invalid (tampered)', async () => {
    const sig = getSig('list-EVIL', 'lead-1', 'user@test.com'); // signed for wrong list
    const res = await request(app).post(path).send({
      email: 'user@test.com',
      sig,
    });
    expect(res.status).toBe(403);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('rejects with 403 when sig is provided but malformed', async () => {
    const res = await request(app).post(path).send({
      email: 'user@test.com',
      sig: 'not-a-real-sig',
    });
    expect(res.status).toBe(403);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('falls back to email-match check when no sig provided (legacy URLs)', async () => {
    const res = await request(app).post(path).send({
      email: 'user@test.com',
    });
    expect(res.status).toBe(200);
    expect(crmDb.updateLead).toHaveBeenCalled();
  });

  it('returns 403 when no sig and email mismatches', async () => {
    const res = await request(app).post(path).send({
      email: 'attacker@test.com',
    });
    expect(res.status).toBe(403);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('returns 400 when email is missing entirely', async () => {
    const res = await request(app).post(path).send({});
    expect(res.status).toBe(400);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });
});

// ─── A.3: Resubscribe HMAC parity (added Phase 4) ───────────────────────────
//
// Re-enabling sends after a lead opted out is a privilege-escalation surface
// with the same shape as unsubscribe. Resubscribe should accept HMAC sig and
// fall back to email-match for legacy URLs the same way.
const resubPath = '/api/crm/public/lists/list-1/leads/lead-1/group-email-resubscribe';

describe('POST /api/crm/public/.../group-email-resubscribe (HMAC fix)', () => {
  it('accepts a valid signature', async () => {
    const sig = getSig('list-1', 'lead-1', 'user@test.com');
    const res = await request(app).post(resubPath).send({
      email: 'user@test.com',
      sig,
    });
    expect(res.status).toBe(200);
    expect(crmDb.updateLead).toHaveBeenCalled();
  });

  it('rejects with 403 when sig is provided but tampered', async () => {
    const sig = getSig('list-EVIL', 'lead-1', 'user@test.com');
    const res = await request(app).post(resubPath).send({
      email: 'user@test.com',
      sig,
    });
    expect(res.status).toBe(403);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('falls back to email-match when no sig (legacy URLs)', async () => {
    const res = await request(app).post(resubPath).send({
      email: 'user@test.com',
    });
    expect(res.status).toBe(200);
    expect(crmDb.updateLead).toHaveBeenCalled();
  });

  it('returns 403 when no sig and email mismatches', async () => {
    const res = await request(app).post(resubPath).send({
      email: 'attacker@test.com',
    });
    expect(res.status).toBe(403);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });
});
