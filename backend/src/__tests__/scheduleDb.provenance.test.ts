/**
 * ENG-2816 (step 3): how the db layer stores and reads a schedule's `provenance`, the ONE new optional attribute (a DynamoDB String
 * Set) on `AW-TaskSchedules` items.
 *
 * Runs the real `scheduleDb` against an in-memory DocumentClient that APPLIES expressions with real String Set semantics (ADD
 * unions, DELETE removes and drops an emptied set, ADD and DELETE on one path are rejected), because the property that matters
 * is what the write does to the item: the content and its mark land in the SAME write or not at all. A recording mock cannot see
 * that, and cannot see a Set leaking out of a read as an opaque wrapper object.
 */
import { InMemoryDynamo } from './helpers/inMemoryDynamo';

const TABLE = 'AW-TaskSchedules';
const db = new InMemoryDynamo({ [TABLE]: { hash: 'scheduleId', indexes: { UserIdIndex: { hash: 'userId' } } } });

const sent: { get: any[]; update: any[]; put: any[] } = { get: [], update: [], put: [] };
const Base = db.documentClient;
class RecordingClient extends (Base as any) {
  get(p: any) { sent.get.push(p); return super.get(p); }
  update(p: any) { sent.update.push(p); return super.update(p); }
  put(p: any) { sent.put.push(p); return super.put(p); }
}

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    get DocumentClient() { return (global as any).__scheduleRecordingClient; },
    Converter: { input: (v: unknown) => v, marshall: (v: unknown) => v },
  },
  S3: class { upload() { return { promise: async () => ({}) }; } },
  SecretsManager: class { getSecretValue() { return { promise: async () => ({}) }; } },
  config: { update: jest.fn() },
}));
(global as any).__scheduleRecordingClient = RecordingClient;

import { scheduleDb, readScheduleProvenance } from '../services/db';

const base = (over: Record<string, unknown> = {}) => ({
  scheduleId: 'sch-1', taskId: 'global', userId: 'owner', frequency: 'daily', nextRunTime: '2026-11-18T09:00:00.000Z',
  status: 'active', createdAt: '2026-11-17T00:00:00.000Z', type: 'scheduled_chat', startingMessage: 'owner wrote this', ...over,
});
const stored = (id = 'sch-1') => db.items(TABLE).find((i) => i.scheduleId === id);
const isSet = (v: any) => v && typeof v === 'object' && v.wrapperName === 'Set' && Array.isArray(v.values);

beforeEach(() => {
  for (const key of Object.keys(sent) as Array<keyof typeof sent>) sent[key].length = 0;
  db.tables.get(TABLE)!.clear();
});

describe('scheduleDb.createSchedule and provenance', () => {
  it('writes provenance as a real String Set, and the read hands back a sorted ARRAY, never the Set wrapper', async () => {
    await scheduleDb.createSchedule(base({ provenance: ['startingMessage', 'keywords'] }) as any);
    expect(isSet(stored()!.provenance)).toBe(true);
    expect(stored()!.provenance.values.sort()).toEqual(['keywords', 'startingMessage']);

    const read = await scheduleDb.getScheduleById('sch-1');
    expect(Array.isArray(read!.provenance)).toBe(true);
    expect(read!.provenance).toEqual(['keywords', 'startingMessage']);
  });

  it('omits the attribute when the list is empty or absent (a Set cannot be empty; an unmarked schedule carries nothing)', async () => {
    await scheduleDb.createSchedule(base({ provenance: [] }) as any);
    await scheduleDb.createSchedule(base({ scheduleId: 'sch-2' }) as any);
    expect(stored('sch-1')).not.toHaveProperty('provenance');
    expect(stored('sch-2')).not.toHaveProperty('provenance');
  });

  it('puts a schedule that never carried the key exactly as before (the same item object)', async () => {
    const schedule = base();
    await scheduleDb.createSchedule(schedule as any);
    expect(sent.put[0].Item).toBe(schedule);
  });

  it('does not write the caller\'s array as a List (that would break the next ADD)', async () => {
    await scheduleDb.createSchedule(base({ provenance: ['keywords'] }) as any);
    expect(Array.isArray(sent.put[0].Item.provenance)).toBe(false);
  });
});

describe('scheduleDb.updateSchedule and provenance', () => {
  beforeEach(async () => {
    await scheduleDb.createSchedule(base() as any);
    sent.update.length = 0;
  });

  it('ADDs the mark in the SAME UpdateExpression and the SAME call as the content, so they land together', async () => {
    await scheduleDb.updateSchedule('sch-1', { startingMessage: 'visitor wrote this', provenanceAdd: ['startingMessage'] });

    expect(sent.update).toHaveLength(1);
    expect(sent.update[0].UpdateExpression).toBe('SET #startingMessage = :startingMessage ADD #provenance :provenanceAdd');
    expect(sent.update[0].ExpressionAttributeNames['#provenance']).toBe('provenance');
    expect(isSet(sent.update[0].ExpressionAttributeValues[':provenanceAdd'])).toBe(true);
    expect(stored()!.startingMessage).toBe('visitor wrote this');
    expect(stored()!.provenance.values).toEqual(['startingMessage']);
  });

  it('never stores provenanceAdd as an attribute', async () => {
    await scheduleDb.updateSchedule('sch-1', { keywords: ['a'], provenanceAdd: ['keywords'] });
    expect(stored()).not.toHaveProperty('provenanceAdd');
    expect(sent.update[0].UpdateExpression).not.toContain('#provenanceAdd');
  });

  it('a later ADD unions with what is there, and adding a member already present changes nothing', async () => {
    await scheduleDb.updateSchedule('sch-1', { keywords: ['a'], provenanceAdd: ['keywords'] });
    await scheduleDb.updateSchedule('sch-1', { startingMessage: 'x', provenanceAdd: ['startingMessage', 'keywords'] });
    expect(stored()!.provenance.values.sort()).toEqual(['keywords', 'startingMessage']);
  });

  it('takes the whole attribute off through removeAttributes (the adopt route), in one write with an `expect` on the version', async () => {
    await scheduleDb.updateSchedule('sch-1', { provenanceAdd: ['keywords', 'startingMessage'] });
    sent.update.length = 0;

    await scheduleDb.updateSchedule('sch-1', { updatedAt: '2026-11-18T00:00:00.000Z' }, { updatedAt: stored()!.updatedAt }, undefined, ['provenance']);

    expect(sent.update).toHaveLength(1);
    expect(sent.update[0].UpdateExpression).toBe('SET #updatedAt = :updatedAt REMOVE #provenance');
    expect(stored()).not.toHaveProperty('provenance');
    expect(stored()!.updatedAt).toBe('2026-11-18T00:00:00.000Z');
  });

  it('removes a provenance value that is NOT a well-formed set too (a set operation could not)', async () => {
    for (const garbage of [17, 'startingMessage', ['startingMessage'], { oops: true }]) {
      db.tables.get(TABLE)!.set('sch-1', { ...stored()!, provenance: garbage });
      await scheduleDb.updateSchedule('sch-1', { updatedAt: 'x' }, undefined, undefined, ['provenance']);
      expect(stored()).not.toHaveProperty('provenance');
    }
  });

  it('a stale `expect` leaves the marks in place (the owner adopts what they saw, or nothing)', async () => {
    await scheduleDb.updateSchedule('sch-1', { provenanceAdd: ['keywords'] });
    await expect(
      scheduleDb.updateSchedule('sch-1', { updatedAt: 'new' }, { updatedAt: 'a-version-the-owner-never-saw' }, undefined, ['provenance'])
    ).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect(stored()!.provenance.values).toEqual(['keywords']);
  });

  it('refuses a write that both adds a mark and removes the attribute, sending nothing', async () => {
    await expect(
      scheduleDb.updateSchedule('sch-1', { provenanceAdd: ['keywords'] }, undefined, undefined, ['provenance'])
    ).rejects.toThrow(/cannot be added to and removed/);
    expect(sent.update).toHaveLength(0);
  });

  it('refuses a direct SET of provenance (it would store a List and break the next ADD)', async () => {
    await expect(scheduleDb.updateSchedule('sch-1', { provenance: ['keywords'] } as any)).rejects.toThrow(/provenanceAdd/);
    expect(sent.update).toHaveLength(0);
  });

  it('a provenance-only write is a real write: it is not dropped as "nothing to do"', async () => {
    const result = await scheduleDb.updateSchedule('sch-1', { provenanceAdd: ['variableValues'] });
    expect(sent.update).toHaveLength(1);
    expect(sent.update[0].UpdateExpression).toBe('ADD #provenance :provenanceAdd');
    expect(stored()!.provenance.values).toEqual(['variableValues']);
    // The returned attributes read as an array too.
    expect(result!.provenance).toEqual(['variableValues']);
  });

  it('writes nothing when there is nothing at all to write (unchanged)', async () => {
    await expect(scheduleDb.updateSchedule('sch-1', {})).resolves.toBeUndefined();
    await expect(scheduleDb.updateSchedule('sch-1', { provenanceAdd: [] })).resolves.toBeUndefined();
    expect(sent.update).toHaveLength(0);
  });

  it('keeps `expect`, removeAttributes and the run-result shed working in the same expression as the mark', async () => {
    db.tables.get(TABLE)!.set('sch-1', { ...stored()!, llmModel: 'm', runResults: [{ runId: 'r1' }, { runId: 'r2' }, { runId: 'r3' }] });
    sent.update.length = 0;

    await scheduleDb.updateSchedule(
      'sch-1',
      { status: 'paused', provenanceAdd: ['keywords'] },
      { status: 'active' },
      { count: 1, expectedLength: 3 },
      ['llmModel']
    );

    const params = sent.update[0];
    expect(params.UpdateExpression).toBe('SET #status = :status REMOVE #llmModel, #runResults[0] ADD #provenance :provenanceAdd');
    expect(params.ConditionExpression).toContain('#expected0 = :expected0');
    expect(stored()).toMatchObject({ status: 'paused', runResults: [{ runId: 'r2' }, { runId: 'r3' }] });
    expect(stored()).not.toHaveProperty('llmModel');
    expect(stored()!.provenance.values).toEqual(['keywords']);
  });

  it('a failed `expect` condition leaves BOTH the content and the mark unwritten (atomic)', async () => {
    await expect(
      scheduleDb.updateSchedule('sch-1', { startingMessage: 'visitor text', provenanceAdd: ['startingMessage'] }, { status: 'paused' })
    ).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect(stored()!.startingMessage).toBe('owner wrote this');
    expect(stored()).not.toHaveProperty('provenance');
  });
});

describe('every schedule read returns provenance as a sorted array (never a Set), and an unmarked item untouched', () => {
  beforeEach(async () => {
    await scheduleDb.createSchedule(base({ provenance: ['startingMessage', 'keywords'] }) as any);
    await scheduleDb.createSchedule(base({ scheduleId: 'sch-2' }) as any);
  });

  it('getSchedulesByUserId', async () => {
    const list = (await scheduleDb.getSchedulesByUserId('owner'))!;
    expect(list.find((s: any) => s.scheduleId === 'sch-1')!.provenance).toEqual(['keywords', 'startingMessage']);
    expect(list.find((s: any) => s.scheduleId === 'sch-2')).not.toHaveProperty('provenance');
  });

  it('getAllSchedules', async () => {
    const list = await scheduleDb.getAllSchedules();
    expect(list.find((s: any) => s.scheduleId === 'sch-1')!.provenance).toEqual(['keywords', 'startingMessage']);
  });

  it('an item with no provenance comes back as the very same object', async () => {
    const raw = stored('sch-2');
    expect(await scheduleDb.getScheduleById('sch-2')).toBe(raw);
  });

  it('a garbage stored value reads as a marked array, not as nothing', async () => {
    db.tables.get(TABLE)!.set('sch-2', { ...stored('sch-2')!, provenance: 17 });
    expect((await scheduleDb.getScheduleById('sch-2'))!.provenance).toEqual(['_unreadable']);
  });

  it('the exported reader is the same tolerant reader', () => {
    expect(readScheduleProvenance(['b', 'a'])).toEqual(['a', 'b']);
    expect(readScheduleProvenance(undefined)).toEqual([]);
  });
});

describe('getScheduleById consistent reads', () => {
  beforeEach(async () => { await scheduleDb.createSchedule(base() as any); sent.get.length = 0; });

  it('asks for ConsistentRead only when told to', async () => {
    await scheduleDb.getScheduleById('sch-1');
    expect(sent.get[0]).not.toHaveProperty('ConsistentRead');
    await scheduleDb.getScheduleById('sch-1', { consistent: true });
    expect(sent.get[1].ConsistentRead).toBe(true);
  });
});
