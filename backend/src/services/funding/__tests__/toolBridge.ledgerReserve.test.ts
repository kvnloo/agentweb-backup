/**
 * ENG-2113 (security review S8): the ledger has caps (512 records, 4 MiB). With ~260 reads of 16 KB inputs the byte budget was used up and a LATER write (a
 * send_email that DID execute) was absent from the persisted record. Reads now give way to writes.
 */
import { ToolBridge, type BridgeExecuteOutcome, type ToolBridgeDeps } from '../toolBridge';
import { mapLedgerToResponseMessages } from '../claudeTurnMessages';

function rig(writeKb = 0) {
  const executed: string[] = [];
  const deps = {
    resolveTools: async () => [{ name: 'read_it' }, { name: 'send_email' }],
    isReadOnly: (n: string) => n === 'read_it',
    isLive: async () => true,
    execute: async (_r: unknown, c: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
      executed.push(c.name);
      return { content: c.name === 'send_email' && writeKb ? 'w'.repeat(writeKb * 1024) : `${c.name} ok`, isError: false, requiresConfirmation: false, toolsChanged: false, ...(c.name === 'read_it' ? { result: { rows: 'r'.repeat(6 * 1024) } } : {}) };
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

describe('ledger: stubs, shrunk results and the bridge\'s own record of what ran', () => {
  it('SF4: when even the overflow is spent (400 writes with 20 KB inputs) a later executed write keeps a STUB record: id, name, kind, marker input, short text', async () => {
    const t = rig();
    for (let i = 0; i < 390; i++) await t.writeWith(i, 20);
    await t.writeWith(9999, 20);
    const rec = t.bridge.takeLedger('r1').records.find((r) => r.toolCallId === 'w9999')!;
    expect(rec).toMatchObject({ name: 'send_email', kind: 'executed', args: { _truncated: 'input not kept' } });
    expect(rec.toolMessageContent.length).toBeLessThan(700);
    expect(rec.result).toBeUndefined();
  });

  it('a read shrunk under pressure also loses its raw result (the size count includes it)', async () => {
    const t = rig();
    for (let i = 0; i < 300; i++) await t.read(i, 12); // 12 KB input + 6 KB raw result each: over the budget
    const records = t.bridge.takeLedger('r1').records;
    expect(records[0].args).toEqual({ _truncated: 'input not kept' });
    expect(records[0].result).toBeUndefined();
    expect(records[records.length - 1].result).toBeDefined(); // the newest stay whole
  });

  it('ranCall: true for a call that ran, false for one the bridge refused, and independent of the record being cut', async () => {
    const t = rig();
    await t.read(1, 1);
    await t.bridge.callTool(t.token, { name: 'nope_not_a_tool', args: {}, callId: 'ref1' }).catch(() => undefined);
    expect(t.bridge.ranCall('r1', 'r1')).toBe(true);
    expect(t.bridge.ranCall('r1', 'ref1')).toBe(false);
    expect(t.bridge.ranCall('r1', 'never-seen')).toBe(false);
    for (let i = 0; i < 390; i++) await t.writeWith(i, 20);
    await t.writeWith(9999, 20);
    expect(t.bridge.ranCall('r1', 'w9999')).toBe(true);
  });
});

describe('ledger: a hard ceiling, and `truncated` counts only what was really lost', () => {
  it('1200 tiny writes (the HTTP path has no per-run call cap): every one is kept and nothing is counted as lost', async () => {
    const t = rig();
    for (let i = 0; i < 1200; i++) await t.write(i);
    const { records, truncated } = t.bridge.takeLedger('r1');
    expect(records.filter((r) => r.name === 'send_email')).toHaveLength(1200);
    expect(truncated).toBe(0);
  });

  it('1500 writes with 60 KB results: memory stays bounded (the oldest are cut to stubs, then evicted, counted) and every executed call is still known to ranCall', async () => {
    const t = rig(60);
    for (let i = 0; i < 1500; i++) await t.write(i);
    for (const i of [0, 1, 700, 1499]) expect(t.bridge.ranCall('r1', `w${i}`)).toBe(true);
    const { records, truncated } = t.bridge.takeLedger('r1');
    const bytes = records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024 + 2 * 1024 * 1024 + 64 * 1024);
    expect(records.length).toBeLessThanOrEqual(2048);
    expect(records[records.length - 1].toolCallId).toBe('w1499'); // the newest write is whole enough to name itself
    expect(truncated).toBeGreaterThan(0);
  });

  it('a read that was shrunk and then dropped under pressure is counted ONCE', async () => {
    const t = rig();
    for (let i = 0; i < 40; i++) await t.read(i, 200); // 200 KB inputs: 8 MB of reads: the oldest are shrunk, then dropped
    const { records, truncated } = t.bridge.takeLedger('r1');
    const gone = 40 - records.length;
    const shrunk = records.filter((r) => r.args && (r.args as { _truncated?: string })._truncated).length;
    expect(truncated).toBe(gone + shrunk); // each cut or dropped record exactly once
  });

  it('a big NEW read arriving under byte pressure shrinks itself instead of being dropped (M18)', async () => {
    const t = rig();
    for (let i = 0; i < 20; i++) await t.read(i, 7); // small enough to stay whole
    // fill most of the budget with writes (never shrunk), then a big read must self-shrink to fit
    const w = rig(60);
    for (let i = 0; i < 60; i++) await w.write(i); // ~3.6 MiB of writes
    await w.read(99, 600);
    const rec = w.bridge.takeLedger('r1').records.find((r) => r.toolCallId === 'r99');
    expect(rec).toBeDefined();
    expect(rec!.args).toEqual({ _truncated: 'input not kept' });
  });

  it('at the record ceiling the OLDEST records are evicted (counted), the newest stay, and ranCall still knows every call that ran', async () => {
    const t = rig();
    for (let i = 0; i < 2200; i++) await t.write(i);
    const { records, truncated } = t.bridge.takeLedger('r1');
    expect(records).toHaveLength(2048);
    expect(records[0].toolCallId).toBe('w152');
    expect(records[records.length - 1].toolCallId).toBe('w2199');
    expect(truncated).toBe(152);
    for (const i of [0, 151, 152, 2199]) expect(t.bridge.ranCall('r1', `w${i}`)).toBe(true);
  });

  it('a read shrunk and later dropped is ONE lost record: truncated equals the reads that are not intact', async () => {
    const t = rig();
    for (let i = 0; i < 450; i++) await t.read(i, 12); // over the byte budget: the oldest big reads are shrunk
    for (let i = 0; i < 150; i++) await t.write(i); // and the record count makes the oldest reads (shrunk ones) go
    const { records, truncated } = t.bridge.takeLedger('r1');
    const intactReads = records.filter((r) => r.name === 'read_it' && !(r.args as { _truncated?: string })._truncated).length;
    expect(truncated).toBe(450 - intactReads);
  });

  it('a read that cannot fit even after shrinking itself is counted once (shrunk, then dropped)', async () => {
    const t = rig();
    for (let i = 0; i < 512; i++) await t.write(i); // the record count is spent by writes
    await t.read(1, 20);
    expect(t.bridge.takeLedger('r1').truncated).toBe(1);
  });
});

describe('answerSuffix reaches the model and is never persisted (parity: Emma does not persist the Installed Skills block)', () => {
  it('the model answer has the suffix; the ledger record, answeredContent and the persisted tool message do not', async () => {
    const deps = {
      resolveTools: async () => [{ name: 'install_skills' }],
      isReadOnly: () => false,
      isLive: async () => true,
      execute: async (): Promise<BridgeExecuteOutcome> => ({ content: 'Installed 1', isError: false, requiresConfirmation: false, toolsChanged: false, answerSuffix: '\n\nSUFFIX-TEXT' }),
    };
    const bridge = new ToolBridge(deps as unknown as ToolBridgeDeps);
    const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'c1', epoch: 1 });
    bridge.beginTurn('u1', 's1');
    const answer = await bridge.callTool(token, { name: 'install_skills', args: {}, callId: 'c1' });
    expect(answer.content).toBe('Installed 1\n\nSUFFIX-TEXT');
    const { records } = bridge.takeLedger('r1');
    expect(records[0].toolMessageContent).toBe('Installed 1');
    expect(records[0].answeredContent).toBeUndefined();
    const mapped = mapLedgerToResponseMessages({ ledger: records, finalText: 'done', llm: 'm' });
    const tool = mapped.responseMessages.find((m: any) => m.role === 'tool');
    expect(tool.content).toBe('Installed 1');
    expect(JSON.stringify(mapped.responseMessages)).not.toContain('SUFFIX-TEXT');
  });

  it('an identical repeat or a joiner is never handed the suffix either', async () => {
    let n = 0;
    const deps = {
      resolveTools: async () => [{ name: 'install_skills' }],
      isReadOnly: () => false,
      isLive: async () => true,
      isStrictEffect: () => true,
      execute: async (): Promise<BridgeExecuteOutcome> => (n++, { content: 'Installed 1', isError: false, requiresConfirmation: false, toolsChanged: false, answerSuffix: '\n\nSUFFIX-TEXT' }),
    };
    const bridge = new ToolBridge(deps as unknown as ToolBridgeDeps);
    const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'c1', epoch: 1 });
    bridge.beginTurn('u1', 's1');
    const first = await bridge.callTool(token, { name: 'install_skills', args: { a: 1 }, callId: 'c1' });
    const again = await bridge.callTool(token, { name: 'install_skills', args: { a: 1 }, callId: 'c2' });
    expect(first.content).toContain('SUFFIX-TEXT');
    expect(again.content).not.toContain('SUFFIX-TEXT');
    expect(JSON.stringify(bridge.takeLedger('r1').records)).not.toContain('SUFFIX-TEXT');
  });
});

describe('ledger: the binding limit decides the remedy (count: evict; bytes: cut), each record counted once', () => {
  it('3,000 tiny writes: the 2,048 newest are kept WHOLE (no stub), 952 oldest evicted, truncated is exactly 952', async () => {
    const t = rig();
    for (let i = 0; i < 3000; i++) await t.write(i);
    const { records, truncated } = t.bridge.takeLedger('r1');
    expect(records).toHaveLength(2048);
    expect(truncated).toBe(952);
    expect(records.every((r) => (r.args as { _truncated?: string })._truncated === undefined)).toBe(true);
    expect(records[0].toolCallId).toBe('w952');
  });

  it('a WRITE arriving when the record count binds drops the oldest read and shrinks nothing else', async () => {
    const t = rig();
    for (let i = 0; i < 60; i++) await t.read(i, 9);
    for (let i = 0; i < 452; i++) await t.read(1000 + i, 0.1); // 512 records, bytes well inside the budget
    await t.write(1);
    const { records, truncated } = t.bridge.takeLedger('r1');
    const bigIntact = records.filter((r) => r.name === 'read_it' && (r.args as { i: number }).i < 60 && (r.args as { _truncated?: string })._truncated === undefined).length;
    expect(bigIntact).toBe(59); // only the oldest read went; the other big reads were not touched
    expect(truncated).toBe(1);
    expect(records.some((r) => r.toolCallId === 'w1')).toBe(true);
  });

  it('with the 512-record limit binding (tiny reads), big old reads are NOT shrunk: nothing is lost except the reads that do not fit', async () => {
    const t = rig();
    for (let i = 0; i < 60; i++) await t.read(i, 9); // 60 big reads (the rig adds a 6 KB raw result to each read): whole
    for (let i = 0; i < 500; i++) await t.read(1000 + i, 0.1); // small reads fill the record count
    const { records, truncated } = t.bridge.takeLedger('r1');
    const bigIntact = records.filter((r) => r.name === 'read_it' && (r.args as { i: number }).i < 60 && (r.args as { _truncated?: string })._truncated === undefined).length;
    expect(bigIntact).toBe(60);
    expect(records).toHaveLength(512);
    expect(truncated).toBe(560 - 512);
  });
});

describe('ranCall keeps the LATEST ids', () => {
  it('after 4,200 calls the newest are known to have run and the oldest have aged out (the cap is 4,096)', async () => {
    const t = rig();
    for (let i = 0; i < 4200; i++) await t.read(i, 0.01);
    expect(t.bridge.ranCall('r1', 'r4199')).toBe(true);
    expect(t.bridge.ranCall('r1', 'r4100')).toBe(true);
    expect(t.bridge.ranCall('r1', 'r0')).toBe(false);
  });
});

describe('answerSuffix is never given to a confirmation preview', () => {
  it('a call that asks for the user\'s confirmation is answered with its own text only, whatever the executor offers', async () => {
    const deps = {
      resolveTools: async () => [{ name: 'send_email' }],
      isReadOnly: () => false,
      isLive: async () => true,
      persistHalt: async () => undefined,
      execute: async (): Promise<BridgeExecuteOutcome> => ({ content: 'preview TOKEN', isError: false, requiresConfirmation: true, toolsChanged: false, answerSuffix: '\n\nSUFFIX-TEXT', result: { awaitingUserConfirmation: true } }),
    };
    const bridge = new ToolBridge(deps as unknown as ToolBridgeDeps);
    const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'c1', epoch: 1 });
    bridge.beginTurn('u1', 's1');
    const answer = await bridge.callTool(token, { name: 'send_email', args: {}, callId: 'c1' });
    expect(answer.content).toBe('preview TOKEN');
  });
});

