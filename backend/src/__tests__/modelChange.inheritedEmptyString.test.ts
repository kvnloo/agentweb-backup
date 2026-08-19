/**
 * ENG-1363 — a schedule that stores `llmModel: ""` could never be switched.
 *
 * "Inheriting the platform default" has TWO representations in production, and
 * only one of them was expressible in the write condition:
 *
 *   - the attribute is absent          →  12 active schedules
 *   - the attribute holds `""`         →  48 active schedules
 *
 * `applyModelChange` normalises both to `null` for the DECISION (`schedule.llmModel
 * || null`) and then builds the CONDITION from that same normalised value, so an
 * empty string asserted `attribute_not_exists(llmModel)` against an attribute that
 * is plainly present. The condition failed, the catch re-read, the model still was
 * not the target, and it threw `ModelChangeConflictError` → HTTP 409.
 *
 * Permanently. Reproduced four consecutive times against production on 2026-08-19,
 * against an error message that tells the customer to "reload and try again" — the
 * one action that can never succeed.
 *
 * The existing suites missed it because they seed inheritance as `seedSchedule(undefined)`,
 * which OMITS the attribute — the 12-schedule case, not the 48-schedule one.
 *
 * The fix teaches the condition to say "still unset", covering both spellings,
 * rather than teaching the caller to guess which spelling a row happens to use.
 * The race guard has to survive it: binding the write to the state it was decided
 * from is the whole point of the condition, so "unset" must still lose to a
 * concurrent pin.
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
}));

(global as any).__inMemoryDocumentClient = db.documentClient;

const OPUS = 'anthropic.claude-opus-5';
const SONNET = 'anthropic.claude-sonnet-5';
const HAIKU = 'anthropic.claude-haiku-4-5';
const OWNER = 'member-a';
const BILLING = 'billing-root';

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(async () => ({
    billingUserId: BILLING,
    policy: { optimizedModelIds: [SONNET, HAIKU] },
  })),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getSupportedModels: jest.fn(async () => [OPUS, SONNET, HAIKU]) },
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

/** `undefined` omits the attribute; `''` stores the empty string. They differ. */
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

describe('a schedule inheriting via an EMPTY STRING (48 of 82 active in production)', () => {
  it('can be switched at all — this is the 409 that never cleared', async () => {
    seedSchedule('');

    const result = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(result.applied).toBe(true);
    expect(schedule().llmModel).toBe(SONNET);
  });

  it('records the switch as coming FROM inheritance, not from ""', async () => {
    // `modelBefore: ''` would make undo restore an empty string rather than remove
    // the attribute — re-creating the very state that caused this bug, one row at
    // a time, every time a customer used the feature.
    seedSchedule('');

    const result = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(result.modelBefore).toBeNull();
    expect(result.pinnedFromInherited).toBe(true);
    expect(auditRows()[0].modelBefore).toBeNull();
  });

  it('undo restores inheritance by REMOVING the attribute, not by writing ""', async () => {
    seedSchedule('');
    const applied = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    const undone = await undoModelChange(OWNER, applied.changeId!);

    expect(undone.undone).toBe(true);
    expect(undone.restoredModel).toBeNull();
    // Absent, not ''. Both mean "inherit", but only one of them is a state the
    // rest of the system agrees on.
    expect('llmModel' in schedule()).toBe(false);
  });

  it('still writes ONE audit row when three confirms race', async () => {
    // The condition is what stops a double-click manufacturing history. Widening
    // it to accept "unset" must not widen it into accepting anything.
    seedSchedule('');

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
      ),
    );

    expect(auditRows()).toHaveLength(1);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(schedule().llmModel).toBe(SONNET);
  });
});

describe('the other two representations still behave exactly as before', () => {
  it('an ABSENT attribute still switches and still records inheritance', async () => {
    seedSchedule(undefined);

    const result = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(result.applied).toBe(true);
    expect(result.modelBefore).toBeNull();
    expect(auditRows()).toHaveLength(1);
  });

  it('a PINNED model still switches and records the model it came from', async () => {
    seedSchedule(OPUS);

    const result = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(result.applied).toBe(true);
    expect(result.modelBefore).toBe(OPUS);
    expect(result.pinnedFromInherited).toBe(false);
  });

  it('a second switch reads the NEW model, so its condition is an equality check', async () => {
    // Sequential, so the interesting condition never arises: by the time the second
    // switch reads, the schedule holds SONNET, and it expects SONNET. Kept because
    // it pins that ordinary chaining still works — but it is NOT the safety
    // property, which the test below covers (CodeRabbit, #2480).
    seedSchedule(OPUS);
    await applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET });

    // Second switch reads SONNET, so its condition expects SONNET — not "unset".
    const again = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: HAIKU,
    });

    expect(again.applied).toBe(true);
    expect(again.modelBefore).toBe(SONNET);
    expect(schedule().llmModel).toBe(HAIKU);
  });

  it('an UNSET decision still loses to a concurrent pin — the guard has not gone slack', async () => {
    // The property the widened condition has to keep, and the one nothing else here
    // exercised: a write decided from "unset" must fail when another writer pinned a
    // model in between. Seeding the pin up front would prove nothing — the read
    // would see HAIKU, `modelBefore` would be HAIKU, and the condition would be an
    // ordinary equality check. The dangerous path is specifically an EXPECT_UNSET
    // condition meeting an attribute that has since acquired a value, so the writer
    // has to be interleaved BETWEEN this caller's read and its write.
    seedSchedule('');

    // `documentClient` is a GETTER that mints a fresh class per access, so the one
    // to patch is the class captured at module load — the same object the aws-sdk
    // mock hands the service.
    const DocumentClient = (global as any).__inMemoryDocumentClient;
    const realGet = DocumentClient.prototype.get;
    let pinned = false;
    DocumentClient.prototype.get = function (params: any) {
      return {
        promise: async () => {
          const result = await realGet.call(this, params).promise();
          if (!pinned) {
            pinned = true; // only the FIRST read; the post-failure re-read must see the pin
            db.seed(SCHEDULES_TABLE, {
              scheduleId: 'sched-a',
              userId: OWNER,
              scheduleName: 'Lead list enrichment',
              llmModel: HAIKU,
            });
          }
          return result;
        },
      };
    };

    try {
      await expect(
        applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
      ).rejects.toBeInstanceOf(ModelChangeConflictError);
    } finally {
      DocumentClient.prototype.get = realGet;
    }

    // The other writer's pin survives untouched, and no audit row claims a switch
    // that never happened.
    expect(schedule().llmModel).toBe(HAIKU);
    expect(auditRows()).toHaveLength(0);
  });
});
