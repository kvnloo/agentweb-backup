/**
 * ENG-2110: the deploy's idle gate. A worker deploy must never cut off a customer, so before the host is restarted it is asked to stop taking NEW
 * work (`host.drain`) at a moment when nothing is running, and the deploy waits for that moment instead of forcing it.
 *
 *   phase 1  every `pollSec` ask for a STRICT drain: it only succeeds when no turn is running and nobody is mid sign-in, and then it refuses all
 *            new turns and sign-ins (the backend retries those, see runHostTurn) until the restart, which takes seconds.
 *   phase 2  after `softAfterSec` (10 minutes: new sign-ins wait only if the host STAYS busy that long) also ask for a SOFT drain (new sign-ins and scheduled turns wait, interactive turns continue), so a host that is
 *            never quite idle because of background work reaches idle by itself. Soft is dropped again with the strict attempt that succeeds.
 *   timeout  after `totalSec` give up: drain off, report "not idle". The deploy is then cancelled and can simply run again later. It NEVER
 *            falls back to restarting a host that is serving someone (`--force` is a separate, loud, human decision).
 *
 * Both drain states expire on their own, so a deploy that dies half-way cannot leave the host refusing work. Pure logic: the host call, the
 * clock and the sleep are injected (tested with a real host server in __tests__/deploy/drainGate.test.ts).
 */
export interface DrainReply {
  mode: "off" | "soft" | "strict";
  running: number;
  signIns: number;
  ok: boolean;
}

export interface GateDeps {
  drain(mode: "off" | "soft" | "strict", ttlSec: number): Promise<DrainReply>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface GateOptions {
  pollSec: number;
  softAfterSec: number;
  totalSec: number;
  /** How long the strict state lasts if the restart never comes. */
  strictTtlSec: number;
}

export const DEFAULT_GATE: GateOptions = { pollSec: 3, softAfterSec: 600, totalSec: 1800, strictTtlSec: 120 };

export type GateResult = { result: "acquired"; waitedSec: number } | { result: "not_idle"; running: number; signIns: number; waitedSec: number };

export async function acquireIdle(opts: GateOptions, deps: GateDeps): Promise<GateResult> {
  const start = deps.now();
  const elapsedSec = () => Math.floor((deps.now() - start) / 1000);
  let last = "";
  let soft = false;
  for (;;) {
    const r = await deps.drain("strict", opts.strictTtlSec);
    if (r.ok) {
      deps.log(`idle after ${elapsedSec()}s: the host now refuses new work until it restarts`);
      return { result: "acquired", waitedSec: elapsedSec() };
    }
    const status = `${r.running} turn(s) running, ${r.signIns} sign-in(s) in progress`;
    if (status !== last) deps.log(`waiting for the host to be idle: ${status}`);
    last = status;
    if (elapsedSec() >= opts.totalSec) {
      await deps.drain("off", 10).catch(() => undefined);
      deps.log(`gave up after ${elapsedSec()}s: still ${status}. Nothing was restarted; run the deploy again later`);
      return { result: "not_idle", running: r.running, signIns: r.signIns, waitedSec: elapsedSec() };
    }
    if (elapsedSec() >= opts.softAfterSec) {
      if (!soft) deps.log("asking the host to hold back new sign-ins and scheduled turns so it can reach idle");
      soft = true;
      // Refreshed on every poll; short on purpose, so it lapses by itself if this process dies.
      await deps.drain("soft", Math.max(30, opts.pollSec * 5));
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
