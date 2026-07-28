/**
 * Tests for the Fathom webhook handler at /api/webhooks/fathom (ENG-259).
 *
 * The cloud ingestion path: a `recording.ready` webhook is validated, its action items
 * are deterministically extracted, and the batch is reconciled against Linear through
 * the canonical reconciliation engine (`fathomLinearRouter`) via the registered
 * `LinearPort`. Mode is governed by FATHOM_LINEAR_ROUTER_MODE (off | shadow | live,
 * default shadow — shadow computes and reports every decision but writes nothing).
 *
 * These tests run the REAL extraction + REAL engine against a mocked LinearPort, so
 * they exercise the wired pipeline end-to-end (ingestion → extraction → reconciliation
 * → run report) with the external Linear boundary mocked.
 */

jest.mock('../services/fathomOnboardingIngestionService', () => ({
  ingestFathomOnboardingRecording: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import fathomWebhookRouter from '../routes/fathomWebhook';
import { ingestFathomOnboardingRecording } from '../services/fathomOnboardingIngestionService';
import {
  registerFathomLinearPort,
  _resetFathomLinearPort,
} from '../services/fathomLinearPortRegistry';
import type { LinearCandidateIssue, LinearPort } from '../services/fathomLinearRouter';
import * as routerModule from '../services/fathomLinearRouter';

const mockedIngest = ingestFathomOnboardingRecording as jest.MockedFunction<
  typeof ingestFathomOnboardingRecording
>;

const app = express();
app.use(express.json());
app.use('/api/webhooks/fathom', fathomWebhookRouter);

function mockPort(overrides: Partial<LinearPort> = {}): jest.Mocked<LinearPort> {
  return {
    findByFathomKey: jest.fn().mockResolvedValue(null),
    searchIssues: jest.fn().mockResolvedValue([]),
    createIssue: jest.fn().mockResolvedValue({
      id: 'uuid-new',
      identifier: 'ENG-999',
      team: 'ENG',
      title: 'created',
      description: '',
      url: 'https://linear.app/x/ENG-999',
    } satisfies LinearCandidateIssue),
    addComment: jest.fn().mockResolvedValue(undefined),
    relateIssues: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as jest.Mocked<LinearPort>;
}

const validPayload = {
  event: 'recording.ready',
  data: {
    recording_id: 101,
    meeting: {
      id: 1,
      title: 'Baldwin Group weekly sync',
      created_at: '2026-07-28T10:00:00Z',
      url: 'https://fathom.video/calls/101',
      participants: [
        { name: 'Harsha', email: 'harsha@agentweb.pro' },
        { name: 'Jane', email: 'jane@baldwingroup.com' },
      ],
      crm_matches: [{ company: 'Baldwin Group' }],
      action_items: [{ text: 'Fix the login bug in the portal API' }],
    },
  },
};

describe('POST /api/webhooks/fathom', () => {
  const savedMode = process.env.FATHOM_LINEAR_ROUTER_MODE;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    _resetFathomLinearPort();
    delete process.env.FATHOM_LINEAR_ROUTER_MODE;
    delete process.env.FATHOM_ONBOARDING_AUTOMATION_ENABLED;
    delete process.env.FATHOM_ONBOARDING_REVIEW_OWNER_USER_ID;
    delete process.env.FATHOM_ONBOARDING_FATHOM_USER_ID;
  });

  afterAll(() => {
    _resetFathomLinearPort();
    if (savedMode === undefined) delete process.env.FATHOM_LINEAR_ROUTER_MODE;
    else process.env.FATHOM_LINEAR_ROUTER_MODE = savedMode;
  });

  // ---- payload validation (behavior preserved from the previous handler) ----

  it('returns 400 for a missing event field', async () => {
    const res = await request(app).post('/api/webhooks/fathom').send({ data: {} }).expect(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when meeting data is missing', async () => {
    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send({ event: 'recording.ready', data: {} })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  it('ignores non-recording.ready events', async () => {
    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send({ event: 'meeting.started', data: {} })
      .expect(200);
    expect(res.body.message).toContain('ignored');
  });

  // ---- mode gate ----

  it('reports the router disabled when FATHOM_LINEAR_ROUTER_MODE=off', async () => {
    process.env.FATHOM_LINEAR_ROUTER_MODE = 'off';
    registerFathomLinearPort(mockPort());
    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);
    expect(res.body.routed).toBe(false);
    expect(res.body.reason).toMatch(/disabled/i);
  });

  it('fails loudly (500) on an invalid FATHOM_LINEAR_ROUTER_MODE value', async () => {
    process.env.FATHOM_LINEAR_ROUTER_MODE = 'bananas';
    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(500);
    expect(res.body.error).toMatch(/FATHOM_LINEAR_ROUTER_MODE/);
  });

  it('reports the router inactive when no LinearPort is registered (ENG-536 pending)', async () => {
    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);
    expect(res.body.routed).toBe(false);
    expect(res.body.reason).toMatch(/ENG-536/);
    expect(res.body.itemsExtracted).toBe(1);
  });

  // ---- shadow mode (the default): decisions computed, nothing written ----

  it('defaults to shadow mode: proposes a create without calling any write method', async () => {
    const port = mockPort();
    registerFathomLinearPort(port);

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);

    expect(res.body.routed).toBe(true);
    expect(res.body.mode).toBe('shadow');
    expect(res.body.report.created).toHaveLength(1);
    expect(res.body.report.created[0].proposed).toBe(true);
    // Reads ran (dedupe is real even in shadow)…
    expect(port.findByFathomKey).toHaveBeenCalled();
    expect(port.searchIssues).toHaveBeenCalledWith(
      expect.objectContaining({ teams: ['ENG', 'GROW', 'CS', 'OPS'] })
    );
    // …but no write ever fires in shadow mode.
    expect(port.createIssue).not.toHaveBeenCalled();
    expect(port.addComment).not.toHaveBeenCalled();
    expect(port.relateIssues).not.toHaveBeenCalled();
  });

  it('proposes enrichment of the cross-board canonical instead of creating a duplicate', async () => {
    const canonical: LinearCandidateIssue = {
      id: 'uuid-grow-6',
      identifier: 'GROW-6',
      team: 'GROW',
      title: 'Baldwin Group — onboard email trial + portal API rollout',
      description: 'Canonical Baldwin Group workflow issue',
      url: 'https://linear.app/x/GROW-6',
    };
    const port = mockPort({ searchIssues: jest.fn().mockResolvedValue([canonical]) });
    registerFathomLinearPort(port);

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);

    expect(res.body.report.enriched).toHaveLength(1);
    expect(res.body.report.enriched[0].identifier).toBe('GROW-6');
    expect(res.body.report.created).toHaveLength(0);
    expect(port.addComment).not.toHaveBeenCalled(); // shadow: proposed only
  });

  it('reports an idempotent no-op when the item was already processed', async () => {
    const existing: LinearCandidateIssue = {
      id: 'uuid-prev',
      identifier: 'CS-12',
      team: 'CS',
      title: 'Fix the login bug in the portal API',
      description: 'contains the fathom key marker',
      url: 'https://linear.app/x/CS-12',
    };
    const port = mockPort({ findByFathomKey: jest.fn().mockResolvedValue(existing) });
    registerFathomLinearPort(port);

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);

    expect(res.body.report.duplicatesAvoided).toHaveLength(1);
    expect(res.body.report.duplicatesAvoided[0].identifier).toBe('CS-12');
    expect(res.body.report.created).toHaveLength(0);
  });

  // ---- live mode ----

  it('performs real writes only in live mode', async () => {
    process.env.FATHOM_LINEAR_ROUTER_MODE = 'live';
    const port = mockPort();
    registerFathomLinearPort(port);

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);

    expect(res.body.mode).toBe('live');
    expect(res.body.report.created).toHaveLength(1);
    expect(res.body.report.created[0].identifier).toBe('ENG-999');
    expect(port.createIssue).toHaveBeenCalledTimes(1);
  });

  // ---- resilience ----

  it('handles meetings with no action items gracefully', async () => {
    registerFathomLinearPort(mockPort());
    const payload = {
      event: 'recording.ready',
      data: {
        recording_id: 102,
        meeting: { id: 2, title: 'Quick Sync', created_at: '2026-07-28T11:00:00Z', participants: [], action_items: [] },
      },
    };
    const res = await request(app).post('/api/webhooks/fathom').send(payload).expect(200);
    expect(res.body.routed).toBe(true);
    expect(res.body.report.itemsScanned).toBe(0);
  });

  it('surfaces per-item port failures in the report errors, not as filed work', async () => {
    const port = mockPort({ searchIssues: jest.fn().mockRejectedValue(new Error('Linear 500')) });
    registerFathomLinearPort(port);

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);

    expect(res.body.report.errors).toHaveLength(1);
    expect(res.body.report.errors[0].reason).toContain('Linear 500');
    expect(res.body.report.created).toHaveLength(0);
  });

  it('returns 500 when the routing pipeline itself fails', async () => {
    registerFathomLinearPort(mockPort());
    jest.spyOn(routerModule, 'routeMeetingToLinear').mockRejectedValueOnce(new Error('pipeline exploded'));

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(500);
    expect(res.body.error).toContain('pipeline exploded');
  });

  // ---- onboarding automation leg (ENG-246 — behavior preserved) ----

  it('reports onboarding automation disabled by default and never calls it', async () => {
    registerFathomLinearPort(mockPort());
    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);
    expect(res.body.onboardingAutomation).toEqual({ status: 'disabled' });
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it('runs Fathom onboarding automation only when explicitly enabled and configured', async () => {
    process.env.FATHOM_ONBOARDING_AUTOMATION_ENABLED = 'true';
    process.env.FATHOM_ONBOARDING_REVIEW_OWNER_USER_ID = 'harsha-user';
    process.env.FATHOM_ONBOARDING_FATHOM_USER_ID = 'harsha-fathom-user';
    registerFathomLinearPort(mockPort());
    mockedIngest.mockResolvedValue({
      recordingId: '101',
      automationState: 'draft_account_created',
    } as any);

    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send({
        ...validPayload,
        data: { ...validPayload.data, recording_url: 'https://fathom.video/calls/101' },
      })
      .expect(200);

    expect(res.body.onboardingAutomation).toEqual({
      status: 'processed',
      recordingId: '101',
      automationState: 'draft_account_created',
    });
    expect(mockedIngest).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: 101,
      recordingUrl: 'https://fathom.video/calls/101',
      fathomUserId: 'harsha-fathom-user',
      reviewOwnerUserId: 'harsha-user',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      reviewed: false,
    }));
  });

  it('skips onboarding automation when enabled but missing config', async () => {
    process.env.FATHOM_ONBOARDING_AUTOMATION_ENABLED = 'true';
    registerFathomLinearPort(mockPort());

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);

    expect(res.body.onboardingAutomation).toEqual({ status: 'skipped_missing_config_or_recording' });
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it('does not fail the webhook when onboarding automation cannot run', async () => {
    process.env.FATHOM_ONBOARDING_AUTOMATION_ENABLED = 'true';
    process.env.FATHOM_ONBOARDING_REVIEW_OWNER_USER_ID = 'harsha-user';
    registerFathomLinearPort(mockPort());
    mockedIngest.mockRejectedValue(new Error('LLM extraction unavailable'));

    const res = await request(app).post('/api/webhooks/fathom').send(validPayload).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.onboardingAutomation).toEqual({ status: 'failed' });
  });
});
