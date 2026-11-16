import { monitorEventLoopDelay, performance } from "perf_hooks";
import type { ProviderEvent } from "../../adapter";
import { makeRig, TOOLS, type Rig } from "./rig";
import type { ToolDef } from "../../protocol";

export interface RunReport {
  events: ProviderEvent[];
  result?: ProviderEvent;
  wallMs: number;
  /** ms of event loop busy time (ELU.active) over the run */
  busyMs: number;
  maxStallMs: number;
  p99DelayMs: number;
  meterRemaining: number;
  meterExhausted: boolean;
  logs: Rig["logs"];
  killCalls: number;
  cpuMs: number;
  /** ms spent (unmetered by the host) stringifying + encoding events the way server.ts streamTurn does */
  consumerMs: number;
}

/** Runs one hostile turn through the REAL adapter and relay; returns measurements. `onEvent` can answer tool-calls. */
export async function runTurn(rig: Rig, script: string, opts: { tools?: ToolDef[]; maxMs?: number; onEvent?: (e: ProviderEvent, answer: (content: string, extra?: Record<string, unknown>) => boolean) => void; callTimeoutMs?: number } = {}): Promise<RunReport> {
  rig.script(script);
  const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
  const events: ProviderEvent[] = [];
  const timer = setTimeout(() => void session.close(), opts.maxMs ?? 30_000);
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  let maxStall = 0;
  let consumerMs = 0;
  let last = performance.now();
  const hb = setInterval(() => {
    const n = performance.now();
    maxStall = Math.max(maxStall, n - last - 5);
    last = n;
  }, 5);
  const elu0 = performance.eventLoopUtilization();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let report: RunReport | undefined;
  try {
    for await (const ev of session.turn({ turnId: "t" + Math.floor(Math.random() * 1e9), prompt: "go", model: "sonnet", relay: { tools: opts.tools ?? TOOLS, callTimeoutMs: () => opts.callTimeoutMs ?? 20_000 } })) {
      events.push(ev);
      { const c0 = performance.now(); const line = JSON.stringify(ev) + "\n"; Buffer.from(line); consumerMs += performance.now() - c0; }
      opts.onEvent?.(ev, (content, extra) => (ev.type === "tool-call" ? session.answer(ev.operationId, { kind: "tool-result", ok: true, content, ...(extra ?? {}) }) !== false : false));
    }
  } finally {
    clearTimeout(timer);
    const wallMs = performance.now() - t0;
    const elu = performance.eventLoopUtilization(elu0);
    const cpu = process.cpuUsage(cpu0);
    h.disable();
    clearInterval(hb);
    const meter = (session as unknown as { meter: { remaining: number; exhausted: boolean } }).meter;
    report = {
      events,
      result: events.find((e) => e.type === "result"),
      wallMs,
      busyMs: elu.active,
      maxStallMs: maxStall,
      p99DelayMs: h.percentile(99) / 1e6,
      meterRemaining: meter.remaining,
      meterExhausted: meter.exhausted,
      logs: rig.logs.slice(),
      killCalls: rig.killCalls,
      cpuMs: (cpu.user + cpu.system) / 1000,
      consumerMs,
    };
    await session.close();
  }
  return report!;
}
export { makeRig, TOOLS };
