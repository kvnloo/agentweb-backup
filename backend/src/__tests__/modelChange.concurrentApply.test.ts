/**
 * ENG-1217 — two confirms for one switch must not write two audit rows.
 *
 * `applyModelChange` documents itself as idempotent: "A double-click must not
 * write two audit rows claiming two switches." It was not. The guard reads
 * `schedule.llmModel`, compares, and then writes — three separate awaits with
 * nothing binding them together. Two requests that arrive before either write
 * lands both observe the OLD model, both pass the guard, and both call
 * `recordModelChange` with their own `randomUUID()`.
 *
 * Found in live testing by firing two concurrent POSTs at the same scopeId.
 *
 * The schedule itself survives — both writes set the same value — so this is not
 * a data-corruption bug. It is an AUDIT-INTEGRITY bug, which is worse for this
 * feature specifically: the audit trail is the entire reason a customer is asked
 * to confirm rather than being switched silently. The customer's Undo can only
 * stamp the one change id the UI is holding, so the duplicate row stays
 * "un-undone" forever, and the trail says a switch is still in effect after the
 * customer reverted it.
 *
 * The fix binds the write to the state it was decided from, using the `expect`
 * mechanism `updateSchedule` already has (ENG-827). Read-then-write becomes one
 * conditional operation, so the second writer loses at DynamoDB rather than in a
 * comparison it already passed.
 *
 * A lost condition is deliberately NOT assumed to mean "double-click". It means
 * the schedule moved, and the two reasons it could have moved need opposite
 * answers: another confirm of the SAME model is the idempotent case and reports
 * no-op, while an edit to a DIFFERENT model is a real conflict that must not be
 * silently overwritten with a stale choice.
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
  ModelChangeConflictError,
} from '../services/llmModelChangeService';

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

describe('concurrent confirmation of the same switch', () => {
  it('writes ONE audit row when two confirms race', async () => {
    seedSchedule(OPUS);

    const [first, second] = await Promise.all([
      applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
      applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
    ]);

    expect(auditRows()).toHaveLength(1);
    expect(schedule().llmModel).toBe(SONNET);

    // Exactly one caller owns the change; the other reports an honest no-op.
    const applied = [first, second].filter((r) => r.applied);
    expect(applied).toHaveLength(1);
    expect(applied[0].changeId).toEqual(expect.any(String));

    const noop = [first, second].find((r) => !r.applied)!;
    expect(noop.changeId).toBeNull();
  });

  it('writes ONE audit row when the racing schedule was INHERITING', async () => {
    // The majority case. `expect` has to express "the attribute is still absent",
    // which is a different condition from "still equals X" — and getting it wrong
    // here would either block every legitimate first pin or let the race back in.
    seedSchedule(undefined);

    const results = await Promise.all([
      applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
      applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
    ]);

    expect(auditRows()).toHaveLength(1);
    expect(schedule().llmModel).toBe(SONNET);
    expect(results.filter((r) => r.applied)).toHaveLength(1);

    // The surviving row must still say the switch came FROM inheritance, or undo
    // would restore a pin the schedule never had.
    expect(auditRows()[0].modelBefore).toBeNull();
  });

  it('three concurrent confirms still produce one row', async () => {
    seedSchedule(OPUS);

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
      ),
    );

    expect(auditRows()).toHaveLength(1);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
  });

  it('a concurrent switch to a DIFFERENT model is a conflict, not a silent overwrite', async () => {
    // Two different intentions, not a double-click. Whichever loses must not have
    // its stale choice written over the winner's — the customer would end up on a
    // model nobody selected last, with an audit row insisting otherwise.
    seedSchedule(OPUS);

    const results = await Promise.allSettled([
      applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: SONNET }),
      applyModelChange(OWNER, { scope: 'schedule', scopeId: 'sched-a', toModel: HAIKU }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ModelChangeConflictError);

    // One row, and it agrees with the schedule.
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].modelAfter).toBe(schedule().llmModel);
  });

  it('a sequential repeat is still the plain idempotent no-op it always was', async () => {
    // The pre-existing short-circuit must survive the change: when the schedule
    // already reads as the target there is no write to make conditional.
    seedSchedule(OPUS);
    const first = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });
    const again = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(first.applied).toBe(true);
    expect(again.applied).toBe(false);
    expect(again.changeId).toBeNull();
    expect(auditRows()).toHaveLength(1);
  });

  it('an ordinary single confirm is unaffected', async () => {
    seedSchedule(OPUS);

    const result = await applyModelChange(OWNER, {
      scope: 'schedule',
      scopeId: 'sched-a',
      toModel: SONNET,
    });

    expect(result.applied).toBe(true);
    expect(result.modelBefore).toBe(OPUS);
    expect(schedule().llmModel).toBe(SONNET);
    expect(auditRows()).toHaveLength(1);
  });
});
