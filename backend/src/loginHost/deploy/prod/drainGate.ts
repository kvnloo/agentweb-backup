/**
 * ENG-2110: the deploy's idle gate. A worker deploy must never cut off a customer, so before anything on the worker changes the host is asked to stop
 * taking NEW work (`host.drain`) at a moment when nothing is running, and the deploy waits for that moment instead of forcing it.
 *
 * Every `pollSec` it asks for a STRICT drain: that only succeeds when no turn is running and nobody is mid sign-in, and then the host refuses all new
 * turns and sign-ins (the backend retries those, see runHostTurn) until the restart. After `totalSec` it gives up: drain off, report "not idle". The
 * deploy is then cancelled with NOTHING changed and can simply run again later. It NEVER falls back to restarting a host that is serving someone
 * (`--force` is a separate, loud, human decision). A host that is still starting up (socket missing or refusing) counts as "not yet", not as a failure.
 *
 * The drain expires by itself, so a deploy that dies half-way cannot leave the host refusing work. Pure logic: the host call, the clock and the sleep are
 * injected (tested with a real host server in __tests__/deploy/drainGate.test.ts).
 */
export interface DrainReply {
  mode: "off" | "strict";
  running: number;
  signIns: number;
  ok: boolean;
}

export interface GateDeps {
  drain(mode: "off" | "strict", ttlSec: number): Promise<DrainReply>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface GateOptions {
  pollSec: number;
  totalSec: number;
  /** How long the strict state lasts if the restart never comes (it must outlive the switch, restart and health check). */
  strictTtlSec: number;
}

export const DEFAULT_GATE: GateOptions = { pollSec: 3, totalSec: 1800, strictTtlSec: 300 };

export type GateResult = { result: "acquired"; waitedSec: number } | { result: "not_idle"; running: number; signIns: number; waitedSec: number };

/** An error that means "the host is not listening (yet)": a restart in progress or a host that has just started. */
export const isNotReady = (e: unknown): boolean => (e as { notReady?: boolean } | undefined)?.notReady === true;

export async function acquireIdle(opts: GateOptions, deps: GateDeps): Promise<GateResult> {
  const start = deps.now();
  const elapsedSec = () => Math.floor((deps.now() - start) / 1000);
  let last = "";
  let running = 0;
  let signIns = 0;
  for (;;) {
    let status: string;
    try {
      const r = await deps.drain("strict", opts.strictTtlSec);
      if (r.ok) {
        deps.log(`idle after ${elapsedSec()}s: the host now refuses new work until it restarts`);
        return { result: "acquired", waitedSec: elapsedSec() };
      }
      running = r.running;
      signIns = r.signIns;
      status = `${r.running} turn(s) running, ${r.signIns} sign-in(s) in progress`;
    } catch (e) {
      if (!isNotReady(e)) throw e;
      status = "the host is not listening yet";
    }
    if (status !== last) deps.log(`waiting for the host to be idle: ${status}`);
    last = status;
    if (elapsedSec() >= opts.totalSec) {
      await deps.drain("off", 10).catch(() => undefined);
      deps.log(`gave up after ${elapsedSec()}s: still ${status}. Nothing was changed or restarted; run the deploy again later`);
      return { result: "not_idle", running, signIns, waitedSec: elapsedSec() };
    }
    await deps.sleep(opts.pollSec * 1000);
  }
}

export interface InfoDeps {
  info(): Promise<{ protocol: number; drain?: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

/** After the restart: the new build answers with ITS protocol version and a clean (undrained) state. Anything else for `timeoutSec` is a failed deploy. (`any`: after a ROLLBACK the old build answers, whatever protocol it speaks.) */
export async function waitHealthy(expectProtocol: number | "any", timeoutSec: number, deps: InfoDeps): Promise<boolean> {
  const deadline = deps.now() + timeoutSec * 1000;
  let lastErr = "no answer yet";
  for (;;) {
    try {
      const i = await deps.info();
      if ((expectProtocol === "any" || i.protocol === expectProtocol) && (i.drain ?? "off") === "off") return true;
      lastErr = `host answers protocol ${i.protocol} drain ${i.drain ?? "?"}, expected protocol ${expectProtocol} drain off`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message.slice(0, 80) : "error";
    }
    if (deps.now() >= deadline) {
      deps.log(`not healthy after ${timeoutSec}s: ${lastErr}`);
      return false;
    }
    await deps.sleep(1000);
  }
}
