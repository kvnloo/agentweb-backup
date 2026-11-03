/**
 * ENG-673 — every conditional write the Smartlead push run depends on, against REAL DynamoDB semantics.
 *
 * Opt-in: runs only when DYNAMODB_LOCAL_ENDPOINT points at a DynamoDB Local, e.g.
 *   java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8125
 *   DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8125 npx jest src/services/__tests__/smartleadPushRunDb.dynamodbLocal.test.ts
 * (or the amazon/dynamodb-local image). Otherwise the suite is skipped, so a run without a database stays green: that is NOT a
 * regression guard, so run it before merging any change to smartleadPushRunDb.ts.
 *
 * It creates the table from the REAL spec (so DynamoDB validates the key schema and the INCLUDE projections) under a throwaway
 * name, and drives the production repository. Races are made deterministic by firing competing calls together or by moving an
 * injected clock; the loser's condition is evaluated by DynamoDB against the winner's write.
 *
 * Limits: DynamoDB Local is not the service. Its indexes update synchronously (production's are eventually consistent, which is why
 * the resumer re-reads a run strongly before claiming), and it has no throttling.
 */
jest.unmock('aws-sdk');

export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

import AWS from 'aws-sdk';
import { ulid } from 'ulid';
import {
  LEASE_MS,
  MAX_BATCH_ATTEMPTS,
  SMARTLEAD_PUSH_RUNS_TABLE_SPEC,
  SmartleadPushRunDb,
  SmartleadPushRunStoreError,
  redactSecrets,
  type NewPushRun,
} from '../smartleadPushRunDb';

suite('SmartleadPushRunDb against DynamoDB Local (ENG-673)', () => {
  const table = `Test-AW-SmartleadPushRuns-${ulid()}`;
  const config = { endpoint: ENDPOINT, region: 'us-west-2', accessKeyId: 'x', secretAccessKey: 'x' };
  const raw = new AWS.DynamoDB(config);
  const doc = new AWS.DynamoDB.DocumentClient(config);
  let clock = Date.parse('2026-10-27T10:00:00Z');
  const db = new SmartleadPushRunDb(doc, table, () => clock, async () => {});

  const input = (over: Partial<NewPushRun> = {}): NewPushRun => ({
    ownerId: 'user-1', pushedBy: 'user-1', keyOwnerId: 'user-1', smartleadAccountId: 'smartlead-user-1', channel: 'ui',
    listId: `list_${ulid()}`, campaignId: 4242, campaignName: 'Q4 outreach', campaignSource: 'selected', options: { includeUnverified: false },
    sequenceHash: 'hash1', previewEligible: 100, ...over,
  });
  /** A started AND confirmed run (what the service leaves after it has told the user the start worked). */
  const fresh = async (over: Partial<NewPushRun> = {}) => {
    const r = await db.startRun(input(over), 'worker-A');
    if (!r.started) throw new Error('expected a started run');
    await db.confirmStart(r.run.runId);
    return (await db.getRun(r.run.runId))!;
  };

  beforeAll(async () => {
    await raw.createTable({ ...SMARTLEAD_PUSH_RUNS_TABLE_SPEC, TableName: table }).promise();
  });
  afterAll(async () => {
    await raw.deleteTable({ TableName: table }).promise().catch(() => {});
  });

  describe('the table', () => {
    it('is created from the real definition (DynamoDB validates the keys and the projections)', async () => {
      const d = await raw.describeTable({ TableName: table }).promise();
      expect(d.Table?.GlobalSecondaryIndexes?.map(g => g.IndexName).sort()).toEqual(['ActiveRunsIndex', 'ListRunsIndex', 'OwnerRunsIndex', 'RunsByTimeIndex']);
    });
  });

  describe('event counters (what Smartlead reported about the contacts of a run)', () => {
    it('creates the counters on the first event, then adds, on a live run and on a finished one', async () => {
      const run = await fresh();
      expect(await db.getRunEvents(run.runId)).toBeUndefined();
      expect(await db.countContactEvent(run.runId, 'replied')).toBe(true);
      expect(await db.getRunEvents(run.runId)).toEqual({ replied: 1, bounced: 0, unsubscribed: 0 });
      expect(await db.countContactEvent(run.runId, 'replied')).toBe(true);
      expect(await db.countContactEvent(run.runId, 'unsubscribed')).toBe(true);
      await db.advance(run.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: {}, listExhausted: true });
      expect(await db.finishRun(run.runId, 1, 'completed')).toBe(true); // replies arrive after a push ends
      expect(await db.countContactEvent(run.runId, 'bounced')).toBe(true);
      expect(await db.getRunEvents(run.runId)).toEqual({ replied: 2, bounced: 1, unsubscribed: 1 });
      expect((await db.getRun(run.runId))!).toMatchObject({ status: 'completed', events: { replied: 2, bounced: 1, unsubscribed: 1 }, counts: { examined: 0 } });
    });

    it('loses nothing when many first events race to create the counters', async () => {
      const run = await fresh();
      const kinds = ['replied', 'bounced', 'unsubscribed', 'replied', 'unsubscribed', 'replied'] as const;
      const results = await Promise.all(kinds.map(k => db.countContactEvent(run.runId, k)));
      expect(results.every(Boolean)).toBe(true);
      expect(await db.getRunEvents(run.runId)).toEqual({ replied: 3, bounced: 1, unsubscribed: 2 });
    });

    it('counts nothing and creates nothing for a run that does not exist', async () => {
      expect(await db.countContactEvent('01NOSUCHRUN', 'replied')).toBe(false);
      expect((await doc.get({ TableName: table, Key: { pk: '01NOSUCHRUN', sk: 'RUN' } }).promise()).Item).toBeUndefined();
      expect(await db.getRunEvents('01NOSUCHRUN')).toBeUndefined();
    });

    it('never disturbs the run state, lease, cursor or lock', async () => {
      const run = await fresh();
      const before = (await doc.get({ TableName: table, Key: { pk: run.runId, sk: 'RUN' } }).promise()).Item!;
      await db.countContactEvent(run.runId, 'replied');
      const after = (await doc.get({ TableName: table, Key: { pk: run.runId, sk: 'RUN' } }).promise()).Item!;
      const { events, ...rest } = after;
      expect(events).toEqual({ replied: 1, bounced: 0, unsubscribed: 0 });
      expect(rest).toEqual(before);
      expect(await db.getLock(run.listId, run.campaignId)).toEqual({ runId: run.runId });
    });
  });

  describe('start', () => {
    it('creates a run and its lock, with the full counts map and a numeric ttl', async () => {
      const run = await fresh();
      const read = await db.getRun(run.runId);
      expect(read).toMatchObject({ status: 'running', leaseEpoch: 1, cursor: null, listExhausted: false, counts: { examined: 0, added: 0, skippedByReason: {} } });
      expect(await db.getLock(run.listId, run.campaignId)).toEqual({ runId: run.runId });
      const item = (await doc.get({ TableName: table, Key: { pk: run.runId, sk: 'RUN' } }).promise()).Item!;
      expect(typeof item.ttl).toBe('number');
      expect(item.active).toBe('Y');
    });

    it('returns the existing run, and writes nothing, for a second start on the same list and campaign', async () => {
      const first = await fresh();
      const again = await db.startRun(input({ listId: first.listId }), 'worker-B');
      expect(again).toMatchObject({ started: false, existing: { runId: first.runId } });
      expect((await db.listRunsForList(first.listId)).length).toBe(1);
    });

    it('lets different campaigns on one list, and one campaign on different lists, run at once', async () => {
      const a = await fresh({ campaignId: 1 });
      const b = await db.startRun(input({ listId: a.listId, campaignId: 2 }), 'w');
      const c = await db.startRun(input({ campaignId: 1 }), 'w');
      expect([b.started, c.started]).toEqual([true, true]);
    });

    it('lets exactly ONE of five simultaneous starters win; the others are canceled and see the winner', async () => {
      const base = input();
      const results = await Promise.all([1, 2, 3, 4, 5].map(n => db.startRun({ ...base }, `worker-${n}`)));
      const winners = results.filter(r => r.started);
      expect(winners).toHaveLength(1);
      const winner = (winners[0] as any).run;
      for (const r of results) if (!r.started) expect(r.existing?.runId).toBe(winner.runId);
      const runs = await db.listRunsForList(base.listId, 50);
      expect(runs.filter(r => r.status === 'running').map(r => r.runId)).toEqual([winner.runId]);
      expect(runs.filter(r => r.status === 'canceled')).toHaveLength(4);
      expect(await db.getLock(base.listId, base.campaignId)).toEqual({ runId: winner.runId });
    });

    it('takes over a lock a finished run left behind (a crash between the terminal write and the release)', async () => {
      const old = await fresh();
      await doc.update({ TableName: table, Key: { pk: old.runId, sk: 'RUN' }, UpdateExpression: 'SET #s = :c REMOVE #a', ExpressionAttributeNames: { '#s': 'status', '#a': 'active' }, ExpressionAttributeValues: { ':c': 'completed' } }).promise();
      const next = await db.startRun(input({ listId: old.listId }), 'worker-B');
      expect(next.started).toBe(true);
      expect(await db.getLock(old.listId, old.campaignId)).toEqual({ runId: (next as any).run.runId });
    });

    it('lets exactly ONE of several simultaneous starters take over the same stale lock', async () => {
      const old = await fresh();
      await doc.update({ TableName: table, Key: { pk: old.runId, sk: 'RUN' }, UpdateExpression: 'SET #s = :c REMOVE #a', ExpressionAttributeNames: { '#s': 'status', '#a': 'active' }, ExpressionAttributeValues: { ':c': 'failed' } }).promise();
      const results = await Promise.all([1, 2, 3, 4].map(n => db.startRun(input({ listId: old.listId }), `worker-${n}`)));
      const winners = results.filter(r => r.started);
      expect(winners).toHaveLength(1);
      const winner = (winners[0] as any).run;
      expect(await db.getLock(old.listId, old.campaignId)).toEqual({ runId: winner.runId });
      const runs = await db.listRunsForList(old.listId, 50);
      expect(runs.filter(r => r.status === 'running').map(r => r.runId)).toEqual([winner.runId]);
    });

    it('never takes over a lock whose run is missing: it reports who holds it, for an operator', async () => {
      const i = input();
      await doc.put({ TableName: table, Item: { pk: `LOCK#${i.listId}#${i.campaignId}`, sk: 'LOCK', runId: 'GONE', ttl: 1 } }).promise();
      expect(await db.startRun(i, 'w')).toEqual({ started: false, existing: null, lockHeldBy: 'GONE' });
    });

    it('refuses an invalid campaign id before touching the table', async () => {
      await expect(db.startRun(input({ campaignId: 0 }), 'w')).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });

  describe('the lease and the fence', () => {
    it('claims only a lapsed lease, with the epoch the caller saw, and raises the epoch', async () => {
      const run = await fresh();
      expect(await db.claimLease(run.runId, 'worker-B', 1)).toBeNull(); // the lease is still valid
      clock += LEASE_MS + 31_000;
      expect(await db.claimLease(run.runId, 'worker-B', 99)).toBeNull(); // a stale epoch
      const claimed = await db.claimLease(run.runId, 'worker-B', 1);
      expect(claimed).toMatchObject({ leaseEpoch: 2, leaseOwner: 'worker-B' });
      expect(await db.claimLease(run.runId, 'worker-C', 1)).toBeNull(); // the winner holds it now
    });

    it('never claims a finished, canceled or paused run, even though its old lease has lapsed (a stale index row must not revive it)', async () => {
      const done = await fresh();
      await db.advance(done.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: {}, listExhausted: true });
      await db.finishRun(done.runId, 1, 'completed');
      const canceled = await fresh();
      await db.cancelRun(canceled.runId);
      const paused = await fresh();
      await db.pauseRun(paused.runId, 'user');
      clock += LEASE_MS + 100_000;
      for (const r of [done, canceled, paused]) expect(await db.claimLease(r.runId, 'worker-B', 1)).toBeNull();
      expect((await db.getRun(done.runId))!.status).toBe('completed');
      expect((await db.getRun(canceled.runId))!.status).toBe('canceled');
    });

    it('lets two resumers claim the same lapsed run: exactly one wins', async () => {
      const run = await fresh();
      clock += LEASE_MS + 31_000;
      const got = await Promise.all([db.claimLease(run.runId, 'B', 1), db.claimLease(run.runId, 'C', 1), db.claimLease(run.runId, 'D', 1)]);
      expect(got.filter(Boolean)).toHaveLength(1);
    });

    it('fences a worker that lost its lease: it can neither renew nor advance', async () => {
      const run = await fresh();
      clock += LEASE_MS + 31_000;
      await db.claimLease(run.runId, 'worker-B', 1);
      expect(await db.heartbeat(run.runId, 1)).toBe(false);
      expect(await db.advance(run.runId, 1, { cursor: { listId: run.listId, leadId: 'lead_1' }, counts: { examined: 10 } })).toBe(false);
      expect((await db.getRun(run.runId))!.counts.examined).toBe(0);
      expect(await db.heartbeat(run.runId, 2)).toBe(true);
    });

    it('advances the cursor and adds to the counts, including dynamic skip reasons, and resets the batch attempts', async () => {
      const run = await fresh();
      await db.recordBatchFailure(run.runId, 1);
      const step = { cursor: { listId: run.listId, leadId: 'lead_400' }, counts: { examined: 400, added: 380, alreadyInCampaign: 5, unconfirmed: 1 }, skipped: { missing_tag: 10, do_not_contact: 4 } };
      expect(await db.advance(run.runId, 1, step)).toBe(true);
      expect(await db.advance(run.runId, 1, { cursor: { listId: run.listId, leadId: 'lead_800' }, counts: { examined: 100, added: 90 }, skipped: { missing_tag: 2 }, listExhausted: true })).toBe(true);
      const read = (await db.getRun(run.runId))!;
      expect(read.counts).toEqual({ examined: 500, added: 470, alreadyInCampaign: 5, unconfirmed: 1, withdrawn: 0, skippedByReason: { missing_tag: 12, do_not_contact: 4 } });
      expect(read.cursor).toEqual({ listId: run.listId, leadId: 'lead_800' });
      expect(read).toMatchObject({ listExhausted: true, batchAttempts: 0 });
    });

    it('rejects a bad count or skip-reason name before it reaches DynamoDB', async () => {
      const run = await fresh();
      await expect(db.advance(run.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: {}, skipped: { 'bad reason!': 1 } })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.advance(run.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: { examined: -1 } })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.advance(run.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: { bogus: 1 } as any })).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('stops a worker whose run was paused or canceled: the next advance fails, and nothing is overwritten', async () => {
      const paused = await fresh();
      expect(await db.pauseRun(paused.runId, 'sequence_changed')).toBe(true);
      expect(await db.advance(paused.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: { examined: 1 } })).toBe(false);
      expect(await db.heartbeat(paused.runId, 1)).toBe(false);
      const canceled = await fresh();
      expect(await db.cancelRun(canceled.runId)).toBe(true);
      expect(await db.advance(canceled.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: { examined: 1 } })).toBe(false);
      expect(await db.finishRun(canceled.runId, 1, 'completed')).toBe(false);
      expect((await db.getRun(canceled.runId))!.status).toBe('canceled');
    });
  });

  describe('batch failures', () => {
    it('stops the run as partial after the attempt cap, keeps its lock, and resume starts a fresh epoch', async () => {
      const run = await fresh();
      for (let n = 1; n < MAX_BATCH_ATTEMPTS; n++) expect(await db.recordBatchFailure(run.runId, 1)).toEqual({ attempts: n, partial: false });
      expect(await db.recordBatchFailure(run.runId, 1)).toEqual({ attempts: MAX_BATCH_ATTEMPTS, partial: true });
      const partial = (await db.getRun(run.runId))!;
      expect(partial).toMatchObject({ status: 'partial', pauseReason: 'batch_failed' });
      expect(await db.getLock(run.listId, run.campaignId)).toEqual({ runId: run.runId });
      expect(await db.startRun(input({ listId: run.listId }), 'w')).toMatchObject({ started: false, existing: { runId: run.runId } });
      const resumed = await db.resumeRun(run.runId, 'worker-B', partial.leaseEpoch);
      expect(resumed).toMatchObject({ status: 'running', leaseEpoch: 2, batchAttempts: 0 });
      expect(resumed!.pauseReason).toBeUndefined();
    });
  });

  describe('pause, resume, cancel, finish', () => {
    it('resumes only a paused or partial run, and only with the epoch the caller saw', async () => {
      const run = await fresh();
      expect(await db.resumeRun(run.runId, 'w', 1)).toBeNull(); // running
      await db.pauseRun(run.runId, 'key_rejected');
      expect(await db.resumeRun(run.runId, 'w', 7)).toBeNull();
      expect(await db.resumeRun(run.runId, 'w', 1)).toMatchObject({ status: 'running', leaseEpoch: 2 });
    });

    it('cancels a paused run with no epoch, releases its lock, and refuses a finished one', async () => {
      const run = await fresh();
      await db.pauseRun(run.runId, 'user');
      expect(await db.cancelRun(run.runId)).toBe(true);
      expect(await db.getLock(run.listId, run.campaignId)).toBeNull();
      expect(await db.cancelRun(run.runId)).toBe(false);
      expect((await db.startRun(input({ listId: run.listId }), 'w')).started).toBe(true);
    });

    it('completes a run only after the walk reached the end of the list, then releases the lock', async () => {
      const run = await fresh();
      expect(await db.finishRun(run.runId, 1, 'completed')).toBe(false); // listExhausted is still false
      await db.advance(run.runId, 1, { cursor: { listId: run.listId, leadId: 'last' }, counts: { examined: 1 }, listExhausted: true });
      expect(await db.finishRun(run.runId, 2, 'completed')).toBe(false); // a stale epoch
      expect(await db.finishRun(run.runId, 1, 'completed')).toBe(true);
      const read = (await db.getRun(run.runId))!;
      expect(read.status).toBe('completed');
      expect(read.finishedAt).toBeTruthy();
      expect(await db.getLock(run.listId, run.campaignId)).toBeNull();
      expect(await db.finishRun(run.runId, 1, 'completed')).toBe(false);
    });

    it('fails a run with a scrubbed, truncated reason', async () => {
      const run = await fresh();
      expect(await db.finishRun(run.runId, 1, 'failed', { code: 'x'.repeat(100), message: 'y'.repeat(900) })).toBe(true);
      const read = (await db.getRun(run.runId))!;
      expect(read.failure!.code).toHaveLength(60);
      expect(read.failure!.message).toHaveLength(500);
    });

    it('says whether the lock points at a run (the resumer cancels one it does not)', async () => {
      const run = await fresh();
      expect(await db.lockPointsAt(run)).toBe(true);
      await db.releaseLock(run.listId, run.campaignId, 'someone-else'); // the condition fails: nothing is deleted
      expect(await db.lockPointsAt(run)).toBe(true);
      await db.releaseLock(run.listId, run.campaignId, run.runId);
      expect(await db.lockPointsAt(run)).toBe(false);
    });
  });

  describe('the resumer queries and history', () => {
    it('finds a running run only once its lease has lapsed, and paused runs only in the stale list', async () => {
      const lapsed = await fresh();
      const live = await fresh();
      const paused = await fresh();
      await db.pauseRun(paused.runId, 'user');
      clock += LEASE_MS + 1000;
      await db.heartbeat(live.runId, 1);
      const expired = (await db.findExpiredLeases(200)).map(r => r.runId);
      expect(expired).toContain(lapsed.runId);
      expect(expired).not.toContain(live.runId);
      expect(expired).not.toContain(paused.runId);
      expect((await db.findStalePaused(7 * 86_400_000)).map(r => r.runId)).not.toContain(paused.runId);
      clock += 8 * 86_400_000;
      expect((await db.findStalePaused(7 * 86_400_000)).map(r => r.runId)).toContain(paused.runId);
    });

    it('drops a finished run from the resume index', async () => {
      const run = await fresh();
      await db.advance(run.runId, 1, { cursor: { listId: 'l', leadId: 'x' }, counts: {}, listExhausted: true });
      await db.finishRun(run.runId, 1, 'completed');
      clock += LEASE_MS + 100_000;
      expect((await db.findExpiredLeases(500)).map(r => r.runId)).not.toContain(run.runId);
    });

    it('lists a list\'s history newest first, with a summary, and by owner and by time', async () => {
      const listId = `list_${ulid()}`;
      const a = await fresh({ listId, ownerId: 'owner-X' });
      clock += 5000;
      const b = await fresh({ listId, campaignId: 9, ownerId: 'owner-X' });
      expect((await db.listRunsForList(listId)).map(r => r.runId)).toEqual([b.runId, a.runId]);
      expect((await db.listRunsForList(listId))[0]).toMatchObject({ status: 'running', campaignId: 9, campaignName: 'Q4 outreach', pushedBy: 'user-1' });
      expect((await db.listRunsForOwner('owner-X')).map(r => r.runId)).toEqual([b.runId, a.runId]);
      const since = (await db.listRunsSince(new Date(clock - 1000).toISOString(), 200)).map(r => r.runId);
      expect(since).toContain(b.runId);
      expect(since).not.toContain(a.runId);
    });

    it('never returns a run whose ttl has passed, even before DynamoDB deletes it', async () => {
      const run = await fresh();
      await doc.update({ TableName: table, Key: { pk: run.runId, sk: 'RUN' }, UpdateExpression: 'SET #t = :t', ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':t': Math.floor(clock / 1000) - 10 } }).promise();
      expect((await db.listRunsForList(run.listId)).map(r => r.runId)).not.toContain(run.runId);
    });
  });

  describe('review findings (PR-B review 1)', () => {
    it('redacts keys, tokens and emails from stored failure text and pause reasons', async () => {
      const a = await fresh();
      await db.finishRun(a.runId, 1, 'failed', { code: 'http_401', message: 'GET https://server.smartlead.ai/api/v1/campaigns?api_key=SECRET123&x=1 failed for a@b.com; Bearer abc.def' });
      const stored = JSON.stringify((await db.getRun(a.runId))!.failure);
      expect(stored).not.toMatch(/SECRET123|a@b\.com|abc\.def/);
      const b = await fresh();
      await db.pauseRun(b.runId, 'bad ?api_key=SECRET123');
      expect((await db.getRun(b.runId))!.pauseReason).not.toContain('SECRET123');
    });

    it('will not revive a paused run whose lock now belongs to a newer run (resume and claim both re-take the lock)', async () => {
      const a = await fresh();
      await db.pauseRun(a.runId, 'user');
      await doc.delete({ TableName: table, Key: { pk: `LOCK#${a.listId}#${a.campaignId}`, sk: 'LOCK' } }).promise(); // the lock's own expiry
      const b = await db.startRun(input({ listId: a.listId }), 'w');
      expect(b.started).toBe(true);
      expect(await db.resumeRun(a.runId, 'w', 1)).toBeNull();
      expect((await db.getRun(a.runId))!.status).toBe('paused');
      // a running run whose lock was taken by another run cannot be claimed either
      const c = await fresh();
      await doc.put({ TableName: table, Item: { pk: `LOCK#${c.listId}#${c.campaignId}`, sk: 'LOCK', runId: 'OTHER', ttl: 9999999999 } }).promise();
      clock += LEASE_MS + 100_000;
      expect(await db.claimLease(c.runId, 'w', 1)).toBeNull();
    });

    it('resume re-creates a lock that expired, and refreshes it', async () => {
      const a = await fresh();
      await db.pauseRun(a.runId, 'user');
      await doc.delete({ TableName: table, Key: { pk: `LOCK#${a.listId}#${a.campaignId}`, sk: 'LOCK' } }).promise();
      expect(await db.resumeRun(a.runId, 'w', 1)).toMatchObject({ status: 'running' });
      expect(await db.getLock(a.listId, a.campaignId)).toEqual({ runId: a.runId });
    });

    it("shows the list on an owner's history rows", async () => {
      const a = await fresh({ ownerId: 'owner-L' });
      expect((await db.listRunsForOwner('owner-L'))[0]).toMatchObject({ runId: a.runId, listId: a.listId });
    });

    it('skips an unreadable row instead of failing the whole resumer query', async () => {
      const bad = await fresh();
      const good = await fresh();
      await doc.update({ TableName: table, Key: { pk: bad.runId, sk: 'RUN' }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'preparing' } }).promise();
      clock += LEASE_MS + 100_000;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const ids = (await db.findExpiredLeases(500)).map(r => r.runId);
      warn.mockRestore();
      expect(ids).toContain(good.runId);
      expect(ids).not.toContain(bad.runId);
    });

    it('pages past expired rows to fill the limit', async () => {
      const listId = `list_${ulid()}`;
      const runs = [];
      for (let n = 1; n <= 4; n++) { clock += 1000; runs.push(await fresh({ listId, campaignId: n })); }
      for (const r of runs.slice(2)) await doc.update({ TableName: table, Key: { pk: r.runId, sk: 'RUN' }, UpdateExpression: 'SET #t = :t', ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':t': Math.floor(clock / 1000) - 10 } }).promise();
      expect((await db.listRunsForList(listId, 2)).map(r => r.runId).sort()).toEqual([runs[0].runId, runs[1].runId].sort());
    });

    it('does not throw when the lock cannot be released after the run itself ended', async () => {
      const a = await fresh();
      const flaky = new SmartleadPushRunDb({ get: doc.get.bind(doc), put: doc.put.bind(doc), query: doc.query.bind(doc), update: doc.update.bind(doc), delete: () => ({ promise: async () => { throw Object.assign(new Error('no'), { code: 'AccessDeniedException' }); } }) } as any, table, () => clock, async () => {});
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await flaky.cancelRun(a.runId)).toBe(true);
      warn.mockRestore();
      expect((await db.getRun(a.runId))!.status).toBe('canceled');
      expect((await db.startRun(input({ listId: a.listId }), 'w')).started).toBe(true); // the leaked lock is taken over
    });

    it('refuses an advance without a cursor instead of rewinding the walk', async () => {
      const a = await fresh();
      await expect(db.advance(a.runId, 1, { cursor: null, counts: { examined: 1 } })).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('completes an empty list (no cursor, exhausted) and never erases a stored cursor when exhausting', async () => {
      const empty = await fresh();
      expect(await db.advance(empty.runId, 1, { cursor: null, counts: {}, listExhausted: true })).toBe(true);
      expect(await db.finishRun(empty.runId, 1, 'completed')).toBe(true);
      const walked = await fresh();
      await db.advance(walked.runId, 1, { cursor: { listId: walked.listId, leadId: 'L9' }, counts: { examined: 1 } });
      await db.advance(walked.runId, 1, { cursor: null, counts: {}, listExhausted: true });
      expect((await db.getRun(walked.runId))!.cursor).toEqual({ listId: walked.listId, leadId: 'L9' });
    });

    it('redacts the common key spellings, and stays fast on hostile input', () => {
      const out = redactSecrets('api_key: A1 {"apiKey":"B2"} x-api-key: C3 api_key%3DD4 apikey = E5 Authorization: Basic Zm9v token=F6');
      expect(out).not.toMatch(/A1|B2|C3|D4|E5|Zm9v|F6/);
      expect(redactSecrets('api_key=' + 'A'.repeat(900) + 'TAILSECRET')).not.toContain('TAILSECRET');
      expect(redactSecrets('Bearer ' + 'B'.repeat(900) + 'TAILSECRET')).not.toContain('TAILSECRET');
      for (const evil of ['a'.repeat(100_000), 'a'.repeat(50_000) + '@' + 'a'.repeat(50_000), 'a'.repeat(50_000) + '@' + '1.'.repeat(25_000)]) {
        const t0 = Date.now();
        redactSecrets(evil);
        expect(Date.now() - t0).toBeLessThan(200);
      }
    });

    it('keeps the lock of a run that was paused (not dead) between its two start writes', async () => {
      const base = input();
      const racing = new SmartleadPushRunDb({
        get: doc.get.bind(doc), query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => {
          const out = doc.put(p);
          if (p.Item?.sk !== 'LOCK') return out;
          return { promise: async () => { const r = await out.promise();
            await doc.update({ TableName: table, Key: { pk: p.Item.runId, sk: 'RUN' }, UpdateExpression: 'SET #s = :c', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':c': 'paused' } }).promise(); return r; } };
        },
      } as any, table, () => clock, async () => {});
      await racing.startRun(base, 'w');
      expect(await db.getLock(base.listId, base.campaignId)).not.toBeNull();
      expect((await db.startRun(input({ listId: base.listId }), 'w2')).started).toBe(false);
    });

    it('does not report a started run that was canceled between its two writes', async () => {
      const base = input();
      let calls = 0;
      const racing = new SmartleadPushRunDb({
        get: doc.get.bind(doc), query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => {
          const out = doc.put(p);
          if (p.Item?.sk === 'LOCK' && calls++ === 0) {
            return { promise: async () => { const r = await out.promise(); // the resumer cancels the orphan right after the lock lands
              await doc.update({ TableName: table, Key: { pk: p.Item.runId, sk: 'RUN' }, UpdateExpression: 'SET #s = :c REMOVE #a', ExpressionAttributeNames: { '#s': 'status', '#a': 'active' }, ExpressionAttributeValues: { ':c': 'canceled' } }).promise(); return r; } };
          }
          return out;
        },
      } as any, table, () => clock, async () => {});
      const r = await racing.startRun(base, 'w');
      expect(r.started).toBe(false);
      expect(await db.getLock(base.listId, base.campaignId)).toBeNull();
    });

    it('refuses empty owner, pusher or worker ids as invalid input', async () => {
      await expect(db.startRun(input({ ownerId: '' }), 'w')).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.startRun(input({ pushedBy: '' }), 'w')).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.startRun(input(), '')).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });

  describe('a reply lost after a write committed (the call is retried)', () => {
    /** A client whose first matching put COMMITS and then fails with a retryable error, so the store retries into its own earlier write. */
    const lossy = (match: (item: any) => boolean) => {
      let lost = false;
      return new SmartleadPushRunDb({
        get: doc.get.bind(doc), query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => {
          if (lost || !match(p.Item)) return doc.put(p);
          lost = true;
          return { promise: async () => { await doc.put(p).promise(); throw Object.assign(new Error('reply lost'), { code: 'ServiceUnavailable' }); } };
        },
      } as any, table, () => clock, async () => {});
    };

    it('starts exactly one run when the run write committed but its reply was lost', async () => {
      const i = input();
      const r = await lossy(item => item.sk === 'RUN').startRun(i, 'w');
      expect(r.started).toBe(true);
      const runs = await db.listRunsForList(i.listId, 50);
      expect(runs).toHaveLength(1);
      expect(await db.getLock(i.listId, i.campaignId)).toEqual({ runId: runs[0].runId });
      expect(runs[0].status).toBe('running');
    });

    it('starts exactly one run when the lock write committed but its reply was lost, and does not cancel its own run', async () => {
      const i = input();
      const r = await lossy(item => item.sk === 'LOCK').startRun(i, 'w');
      expect(r.started).toBe(true);
      const runs = await db.listRunsForList(i.listId, 50);
      expect(runs.map(x => x.status)).toEqual(['running']);
      expect(await db.getLock(i.listId, i.campaignId)).toEqual({ runId: (r as any).run.runId });
    });

    it('also holds for an error that is NOT retryable (a reset socket) after the lock committed: the run is reported started, never left as a live run the caller was told failed', async () => {
      const i = input();
      let lost = false;
      const client = {
        get: doc.get.bind(doc), query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => (lost || p.Item?.sk !== 'LOCK' ? doc.put(p) : { promise: async () => { lost = true; await doc.put(p).promise(); throw Object.assign(new Error('socket reset'), { code: 'SocketError' }); } }),
      } as any;
      const r = await new SmartleadPushRunDb(client, table, () => clock, async () => {}).startRun(i, 'w');
      expect(r.started).toBe(true);
      expect(await db.getLock(i.listId, i.campaignId)).toEqual({ runId: (r as any).run.runId });
    });

    it('also holds for a non-retryable error after the RUN write committed', async () => {
      const i = input();
      let lost = false;
      const client = {
        get: doc.get.bind(doc), query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => (lost || p.Item?.sk !== 'RUN' ? doc.put(p) : { promise: async () => { lost = true; await doc.put(p).promise(); throw Object.assign(new Error('socket reset'), { code: 'SocketError' }); } }),
      } as any;
      const r = await new SmartleadPushRunDb(client, table, () => clock, async () => {}).startRun(i, 'w');
      expect(r.started).toBe(true);
      expect((await db.listRunsForList(i.listId, 50)).map(x => x.status)).toEqual(['running']);
    });

    it('abandons its run, so nothing can claim it, when the lock write definitely failed', async () => {
      const i = input();
      const client = {
        get: doc.get.bind(doc), query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => (p.Item?.sk === 'LOCK' ? { promise: async () => { throw Object.assign(new Error('denied'), { code: 'AccessDeniedException' }); } } : doc.put(p)),
      } as any;
      await expect(new SmartleadPushRunDb(client, table, () => clock, async () => {}).startRun(i, 'w')).rejects.toMatchObject({ code: 'access_denied' });
      expect((await db.listRunsForList(i.listId, 50)).map(x => x.status)).toEqual(['canceled']);
      expect(await db.getLock(i.listId, i.campaignId)).toBeNull();
      clock += LEASE_MS + 31_000;
      expect((await db.findExpiredLeases(500)).map(x => x.runId)).not.toContain((await db.listRunsForList(i.listId, 50))[0].runId);
    });

    it('cancels its run FIRST when it cannot tell whether the lock committed (the read fails too), so nothing can claim it later', async () => {
      const i = input();
      let lost = false;
      const client = {
        get: (p: any) => (p.Key?.sk === 'LOCK' && lost ? { promise: async () => { throw Object.assign(new Error('read failed'), { code: 'SocketError' }); } } : doc.get(p)),
        query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => (lost || p.Item?.sk !== 'LOCK' ? doc.put(p) : { promise: async () => { lost = true; await doc.put(p).promise(); throw Object.assign(new Error('socket reset'), { code: 'SocketError' }); } }),
      } as any;
      await expect(new SmartleadPushRunDb(client, table, () => clock, async () => {}).startRun(i, 'w')).rejects.toThrow();
      const runs = await db.listRunsForList(i.listId, 50);
      expect(runs.map(x => x.status)).toEqual(['canceled']);
      clock += LEASE_MS + 31_000;
      expect(await db.claimLease(runs[0].runId, 'worker-B', 1)).toBeNull(); // the lock points at it, but it is dead
      expect((await db.startRun(i, 'w2')).started).toBe(true); // and the next start simply takes the stale lock over
    });

    it('raises an error carrying the run id when it cannot even cancel, so the caller keeps trying', async () => {
      const i = input();
      let lost = false;
      const client = {
        get: (p: any) => (p.Key?.sk === 'LOCK' && lost ? { promise: async () => { throw Object.assign(new Error('read failed'), { code: 'SocketError' }); } } : doc.get(p)),
        query: doc.query.bind(doc), delete: doc.delete.bind(doc),
        update: () => ({ promise: async () => { throw Object.assign(new Error('write failed'), { code: 'SocketError' }); } }),
        put: (p: any) => (lost || p.Item?.sk !== 'LOCK' ? doc.put(p) : { promise: async () => { lost = true; await doc.put(p).promise(); throw Object.assign(new Error('socket reset'), { code: 'SocketError' }); } }),
      } as any;
      const err: any = await new SmartleadPushRunDb(client, table, () => clock, async () => {}).startRun(i, 'w').catch(e => e);
      expect(err).toBeInstanceOf(SmartleadPushRunStoreError);
      expect(err.runId).toBe((await db.listRunsForList(i.listId, 50))[0].runId);
      expect((await db.getRun(err.runId))!.status).toBe('running'); // still live: the service must cancel it
    });

    it('does the same for a takeover of a finished run\'s lock', async () => {
      const old = await fresh();
      await doc.update({ TableName: table, Key: { pk: old.runId, sk: 'RUN' }, UpdateExpression: 'SET #s = :c REMOVE #a', ExpressionAttributeNames: { '#s': 'status', '#a': 'active' }, ExpressionAttributeValues: { ':c': 'completed' } }).promise();
      const r = await lossy(item => item.sk === 'LOCK').startRun(input({ listId: old.listId }), 'w');
      expect(r.started).toBe(true);
      expect(await db.getLock(old.listId, old.campaignId)).toEqual({ runId: (r as any).run.runId });
    });
  });

  describe('an unconfirmed start', () => {
    it('is born unconfirmed, can not be claimed even after its lease lapsed, and becomes claimable only once confirmed', async () => {
      const i = input();
      const r = await db.startRun(i, 'w');
      if (!r.started) throw new Error('expected a start');
      expect((await db.getRun(r.run.runId))!.startUnconfirmed).toBe(true);
      clock += LEASE_MS + 31_000;
      expect(await db.claimLease(r.run.runId, 'worker-B', 1)).toBeNull();
      await db.confirmStart(r.run.runId);
      expect((await db.getRun(r.run.runId))!.startUnconfirmed).toBeUndefined();
      expect(await db.claimLease(r.run.runId, 'worker-B', 1)).toMatchObject({ leaseEpoch: 2 });
    });

    it('can not be resumed by pausing it first: a paused unconfirmed run stays unresumable', async () => {
      const r = await db.startRun(input(), 'w');
      if (!r.started) throw new Error('expected a start');
      await db.pauseRun(r.run.runId, 'user');
      expect(await db.resumeRun(r.run.runId, 'w', 1)).toBeNull();
      expect(await db.confirmStart(r.run.runId)).toBe(false); // a paused run can not be "confirmed" into a resumable one either
      expect(await db.resumeRun(r.run.runId, 'w', 1)).toBeNull();
    });

    it('confirms only a run that is still running: one the resumer already cancelled is not reported as started', async () => {
      const r = await db.startRun(input(), 'w');
      if (!r.started) throw new Error('expected a start');
      await db.cancelRun(r.run.runId);
      expect(await db.confirmStart(r.run.runId)).toBe(false);
      expect((await db.getRun(r.run.runId))!.status).toBe('canceled');
      const fresh2 = await db.startRun(input(), 'w');
      if (!fresh2.started) throw new Error('expected a start');
      expect(await db.confirmStart(fresh2.run.runId)).toBe(true);
    });

    it('settles a RETRYABLE lost reply on the lock write whose follow-up read also fails: the run is cancelled, not left to be claimed', async () => {
      const i = input();
      let lost = false;
      const client = {
        get: (p: any) => (p.Key?.sk === 'LOCK' && lost ? { promise: async () => { throw Object.assign(new Error('read failed'), { code: 'SocketError' }); } } : doc.get(p)),
        query: doc.query.bind(doc), update: doc.update.bind(doc), delete: doc.delete.bind(doc),
        put: (p: any) => (lost || p.Item?.sk !== 'LOCK' ? doc.put(p) : { promise: async () => { lost = true; await doc.put(p).promise(); throw Object.assign(new Error('timeout'), { code: 'ServiceUnavailable' }); } }),
      } as any;
      await expect(new SmartleadPushRunDb(client, table, () => clock, async () => {}).startRun(i, 'w')).rejects.toThrow();
      expect((await db.listRunsForList(i.listId, 50)).map(x => x.status)).toEqual(['canceled']);
    });

    it('can not be claimed even when it could not be cancelled either (the store stayed down, or the process restarted)', async () => {
      const i = input();
      let lost = false;
      const client = {
        get: (p: any) => (p.Key?.sk === 'LOCK' && lost ? { promise: async () => { throw Object.assign(new Error('read failed'), { code: 'SocketError' }); } } : doc.get(p)),
        query: doc.query.bind(doc), delete: doc.delete.bind(doc),
        update: () => ({ promise: async () => { throw Object.assign(new Error('write failed'), { code: 'SocketError' }); } }),
        put: (p: any) => (lost || p.Item?.sk !== 'LOCK' ? doc.put(p) : { promise: async () => { lost = true; await doc.put(p).promise(); throw Object.assign(new Error('timeout'), { code: 'ServiceUnavailable' }); } }),
      } as any;
      const err: any = await new SmartleadPushRunDb(client, table, () => clock, async () => {}).startRun(i, 'w').catch(e => e);
      const run = (await db.getRun(err.runId))!;
      expect(run).toMatchObject({ status: 'running', startUnconfirmed: true });
      expect(await db.getLock(i.listId, i.campaignId)).toEqual({ runId: run.runId }); // live, locked, and reported as failed...
      clock += LEASE_MS + 31_000;
      expect(await db.claimLease(run.runId, 'worker-B', 1)).toBeNull(); // ...but nothing can ever claim and send it
    });
  });

  describe('an orphan run (a crash between a start\'s two writes)', () => {
    it('is never given a lock by a lease claim: it has none, and must not take one', async () => {
      const orphan = await fresh();
      await db.releaseLock(orphan.listId, orphan.campaignId, orphan.runId); // the crash: Run written, Lock never
      clock += LEASE_MS + 31_000;
      expect(await db.claimLease(orphan.runId, 'worker-B', 1)).toBeNull();
      expect(await db.getLock(orphan.listId, orphan.campaignId)).toBeNull();
      expect(await db.lockPointsAt(orphan)).toBe(false);
    });

    it('still lets a user resume a paused run whose lock expired meanwhile', async () => {
      const a = await fresh();
      await db.pauseRun(a.runId, 'user');
      await db.releaseLock(a.listId, a.campaignId, a.runId);
      expect(await db.resumeRun(a.runId, 'w', 1)).toMatchObject({ status: 'running' });
      expect(await db.getLock(a.listId, a.campaignId)).toEqual({ runId: a.runId });
    });
  });

  describe('single-use approvals', () => {
    it('lets exactly one of several simultaneous claims win, remembers the run, and gives the approval back on release', async () => {
      const jti = `jti-${ulid()}`;
      const results = await Promise.all([1, 2, 3, 4].map(() => db.claimToken(jti, 7200)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await db.getTokenRun(jti)).toBeNull();
      await db.setTokenRun(jti, 'run-1');
      expect(await db.getTokenRun(jti)).toBe('run-1');
      expect(await db.claimToken(jti, 7200)).toBe(false);
      await db.releaseToken(jti);
      expect(await db.claimToken(jti, 7200)).toBe(true);
    });

    it('stores the token with an expiry, and does not touch any index or other record', async () => {
      const jti = `jti-${ulid()}`;
      await db.claimToken(jti, 7200);
      const item = (await doc.get({ TableName: table, Key: { pk: `TOKEN#${jti}`, sk: 'TOKEN' } }).promise()).Item!;
      expect(item.ttl).toBeGreaterThan(Math.floor(clock / 1000) + 7000);
      expect(item.kind).toBeUndefined();
      expect(item.active).toBeUndefined();
      await expect(db.claimToken('', 7200)).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });

  describe('older and newer writers', () => {
    it('reads a run that carries an attribute it does not know, and refuses one in a state it does not know', async () => {
      const run = await fresh();
      await doc.update({ TableName: table, Key: { pk: run.runId, sk: 'RUN' }, UpdateExpression: 'SET futureThing = :f', ExpressionAttributeValues: { ':f': { x: 1 } } }).promise();
      expect(await db.getRun(run.runId)).toMatchObject({ runId: run.runId });
      await doc.update({ TableName: table, Key: { pk: run.runId, sk: 'RUN' }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'preparing' } }).promise();
      await expect(db.getRun(run.runId)).rejects.toMatchObject({ code: 'unsupported_item' });
    });
  });

  describe('failing closed', () => {
    it('reports a missing table as table_missing, never as "no run"', async () => {
      const broken = new SmartleadPushRunDb(doc, `Test-missing-${ulid()}`, () => clock, async () => {});
      await expect(broken.startRun(input(), 'w')).rejects.toMatchObject({ code: 'table_missing' });
      await expect(broken.getRun('x')).rejects.toBeInstanceOf(SmartleadPushRunStoreError);
    });

    it('retries throttling a few times, then reports it; and reports denied access', async () => {
      const throttle = (times: number) => {
        let n = 0;
        return { get: () => ({ promise: async () => { if (n++ < times) throw Object.assign(new Error('slow'), { code: 'ThrottlingException' }); return { Item: undefined }; } }) } as any;
      };
      const sleeps: number[] = [];
      const ok = new SmartleadPushRunDb(throttle(2), table, () => clock, async ms => { sleeps.push(ms); });
      expect(await ok.getRun('x')).toBeNull();
      expect(sleeps).toEqual([50, 200]);
      const stuck = new SmartleadPushRunDb(throttle(99), table, () => clock, async () => {});
      await expect(stuck.getRun('x')).rejects.toMatchObject({ code: 'throttled' });
      const denied = new SmartleadPushRunDb({ get: () => ({ promise: async () => { throw Object.assign(new Error('no'), { code: 'AccessDeniedException' }); } }) } as any, table, () => clock, async () => {});
      await expect(denied.getRun('x')).rejects.toMatchObject({ code: 'access_denied' });
    });
  });
});
