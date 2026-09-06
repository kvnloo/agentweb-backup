/**
 * ENG-1071 — Emma cannot diagnose scheduled-chat storage pressure or explain
 * item-size update failures.
 *
 * `getScheduleStorageDiagnostics` is the read-only counterpart to ENG-1048's
 * write-path budgeting: given a schedule item, report byte usage per bounded
 * field (current prompt / prompt revisions / run results) against the working
 * budget, identify the dominant consumer, and recommend the one corrective
 * action a customer can take — WITHOUT ever exposing the field's actual
 * content, and WITHOUT writing anything.
 *
 * Fixture shape mirrors the real reproduction on this issue: schedule
 * 98b99693-c68c-4d49-82b2-c35500dffed1, ~425KB total, prompt revisions ~332KB,
 * run results ~57KB, current prompt ~35KB.
 */

import {
  DYNAMO_MAX_ITEM_BYTES,
  SCHEDULE_ITEM_BUDGET_BYTES,
  getScheduleStorageDiagnostics,
} from '../utils/dynamoItemBudget';

// Mirrors the reported row: 10 revisions of ~33k chars each, ~35k current
// prompt, and a single large run result — the exact shape from the AGW-241 /
// ENG-1048 reproduction fixture already on this issue.
const bigRevisions = (count = 10) => Array.from({ length: count }, (_, i) => ({
  startingMessage: 'p'.repeat(33000),
  updatedAt: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
}));

const SECRET_MARKER = 'sk-live-super-secret-do-not-leak-1071';

const nearLimitSchedule = (overrides: Record<string, any> = {}) => ({
  scheduleId: '98b99693-c68c-4d49-82b2-c35500dffed1',
  userId: 'owner-1',
  scheduleName: 'S',
  startingMessage: 'p'.repeat(35000),
  frequency: 'daily',
  promptRevisions: bigRevisions(),
  runResults: [{ summary: `${SECRET_MARKER} ${'r'.repeat(57000)}` }],
  ...overrides,
});

const smallSchedule = (overrides: Record<string, any> = {}) => ({
  scheduleId: 'sched-small',
  userId: 'owner-1',
  scheduleName: 'S',
  startingMessage: 'Send me a daily summary.',
  frequency: 'daily',
  promptRevisions: [],
  runResults: [],
  ...overrides,
});

describe('getScheduleStorageDiagnostics', () => {
  // ─── FAIL-shaped: boundary / invalid-input coverage ──────────────────────

  it('handles a schedule with no history fields (undefined, not zero-length arrays)', () => {
    const diagnostics = getScheduleStorageDiagnostics({ scheduleId: 's', userId: 'u' });
    expect(diagnostics.fields.currentPrompt).toBe(0);
    expect(diagnostics.fields.promptRevisions).toBe(0);
    expect(diagnostics.fields.runResults).toBe(0);
    expect(diagnostics.approachingLimit).toBe(false);
    expect(diagnostics.correctiveAction).toBeNull();
  });

  it('handles null/undefined input without throwing', () => {
    expect(() => getScheduleStorageDiagnostics(null)).not.toThrow();
    expect(() => getScheduleStorageDiagnostics(undefined)).not.toThrow();
    expect(getScheduleStorageDiagnostics(null).totalBytes).toBe(0);
  });

  it('never includes any field content in the output — only byte counts', () => {
    const diagnostics = getScheduleStorageDiagnostics(nearLimitSchedule());
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain('p'.repeat(100)); // no raw prompt text
    expect(serialized).not.toContain('r'.repeat(100)); // no raw run-result text
    // Every value under `fields` must be a plain number, never a string/object.
    for (const value of Object.values(diagnostics.fields)) {
      expect(typeof value).toBe('number');
    }
  });

  it('names no table, key, or AWS internals in the corrective action text', () => {
    const { correctiveAction } = getScheduleStorageDiagnostics(nearLimitSchedule());
    expect(correctiveAction).not.toBeNull();
    expect(correctiveAction).not.toMatch(/AW-TaskSchedules/i);
    expect(correctiveAction).not.toMatch(/ValidationException/i);
    expect(correctiveAction).not.toMatch(/dynamodb\.amazonaws/i);
    expect(correctiveAction).not.toMatch(/arn:aws/i);
  });

  // ─── SUCCESS-shaped: the documented behavioral contract ──────────────────

  it('reports byte usage per bounded field and the total against the 400KB limit', () => {
    const diagnostics = getScheduleStorageDiagnostics(nearLimitSchedule());
    expect(diagnostics.limitBytes).toBe(DYNAMO_MAX_ITEM_BYTES);
    expect(diagnostics.budgetBytes).toBe(SCHEDULE_ITEM_BUDGET_BYTES);
    // Matches the issue's read-only breakdown to within the estimator's own
    // rounding: ~425KB total; revisions ~332KB; run results ~57KB; prompt ~35KB.
    expect(diagnostics.totalBytes).toBeGreaterThan(400 * 1024);
    expect(diagnostics.totalBytes).toBeLessThan(450 * 1024);
    expect(diagnostics.fields.promptRevisions).toBeGreaterThan(320 * 1024);
    expect(diagnostics.fields.promptRevisions).toBeLessThan(345 * 1024);
    expect(diagnostics.fields.runResults).toBeGreaterThan(55 * 1024);
    expect(diagnostics.fields.runResults).toBeLessThan(60 * 1024);
    expect(diagnostics.fields.currentPrompt).toBeGreaterThan(33 * 1024);
    expect(diagnostics.fields.currentPrompt).toBeLessThan(37 * 1024);
    // The four bounded contributions should reconstruct the total closely.
    const sum = diagnostics.fields.currentPrompt + diagnostics.fields.promptRevisions
      + diagnostics.fields.runResults + diagnostics.fields.other;
    expect(sum).toBe(diagnostics.totalBytes);
  });

  it('identifies prompt revisions as the dominant consumer on the reported fixture shape', () => {
    const diagnostics = getScheduleStorageDiagnostics(nearLimitSchedule());
    expect(diagnostics.dominantField).toBe('promptRevisions');
  });

  it('flags a schedule over the storage budget as approaching the limit, with a corrective action', () => {
    const diagnostics = getScheduleStorageDiagnostics(nearLimitSchedule());
    expect(diagnostics.approachingLimit).toBe(true);
    expect(typeof diagnostics.correctiveAction).toBe('string');
    expect(diagnostics.correctiveAction!.length).toBeGreaterThan(0);
  });

  it('does NOT flag a schedule comfortably under the budget, and returns no corrective action', () => {
    const diagnostics = getScheduleStorageDiagnostics(smallSchedule());
    expect(diagnostics.totalBytes).toBeLessThan(SCHEDULE_ITEM_BUDGET_BYTES / 10);
    expect(diagnostics.approachingLimit).toBe(false);
    expect(diagnostics.correctiveAction).toBeNull();
  });

  it('flags run results as dominant when revisions are absent but run history is large', () => {
    const schedule = smallSchedule({
      runResults: Array.from({ length: 14 }, (_, i) => ({ runId: `run-${i}`, summary: 'r'.repeat(30000) })),
    });
    const diagnostics = getScheduleStorageDiagnostics(schedule);
    expect(diagnostics.dominantField).toBe('runResults');
    expect(diagnostics.approachingLimit).toBe(true);
  });

  it('never mutates the input schedule (read-only — no write path added)', () => {
    const schedule = nearLimitSchedule();
    const before = JSON.parse(JSON.stringify(schedule));
    getScheduleStorageDiagnostics(schedule);
    expect(schedule).toEqual(before);
  });

  it('respects a custom budget threshold for approachingLimit', () => {
    const schedule = smallSchedule({ startingMessage: 'x'.repeat(1000) });
    const tight = getScheduleStorageDiagnostics(schedule, 500);
    const loose = getScheduleStorageDiagnostics(schedule, 1024 * 1024);
    expect(tight.approachingLimit).toBe(true);
    expect(loose.approachingLimit).toBe(false);
  });
});
