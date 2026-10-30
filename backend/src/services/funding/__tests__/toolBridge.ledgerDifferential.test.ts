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
