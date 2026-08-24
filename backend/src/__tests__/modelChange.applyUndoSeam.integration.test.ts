/**
 * ENG-1215 — the apply → audit → undo seam, executed rather than mocked.
 *
 * The unit tests for this feature mock `scheduleDb` and `llmModelChangeAuditDb`
 * and assert the arguments passed to them. Two real bugs lived underneath that
 * and survived a full green suite:
 *
 *  - `undoneAt: null` was written as a present attribute, so
 *    `attribute_not_exists(undoneAt)` was false from the moment the row was
 *    created and every undo would have been rejected as already-undone.
 *  - Restoring inheritance passed `{ llmModel: undefined }`, which emitted
 *    `SET #llmModel = :llmModel` with a value the marshaller drops — a
 *    ValidationException, not a removal. That is the majority path: 66 of 91
 *    active production schedules store no model at all. It failed AFTER the audit
 *    row was stamped undone, leaving the trail asserting a revert that never
 *    happened.
 *
 * Here the service, both query builders and the audit store are REAL; only the
 * DocumentClient is swapped for an in-memory one that executes expressions and
 * rejects any that reference an unsupplied value. Both bugs fail this file.
 */

import { InMemoryDynamo } from './helpers/inMemoryDynamo';

const SCHEDULES_TABLE = 'AW-TaskSchedules';
const AUDIT_TABLE = 'AW-ModelChangeAudit';

const db = new InMemoryDynamo({
  [SCHEDULES_TABLE]: { hash: 'scheduleId' },
  [AUDIT_TABLE]: { hash: 'billingUserId', range: 'sk' },
});

jest.mock('aws-sdk', () => {
  const { InMemoryDynamo: Harness } = jest.requireActual('./helpers/inMemoryDynamo');
  void Harness;
  return {
    DynamoDB: {
      // Bound lazily so the shared instance above is the one used.
      get DocumentClient() {
        return (global as any).__inMemoryDocumentClient;
      },
      Converter: { input: (v: unknown) => v, marshall: (v: unknown) => v },
    },
    S3: class {
      upload() {
        return { promise: async () => ({}) };
      }
    },
    SecretsManager: class {
      getSecretValue() {
        return { promise: async () => ({}) };
      }
    },
    config: { update: jest.fn() },
  };
});

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

import { applyModelChange, undoModelChange } from '../services/llmModelChangeService';

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
const auditRows = () => db.items(AUDIT_TABLE);

beforeEach(() => {
  db.tables.get(AUDIT_TABLE)!.clear();
});

describe('apply → audit → undo, against a real query builder', () => {
  it('pins a model, writes one audit row, and undo restores the previous pin', async () => {
    seedSchedule(OPUS);

    const applied = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
      estimatedDaysRecovered: 6,
      confidence: 'high',
    });

    expect(applied.applied).toBe(true);
    expect(schedule().llmModel).toBe(SONNET);
    expect(auditRows()).toHaveLength(1);

    // The handle handed back must be the one undo can find. The sort key leads
    // with the timestamp so the day-range query reaches it without an index.
    const undone = await undoModelChange(OWNER, applied.changeId!);
    expect(undone.undone).toBe(true);
    expect(schedule().llmModel).toBe(OPUS);
  });

  it('restores INHERITANCE by removing the attribute entirely', async () => {
    // The majority case, and the one that was broken. Absent must come back
    // absent: an absent `llmModel` follows the platform default as it moves,
    // where any stored value — including the default's current name — does not.
    seedSchedule(undefined);

    const applied = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(applied.pinnedFromInherited).toBe(true);
    expect(applied.modelBefore).toBeNull();
    expect(schedule().llmModel).toBe(SONNET);

    await undoModelChange(OWNER, applied.changeId!);

    expect(schedule()).not.toHaveProperty('llmModel');
    expect(schedule().userId).toBe(OWNER);
  });

  it('records the change as not-yet-undone, so the first undo is permitted', async () => {
    // `undoneAt: null` would be a PRESENT attribute and would have blocked every
    // undo at the condition check. The absence is the state.
    seedSchedule(OPUS);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(auditRows()[0]).not.toHaveProperty('undoneAt');

    await undoModelChange(OWNER, applied.changeId!);
    expect(auditRows()[0].undoneAt).toEqual(expect.any(String));
    expect(auditRows()[0].undoneByUserId).toBe(OWNER);
  });

  it('refuses a second undo and leaves the restored model alone', async () => {
    seedSchedule(OPUS);
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });
    await undoModelChange(OWNER, applied.changeId!);

    // The customer may have chosen something newer since; a second restore would
    // overwrite that with a stale value.
    db.seed(SCHEDULES_TABLE, { ...schedule(), llmModel: 'a-newer-choice' });

    const second = await undoModelChange(OWNER, applied.changeId!);
    expect(second.undone).toBe(false);
    expect(schedule().llmModel).toBe('a-newer-choice');
  });

  it('never writes two audit rows for a repeated confirmation', async () => {
    seedSchedule(OPUS);
    await applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET });
    const again = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(again.applied).toBe(false);
    expect(again.changeId).toBeNull();
    expect(auditRows()).toHaveLength(1);
  });

  it('keeps an unowned schedule invisible rather than reporting it forbidden', async () => {
    seedSchedule(OPUS);
    await expect(
      applyModelChange('someone-else', { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
    ).rejects.toThrow(/not found/i);
    expect(schedule().llmModel).toBe(OPUS);
    expect(auditRows()).toHaveLength(0);
  });

  it('refuses a model outside the recommendation catalog', async () => {
    seedSchedule(OPUS);
    await expect(
      applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: 'some-cheap-model' }),
    ).rejects.toThrow(/not available/i);
    expect(schedule().llmModel).toBe(OPUS);
    expect(auditRows()).toHaveLength(0);
  });

  it('finds the change even when several were made the same day', async () => {
    // The day-range query must select the right row, not merely some row.
    seedSchedule(OPUS);
    const first = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });
    await undoModelChange(OWNER, first.changeId!);
    const second = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(auditRows()).toHaveLength(2);
    await undoModelChange(OWNER, second.changeId!);

    const rows = auditRows().sort((a, b) => a.sk.localeCompare(b.sk));
    expect(rows.every((row) => typeof row.undoneAt === 'string')).toBe(true);
    expect(schedule().llmModel).toBe(OPUS);
  });

  it('stores no prompt or message content on the audit row', async () => {
    // AC9 is explicit: a model change is a billing decision, and its audit trail
    // has no business holding what the customer wrote.
    seedSchedule(OPUS);
    await applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET });

    const row = auditRows()[0];
    for (const key of ['prompt', 'messages', 'content', 'response', 'completion']) {
      expect(row).not.toHaveProperty(key);
    }
    expect(row.scopeLabel).toBe('Lead list enrichment');
  });
});
