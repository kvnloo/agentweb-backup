/**
 * ENG-2113 (parity review S8): for turns that fit the ledger budget the new bridge must keep EXACTLY what origin/main kept. The same call sequences run through a
 * frozen copy of main's bridge (fixtures/toolBridge.main.ts) and the current one; the ledgers (and so the persisted messages) must be byte-identical and
 * `truncated` must stay 0. Only under pressure may the ledger differ (see toolBridge.ledgerReserve.test.ts).
 */
import { ToolBridge, type BridgeExecuteOutcome, type ToolBridgeDeps } from '../toolBridge';
import { ToolBridge as MainBridge } from './fixtures/toolBridge.main';

type Step = { tool: 'read_it' | 'send_email'; kb: number; resultKb: number; withResult?: boolean };

function build(Cls: new (d: ToolBridgeDeps) => unknown, steps: Step[]) {
  let n = 0;
  const deps = {
    resolveTools: async () => [{ name: 'read_it' }, { name: 'send_email' }],
    isReadOnly: (name: string) => name === 'read_it',
    isLive: async () => true,
    execute: async (_r: unknown, c: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
      const step = steps[n++];
      return {
        content: 'c'.repeat(Math.round(step.resultKb * 1024)),
        isError: false,
        requiresConfirmation: false,
        toolsChanged: false,
        ...(step.withResult ? { result: { rows: 'r'.repeat(Math.round(step.resultKb * 1024)), name: c.name } } : {}),
      } as BridgeExecuteOutcome;
    },
  };
  const bridge = new Cls(deps as unknown as ToolBridgeDeps) as ToolBridge;
  const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'c1', epoch: 1 });
  bridge.beginTurn('u1', 's1');
  return { bridge, token };
}

async function run(Cls: new (d: ToolBridgeDeps) => unknown, steps: Step[]) {
  const { bridge, token } = build(Cls, steps);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await bridge.callTool(token, { name: s.tool, args: { i, pad: 'x'.repeat(Math.round(s.kb * 1024)) }, callId: `c${i}` });
  }
  const { records, truncated } = bridge.takeLedger('r1');
  const norm = records.map((r) => ({ ...r, startedAt: 0, endedAt: 0, durationMs: 0 }));
  return { norm, truncated };
}

const same = (n: number, step: Step): Step[] => Array.from({ length: n }, () => step);
const mixed = (n: number, scale = 1): Step[] =>
  Array.from({ length: n }, (_, i) => ({ tool: i % 5 === 0 ? 'send_email' : 'read_it', kb: ((i * 7) % 20) * scale, resultKb: ((i * 13) % 30) * scale, withResult: i % 3 === 0 }) as Step);

const cases: Array<[string, Step[]]> = [
  ['one 5 KB read', [{ tool: 'read_it', kb: 0.2, resultKb: 5 }]],
  ['one 60 KB read', [{ tool: 'read_it', kb: 0.2, resultKb: 60 }]],
  ['one read with a 5 KB input and a raw result', [{ tool: 'read_it', kb: 5, resultKb: 5, withResult: true }]],
  ['sixty 10 KB reads', same(60, { tool: 'read_it', kb: 0.2, resultKb: 10 })],
  ['120 mixed calls', mixed(120)],
  ['400 mixed calls (sizes scaled to fit main\'s 4 MiB)', mixed(400, 0.25)],
  ['400 small calls', same(400, { tool: 'read_it', kb: 0.1, resultKb: 0.5 })],
];

describe('ledger: a turn within the budget is identical to origin/main (S8)', () => {
  it.each(cases)('%s: byte-identical ledger, nothing counted as cut', async (_name, steps) => {
    const [oldRun, newRun] = [await run(MainBridge as never, steps), await run(ToolBridge as never, steps)];
    expect(oldRun.truncated).toBe(0); // the case really is within main's budget
    expect(newRun.truncated).toBe(0);
    expect(JSON.stringify(newRun.norm)).toBe(JSON.stringify(oldRun.norm));
  });
});

/**
 * The same comparison for the behaviours the first harness does not reach: a collapse of an identical call in one announced message, a halt (a preview that
 * asks for confirmation) with the calls after it, an error, an image, and a concurrent batch. Ledgers AND halts must be byte-identical to origin/main's bridge.
 */
type Spec = { id: string; tool: 'read_it' | 'send_email'; msg?: string; confirm?: boolean; error?: boolean; image?: boolean; sameArgs?: boolean; kb?: number };

async function runSpecs(Cls: new (d: ToolBridgeDeps) => unknown, specs: Spec[], concurrent: boolean) {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const deps = {
    resolveTools: async () => [{ name: 'read_it' }, { name: 'send_email' }],
    isReadOnly: (name: string) => name === 'read_it',
    isDedupable: () => true,
    isLive: async () => true,
    persistHalt: async () => undefined,
    execute: async (_r: unknown, c: { name: string; args: Record<string, unknown>; callId?: string }): Promise<BridgeExecuteOutcome> => {
      const s = byId.get(String(c.callId))!;
      return {
        content: `${c.name} result ${s.id} ` + 'c'.repeat(Math.round((s.kb ?? 0.3) * 1024)),
        isError: s.error === true,
        requiresConfirmation: s.confirm === true,
        toolsChanged: false,
        ...(s.image ? { images: [{ mimeType: 'image/png', data: 'QUJD' }] } : {}),
        ...(s.confirm ? { result: { awaitingUserConfirmation: true, previewToken: 'tok' } } : {}),
      } as BridgeExecuteOutcome;
    },
  };
  const bridge = new Cls(deps as unknown as ToolBridgeDeps) as ToolBridge;
  const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'c1', epoch: 1 });
  bridge.beginTurn('u1', 's1');
  for (const s of specs) bridge.noteToolUse('r1', s.id, s.tool, { id: s.sameArgs ? 'same' : s.id }, s.msg);
  const call = (s: Spec) => bridge.callTool(token, { name: s.tool, args: { id: s.sameArgs ? 'same' : s.id }, callId: s.id });
  const answers = concurrent ? await Promise.all(specs.map(call)) : await specs.reduce<Promise<unknown[]>>(async (acc, s) => [...(await acc), await call(s)], Promise.resolve([]));
  const { records, truncated } = bridge.takeLedger('r1');
  // the run generation and the random group suffix of an unannounced call differ between two bridges by design
  const scrub = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/"(groupId)":"[^:"]*:/g, '"$1":"').replace(/(g\d+):[0-9a-f]{8}"/g, '$1:R"'));
  const norm = scrub(records.map((r) => ({ ...r, startedAt: 0, endedAt: 0, durationMs: 0 })));
  const halts = scrub(bridge.takeHalts('u1', 's1').map((h) => ({ ...h, haltedAt: 0 })));
  return { norm, halts, truncated, answers: scrub(answers) };
}

const specCases: Array<[string, Spec[], boolean]> = [
  ['a collapse: two identical writes announced in one message', [{ id: 'a', tool: 'send_email', msg: 'm1', sameArgs: true }, { id: 'b', tool: 'send_email', msg: 'm1', sameArgs: true }], false],
  ['a halt, then a sibling of the same message and a later read', [{ id: 'a', tool: 'send_email', msg: 'm1', confirm: true }, { id: 'b', tool: 'send_email', msg: 'm1' }, { id: 'c', tool: 'read_it', msg: 'm2' }], false],
  ['an error and an image among reads', [{ id: 'a', tool: 'read_it', error: true }, { id: 'b', tool: 'read_it', image: true }, { id: 'c', tool: 'read_it', kb: 9 }], false],
  ['a concurrent batch of one announced message (reads and a write)', [{ id: 'a', tool: 'read_it', msg: 'm1' }, { id: 'b', tool: 'read_it', msg: 'm1', kb: 10 }, { id: 'c', tool: 'send_email', msg: 'm1' }, { id: 'd', tool: 'read_it', msg: 'm1' }], true],
];

describe('ledger and halts: collapse, halt, error, image and concurrent batches are identical to origin/main', () => {
  it.each(specCases)('%s', async (_name, specs, concurrent) => {
    const [oldRun, newRun] = [await runSpecs(MainBridge as never, specs, concurrent), await runSpecs(ToolBridge as never, specs, concurrent)];
    expect(newRun.truncated).toBe(0);
    expect(JSON.stringify(newRun.norm)).toBe(JSON.stringify(oldRun.norm));
    expect(JSON.stringify(newRun.halts)).toBe(JSON.stringify(oldRun.halts));
    expect(JSON.stringify(newRun.answers)).toBe(JSON.stringify(oldRun.answers));
    expect(newRun.norm.length).toBeGreaterThan(0);
  });

  it('the cases really exercise what they name (so the identity above means something)', async () => {
    const collapse = await runSpecs(ToolBridge as never, specCases[0][1], false);
    expect(collapse.norm.map((r: any) => r.kind)).toEqual(['executed', 'collapsed']);
    const halt = await runSpecs(ToolBridge as never, specCases[1][1], false);
    expect(halt.halts).toHaveLength(1);
    expect(halt.norm.some((r: any) => r.kind === 'refused')).toBe(true);
    const mixed = await runSpecs(ToolBridge as never, specCases[2][1], false);
    expect(mixed.norm.some((r: any) => r.isError)).toBe(true);
    expect(mixed.answers.some((a: any) => a.images?.length)).toBe(true);
  });
});
