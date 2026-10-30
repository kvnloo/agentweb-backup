/**
 * ENG-2113 (security review S8): the ledger has caps (512 records, 4 MiB). With ~260 reads of 16 KB inputs the byte budget was used up and a LATER write (a
 * send_email that DID execute) was absent from the persisted record. Reads now give way to writes.
 */
import { ToolBridge, type BridgeExecuteOutcome, type ToolBridgeDeps } from '../toolBridge';

function rig(writeKb = 0) {
  const executed: string[] = [];
  const deps = {
    resolveTools: async () => [{ name: 'read_it' }, { name: 'send_email' }],
    isReadOnly: (n: string) => n === 'read_it',
    isLive: async () => true,
    execute: async (_r: unknown, c: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
      executed.push(c.name);
      return { content: c.name === 'send_email' && writeKb ? 'w'.repeat(writeKb * 1024) : `${c.name} ok`, isError: false, requiresConfirmation: false, toolsChanged: false };
    },
  };
  const bridge = new ToolBridge(deps as unknown as ToolBridgeDeps);
  const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'c1', epoch: 1 });
  bridge.beginTurn('u1', 's1');
  const read = (i: number, kb = 16) => bridge.callTool(token, { name: 'read_it', args: { i, pad: 'x'.repeat(kb * 1024) }, callId: `r${i}` });
  const write = (i: number) => bridge.callTool(token, { name: 'send_email', args: { to: `p${i}`, body: 'hello' }, callId: `w${i}` });
  const writeWith = (i: number, kb: number) => bridge.callTool(token, { name: 'send_email', args: { to: `p${i}`, pad: 'x'.repeat(kb * 1024) }, callId: `w${i}` });
  return { bridge, executed, read, write, writeWith, token };
}

describe('ledger: reads give way to writes', () => {
  it('after ~300 reads with 16 KB inputs, a later write is still in the record (it used to be dropped)', async () => {
    const t = rig();
    for (let i = 0; i < 300; i++) await t.read(i);
    await t.write(1);
    const { records, truncated } = t.bridge.takeLedger('r1');
    expect(t.executed.filter((n) => n === 'send_email')).toHaveLength(1);
    expect(records.some((r) => r.toolCallId === 'w1' && r.kind === 'executed')).toBe(true);
    expect(truncated).toBeGreaterThan(0); // and the cut is counted, so the persisted message can say so
  });

  it('a big read is kept WHOLE while the turn fits the budget (nothing is cut when room remains)', async () => {
    const t = rig();
    await t.read(1);
    const rec = t.bridge.takeLedger('r1');
    expect(rec.records[0].args).toMatchObject({ i: 1 });
    expect(rec.truncated).toBe(0);
  });

  it('under pressure the OLDEST big reads are shrunk to a marker first, the newest stay whole, and the cut is counted', async () => {
    const t = rig();
    for (let i = 0; i < 300; i++) await t.read(i, 16); // ~4.8 MiB of reads: over the 4 MiB budget
    const { records, truncated } = t.bridge.takeLedger('r1');
    expect(truncated).toBeGreaterThan(0);
    expect(records[0].args).toEqual({ _truncated: 'input not kept' });
    expect(records[0].toolCallId).toBe('r0');
    expect(records[records.length - 1].args).toMatchObject({ i: 299 });
  });

  it('a small read is kept whole', async () => {
    const t = rig();
    await t.read(1, 1);
    expect(t.bridge.takeLedger('r1').records[0].args).toMatchObject({ i: 1 });
  });

  it('writes up to the record cap are all kept: reads are evicted, never writes', async () => {
    const t = rig();
    for (let i = 0; i < 60; i++) await t.read(i, 1);
    for (let i = 0; i < 400; i++) await t.write(i); // the dispatcher caps a turn at 400 calls
    const { records } = t.bridge.takeLedger('r1');
    expect(records.filter((r) => r.name === 'send_email')).toHaveLength(400);
    expect(records.length).toBeLessThanOrEqual(512);
  });

  it('more writes than the room kept for them: older READS make room, every write stays', async () => {
    const t = rig();
    for (let i = 0; i < 448; i++) await t.read(i, 1);
    for (let i = 0; i < 100; i++) await t.write(i);
    const { records } = t.bridge.takeLedger('r1');
    expect(records.filter((r) => r.name === 'send_email')).toHaveLength(100);
    expect(records.length).toBeLessThanOrEqual(512);
  });

  it('eviction never takes a write: with 50 early writes and then more writes than fit, the early ones are still there', async () => {
    const t = rig();
    for (let i = 0; i < 50; i++) await t.write(`early${i}` as unknown as number);
    for (let i = 0; i < 500; i++) await t.read(i, 1);
    for (let i = 0; i < 100; i++) await t.write(i);
    const writes = t.bridge.takeLedger('r1').records.filter((r) => r.name === 'send_email');
    expect(writes).toHaveLength(150);
    expect(writes.slice(0, 50).every((r) => String(r.args.to).startsWith('pearly'))).toBe(true);
  });

  it('a write is never dropped for size either: when the byte budget is spent, its text is cut instead', async () => {
    const t = rig(60); // every write returns 60 KB
    for (let i = 0; i < 80; i++) await t.write(i); // 80 x 60 KB is more than the 4 MiB the ledger may hold
    const { records, truncated } = t.bridge.takeLedger('r1');
    expect(records.filter((r) => r.name === 'send_email')).toHaveLength(80);
    expect(truncated).toBeGreaterThan(0);
    expect(records[79].toolMessageContent.length).toBeLessThan(5_000);
  });

  it('reads may fill the whole budget like on main; a later write still gets its record (older reads give way)', async () => {
    const t = rig();
    for (let i = 0; i < 520; i++) await t.read(i, 1);
    const { records, truncated } = t.bridge.takeLedger('r1', { clear: false });
    expect(records.length).toBe(512);
    expect(truncated).toBeGreaterThan(0);
    await t.write(1);
    const after = t.bridge.takeLedger('r1').records;
    expect(after.some((r) => r.toolCallId === 'w1')).toBe(true);
    expect(after.length).toBeLessThanOrEqual(512);
  });
});

describe('ledger: an executed write always leaves a record (SF4)', () => {
  it('389 junk writes with 16 KB inputs, then a real write: the real one is recorded (a stub at worst), and counted', async () => {
    const t = rig();
    const write = (i: number, kb: number) => t.writeWith(i, kb);
    for (let i = 0; i < 389; i++) await write(i, 16);
    await write(9999, 16);
    const { records, truncated } = t.bridge.takeLedger('r1');
    expect(records.some((r) => r.toolCallId === 'w9999' && r.kind === 'executed')).toBe(true);
    expect(truncated).toBeGreaterThan(0);
  });
});
