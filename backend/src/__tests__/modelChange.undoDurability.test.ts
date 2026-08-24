/**
 * ENG-1217 — undo must not report success it did not achieve.
 *
 * Raised in review on PR #2407. `undoModelChange` stamped the audit row FIRST and
 * restored the schedule second, with no condition on either.
 *
 * Two defects fall out of that, and they compound:
 *
 *  1. If the restore fails after the stamp lands, the audit says the change was
 *     undone while the schedule still runs `modelAfter`. Worse than a plain
 *     inconsistency: a retry hits `attribute_not_exists(undoneAt)`, gets `false`,
 *     and returns `{undone: false}` — so the schedule can NEVER be repaired
 *     through the UI. The customer is told it is already undone, and it is not.
 *
 *     This is the same failure shape as the ValidationException bug fixed
 *     earlier. That fix removed the CAUSE; the ORDERING was left, so any other
 *     failure — throttling, a condition check, a dropped connection —
 *     reproduces it.
 *
 *  2. The restore was unconditional, so an undo could overwrite a NEWER model the
 *     customer had chosen since. The old comment claimed the audit stamp
 *     prevented this; it only prevents a second undo OF THE SAME CHANGE, not a
 *     change made through the schedule editor or a later apply.
 *
 * The fix inverts the order and conditions the restore on the schedule still
 * carrying the model this change installed. That makes the failure directions
 * safe in BOTH directions, which is the property these tests pin:
 *
 *   - restore succeeds, stamp fails  -> retryable: the retry sees the schedule
 *     already at `modelBefore` and finishes the stamp;
 *   - restore fails                  -> nothing is stamped, so the undo is still
 *     offered and still true.
 */

import { InMemoryDynamo } from './helpers/inMemoryDynamo';

const SCHEDULES_TABLE = 'AW-TaskSchedules';
const AUDIT_TABLE = 'AW-ModelChangeAudit';

const db = new InMemoryDynamo({
  [SCHEDULES_TABLE]: { hash: 'scheduleId' },
  [AUDIT_TABLE]: { hash: 'billingUserId', range: 'sk' },
});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    get DocumentClient() {
      return (global as any).__inMemoryDocumentClient;
    },
    Converter: { input: (v: unknown) => v, marshall: (v: unknown) => v },
  },
  S3: class { upload() { return { promise: async () => ({}) }; } },
  SecretsManager: class { getSecretValue() { return { promise: async () => ({}) }; } },
  config: { update: jest.fn() },
}));

(global as any).__inMemoryDocumentClient = db.documentClient;

const OPUS = 'anthropic.claude-opus-5';
const SONNET = 'anthropic.claude-sonnet-5';
const OWNER = 'member-a';
const BILLING = 'billing-root';

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(async () => ({
    billingUserId: BILLING,
    policy: { optimizedModelIds: [SONNET] },
  })),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getSupportedModels: jest.fn(async () => [OPUS, SONNET]) },
}));

jest.mock('../services/llmUsageTelemetry', () => ({
  recordUsageTelemetry: jest.fn(async () => {}),
  USAGE_TELEMETRY_EVENTS: {
    changeApplied: 'runway_change_applied',
    changeUndone: 'runway_change_undone',
  },
}));

import {
  applyModelChange,
  undoModelChange,
  ModelChangeConflictError,
} from '../services/llmModelChangeService';
import { scheduleDb } from '../services/db';

const seedSchedule = (llmModel?: string) => {
  db.tables.get(SCHEDULES_TABLE)!.clear();
  db.seed(SCHEDULES_TABLE, {
    scheduleId: 'sched-a',
    userId: OWNER,
    scheduleName: 'Lead list enrichment',
    ...(llmModel === undefined ? {} : { llmModel }),
  });
};

const schedule = () => db.items(SCHEDULES_TABLE)[0];
const auditRow = () => db.items(AUDIT_TABLE)[0];

beforeEach(() => {
  db.tables.get(AUDIT_TABLE)!.clear();
});

describe('undo is durable and never claims more than it did', () => {
  it('does not stamp the audit when the schedule restore fails', async () => {
    // The core inversion, and the case the old order got wrong. The failure is
    // injected at the WRITE, not at the ownership read, because the ownership
    // read already happened before the stamp — only a failing restore exposes
    // the ordering. A throttle or a dropped connection looks exactly like this.
    seedSchedule(OPUS);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule', scopeId: 'sched-a', toModel: SONNET,
    });

    const restore = jest
      .spyOn(scheduleDb, 'updateSchedule')
      .mockRejectedValueOnce(
        Object.assign(new Error('ProvisionedThroughputExceededException'), {
          code: 'ProvisionedThroughputExceededException',
        }) as never,
      );

    await expect(undoModelChange(OWNER, applied.changeId!)).rejects.toThrow(/Throughput/i);
    // The stamp must NOT have landed: a row marked undone here can never be
    // undone again, so the schedule would be stuck on SONNET forever.
    expect(auditRow()).not.toHaveProperty('undoneAt');
    expect(schedule().llmModel).toBe(SONNET);

    restore.mockRestore();

    // And the undo is still genuinely available once the fault clears.
    const retried = await undoModelChange(OWNER, applied.changeId!);
    expect(retried.undone).toBe(true);
    expect(schedule().llmModel).toBe(OPUS);
    expect(auditRow().undoneAt).toEqual(expect.any(String));
  });

  it('finishes a half-completed undo instead of refusing it', async () => {
    // Restore landed, stamp did not. The retry must recognise the schedule is
    // ALREADY back and complete the stamp rather than reporting "already undone"
    // and stranding the audit trail permanently out of step.
    seedSchedule(OPUS);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule', scopeId: 'sched-a', toModel: SONNET,
    });

    // Simulate the interrupted attempt: schedule restored, audit untouched.
    db.seed(SCHEDULES_TABLE, { ...schedule(), llmModel: OPUS });
    expect(auditRow()).not.toHaveProperty('undoneAt');

    const result = await undoModelChange(OWNER, applied.changeId!);
    expect(result.undone).toBe(true);
    expect(schedule().llmModel).toBe(OPUS);
    expect(auditRow().undoneAt).toEqual(expect.any(String));
  });

  it('refuses to overwrite a NEWER model the customer chose since', async () => {
    // The second defect. `modelBefore` is stale the moment the customer picks
    // something else, and quietly reinstating it would revert a choice they made
    // deliberately — while the audit trail claimed only an undo had happened.
    seedSchedule(OPUS);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule', scopeId: 'sched-a', toModel: SONNET,
    });

    db.seed(SCHEDULES_TABLE, { ...schedule(), llmModel: 'a-newer-choice' });

    await expect(undoModelChange(OWNER, applied.changeId!)).rejects.toBeInstanceOf(
      ModelChangeConflictError,
    );
    expect(schedule().llmModel).toBe('a-newer-choice');
    expect(auditRow()).not.toHaveProperty('undoneAt');
  });

  it('still restores INHERITANCE, conditionally', async () => {
    // The majority path, and the one whose condition differs: the schedule must
    // still be on the pinned model for the removal to be safe.
    seedSchedule(undefined);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule', scopeId: 'sched-a', toModel: SONNET,
    });
    expect(applied.pinnedFromInherited).toBe(true);

    const result = await undoModelChange(OWNER, applied.changeId!);
    expect(result.undone).toBe(true);
    expect(schedule()).not.toHaveProperty('llmModel');
    expect(auditRow().undoneAt).toEqual(expect.any(String));
  });

  it('refuses to restore inheritance over a newer pin', async () => {
    seedSchedule(undefined);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule', scopeId: 'sched-a', toModel: SONNET,
    });
    db.seed(SCHEDULES_TABLE, { ...schedule(), llmModel: 'a-newer-choice' });

    await expect(undoModelChange(OWNER, applied.changeId!)).rejects.toBeInstanceOf(
      ModelChangeConflictError,
    );
    expect(schedule().llmModel).toBe('a-newer-choice');
  });

  it('a second undo of the same change is still a no-op, not a conflict', async () => {
    // Already-undone and superseded are different answers: this one is benign and
    // must stay a quiet false, not an error the UI has to explain.
    seedSchedule(OPUS);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule', scopeId: 'sched-a', toModel: SONNET,
    });
    await undoModelChange(OWNER, applied.changeId!);

    const second = await undoModelChange(OWNER, applied.changeId!);
    expect(second.undone).toBe(false);
    expect(schedule().llmModel).toBe(OPUS);
  });

  it('the ordinary undo path is unchanged', async () => {
    seedSchedule(OPUS);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule', scopeId: 'sched-a', toModel: SONNET,
    });

    const result = await undoModelChange(OWNER, applied.changeId!);
    expect(result).toEqual({ undone: true, restoredModel: OPUS });
    expect(schedule().llmModel).toBe(OPUS);
    expect(auditRow().undoneByUserId).toBe(OWNER);
  });
});
