/**
 * Tests for scheduled-session context injection.
 *
 * Covers two surfaces:
 *   1. getScheduledSessionOverride() — the pure function in agentModeSystemPrompt.ts
 *      that produces the CRITICAL OVERRIDE addendum.
 *   2. getEmmaSystemContext(sessionType) — the Emma sidebar system prompt builder
 *      in chatbotService.ts that threads the override into the full prompt.
 *
 * Goal: verify that scheduled sessions suppress schedule suggestions while
 * regular/undefined sessions preserve the proactive scheduling behaviour.
 */

import { getScheduledSessionOverride } from '../docs/agentModeSystemPrompt';
import { getEmmaSystemContext } from '../services/chatbotService';

// ── Heavy module mocks required to import chatbotService ──────────────────────
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  config: { update: jest.fn() },
}));
jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('getScheduledSessionOverride — pure function', () => {
  // ── Returns empty string (no suppression) for non-scheduled sessions ────────

  it('returns empty string when sessionType is undefined', () => {
    expect(getScheduledSessionOverride(undefined)).toBe('');
  });

  it('returns empty string when sessionType is "regular"', () => {
    expect(getScheduledSessionOverride('regular')).toBe('');
  });

  it('returns empty string for other known non-scheduled types', () => {
    const nonScheduled = [
      'predefined-work-plan',
      'image-generation',
      'video-generation',
      'book-generation',
      'report_generation',
      'result-endpoint',
      'emma-email',
      'meeting-intake',
    ];
    for (const t of nonScheduled) {
      expect(getScheduledSessionOverride(t)).toBe('');
    }
  });

  it('returns empty string for an unknown/arbitrary session type', () => {
    expect(getScheduledSessionOverride('something-random')).toBe('');
  });

  // ── Returns override text only for "scheduled" ───────────────────────────────

  it('returns non-empty string when sessionType is "scheduled"', () => {
    expect(getScheduledSessionOverride('scheduled')).not.toBe('');
  });

  it('contains CRITICAL OVERRIDE marker for scheduled sessions', () => {
    expect(getScheduledSessionOverride('scheduled')).toContain('CRITICAL OVERRIDE');
  });

  it('explicitly forbids suggesting a new schedule in scheduled sessions', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('NEVER suggest creating a schedule');
  });

  it('explicitly forbids "want this to run automatically" phrasing', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('want this to run automatically');
  });

  it('explicitly forbids "setting up automated runs" phrasing', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('setting up automated runs');
  });

  it('tells Emma to just deliver results instead', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('Just deliver the results');
  });

  // ── Non-scheduled prompts ALLOW schedule suggestions ────────────────────────

  it('non-scheduled override does NOT forbid schedule suggestions', () => {
    const override = getScheduledSessionOverride('regular');
    expect(override).not.toContain('NEVER suggest creating a schedule');
    expect(override).not.toContain('CRITICAL OVERRIDE');
  });

  // ── Idempotent ───────────────────────────────────────────────────────────────

  it('returns the same string on repeated calls for "scheduled"', () => {
    expect(getScheduledSessionOverride('scheduled')).toBe(getScheduledSessionOverride('scheduled'));
  });

  it('returns the same empty string on repeated calls for "regular"', () => {
    expect(getScheduledSessionOverride('regular')).toBe('');
    expect(getScheduledSessionOverride('regular')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getEmmaSystemContext — scheduled-session integration', () => {
  // ── Base prompt is always present ────────────────────────────────────────────

  it('always contains the core Emma identity', () => {
    expect(getEmmaSystemContext()).toContain('EMMA');
    expect(getEmmaSystemContext('regular')).toContain('EMMA');
    expect(getEmmaSystemContext('scheduled')).toContain('EMMA');
  });

  it('always contains the sidebar addendum', () => {
    expect(getEmmaSystemContext()).toContain('Sidebar Mode');
    expect(getEmmaSystemContext('regular')).toContain('Sidebar Mode');
    expect(getEmmaSystemContext('scheduled')).toContain('Sidebar Mode');
  });

  // ── Proactive scheduling instruction is present in the base prompt ──────────
  // (ensures regular sessions CAN suggest scheduling)

  it('contains the proactive scheduling instruction for regular sessions', () => {
    const prompt = getEmmaSystemContext('regular');
    expect(prompt).toContain('Proactively Suggest Scheduling');
  });

  it('contains the proactive scheduling instruction for undefined sessions', () => {
    const prompt = getEmmaSystemContext();
    expect(prompt).toContain('Proactively Suggest Scheduling');
  });

  it('contains the schedule suggestion example text for regular sessions', () => {
    // The system prompt includes an example "want this to run automatically" nudge
    // that Emma should use. It should be present in non-scheduled prompts.
    const prompt = getEmmaSystemContext('regular');
    expect(prompt).toContain('schedule this');
  });

  // ── Scheduled sessions suppress schedule suggestions ────────────────────────
  // Use the unique phrase that only appears in the injected override, not in the base prompt.

  it('includes "This IS a scheduled automated session" for scheduled sessions', () => {
    expect(getEmmaSystemContext('scheduled')).toContain('This IS a scheduled automated session');
  });

  it('includes NEVER suggest creating a schedule for scheduled sessions', () => {
    expect(getEmmaSystemContext('scheduled')).toContain('NEVER suggest creating a schedule');
  });

  it('tells Emma to just deliver results in scheduled sessions', () => {
    expect(getEmmaSystemContext('scheduled')).toContain('Just deliver the results');
  });

  // ── Non-scheduled sessions do NOT include the override ──────────────────────

  it('does NOT include "This IS a scheduled automated session" for regular sessions', () => {
    expect(getEmmaSystemContext('regular')).not.toContain('This IS a scheduled automated session');
  });

  it('does NOT include "This IS a scheduled automated session" when sessionType is undefined', () => {
    expect(getEmmaSystemContext()).not.toContain('This IS a scheduled automated session');
  });

  it('does NOT include the override for other non-scheduled types', () => {
    for (const t of ['image-generation', 'report_generation', 'emma-email']) {
      expect(getEmmaSystemContext(t)).not.toContain('This IS a scheduled automated session');
    }
  });

  // ── Override appears at the END (after sidebar addendum) ────────────────────
  // Ensures the override is the final word and not buried mid-prompt

  it('override text appears after the sidebar addendum in scheduled prompts', () => {
    const prompt = getEmmaSystemContext('scheduled');
    const sidebarIdx = prompt.indexOf('Sidebar Mode');
    const overrideIdx = prompt.indexOf('This IS a scheduled automated session');
    expect(sidebarIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(sidebarIdx);
  });
});
