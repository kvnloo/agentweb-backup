/**
 * ENG-2110 PR 1c-i: runs ONE turn on the login host the way the host's contract requires.
 *
 *  - `EBUSY` (host or connection full, or draining for a deploy) and a connection that was never established (the worker is restarting) are
 *    retried with jittered backoff until `busyWaitMs` runs out. Neither admitted anything, so a deploy never fails a turn that was only starting.
 *  - The turn lease (host default 30 s) is renewed on a timer. A renew the host cannot answer twice in a
 *    row ends the turn here; "turn not found" / "stale epoch" mean it is already over or fenced, so the
 *    timer just stops.
 *  - An abort signal interrupts the turn, then drops the stream if the host does not finish in `abortGraceMs`.
 *  - Never runs a turn twice. If no usable answer arrived the same idempotency key is asked ONCE: a host that
 *    already has the key reports "unknown outcome" (its events cannot be replayed); a host that did not
 *    admit it runs it now. A stream that ends without a `result` is also "unknown outcome". The caller must
 *    treat unknown as unknown (reconcile or pause), never as failure and never retry under a new key.
 */
import type { ProviderEvent } from "../../loginHost/adapter";
import type { RouteInput } from "../../loginHost/protocol";
import { LoginHostError, type LoginHostClient, type TurnStream } from "./loginHostClient";

export type ResultEvent = Extract<ProviderEvent, { type: "result" }>;

export type HostTurnOutcome =
  | { kind: "completed"; result: ResultEvent }
  /** The turn may have run (or still be running); its output is lost. `status` is the host's view when it gave one. */
  | { kind: "unknown_outcome"; reason: "duplicate" | "stream_dropped"; status?: "running" | "finished" | "failed" | "aborted" };

export interface HostTurnOptions {
  signal?: AbortSignal;
  /** Called for each event as it arrives (nothing is buffered). A throw interrupts the turn, drops the stream and propagates. */
  onEvent?: (event: ProviderEvent) => void | Promise<void>;
  /** How long to keep retrying EBUSY / a worker that is restarting. Default 40 s (a deploy's restart window is well inside it). */
  busyWaitMs?: number;
  /** Default 10 s; after the first renew it follows the host's `leaseMs / 3`. */
  renewEveryMs?: number;
  /** After an abort, how long the host gets to finish before the stream is dropped. Default 10 s. */
  abortGraceMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const MIN_RENEW_MS = 1_000;
const MAX_RENEW_MS = 10_000;
const BUSY_BASE_MS = 250;
const BUSY_MAX_MS = 2_000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/** Resolves when `p` does or when the signal aborts, whichever is first (the loser is left to finish by itself). */
function abortable(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(); // an abort that already happened never fires its event again
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void p.then(done, done);
  });
}

async function admit(client: LoginHostClient, req: RouteInput<"turn.run">, opts: HostTurnOptions): Promise<TurnStream> {
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const deadline = Date.now() + (opts.busyWaitMs ?? 40_000);
  let delay = BUSY_BASE_MS;
  let probed = false;
  for (;;) {
    if (opts.signal?.aborted) throw new LoginHostError("EBUSY", "aborted_while_waiting");
    try {
      return await client.turnRun(req, { signal: opts.signal });
    } catch (err) {
      if (!(err instanceof LoginHostError)) throw err;
      // `busy`: the host is full or draining for a deploy. `notSent`: it is restarting (a deploy swaps the build in seconds). Neither admitted anything.
      if (err.busy || err.notSent) {
        if (Date.now() + delay > deadline) throw err;
        await abortable(sleep(delay * (0.5 + random() / 2)), opts.signal); // A3: a Stop during the wait for a free slot ends it now, not when the sleep does
        delay = Math.min(delay * 2, BUSY_MAX_MS);
        continue;
      }
      // No usable answer: the host may have admitted the turn. Ask once more with the same key (see file header).
      if (err.ambiguous && !probed) {
        probed = true;
        continue;
      }
      throw err;
    }
  }
}

export async function runHostTurn(client: LoginHostClient, req: RouteInput<"turn.run">, opts: HostTurnOptions = {}): Promise<HostTurnOutcome> {
  const stream = await admit(client, req, opts);
  if (stream.duplicate) {
    stream.close();
    return { kind: "unknown_outcome", reason: "duplicate", ...(stream.status ? { status: stream.status } : {}) };
  }

  const ids = { connectionId: req.connectionId, turnId: req.turnId, epoch: req.epoch };
  const sleep = opts.sleep ?? realSleep;
  let stopped = false;
  let wake!: () => void;
  const stopSignal = new Promise<void>((resolve) => (wake = resolve));
  let renewEvery = Math.min(Math.max(opts.renewEveryMs ?? MAX_RENEW_MS, MIN_RENEW_MS), MAX_RENEW_MS);
  let interrupting: Promise<void> | undefined;

  const interrupt = (): Promise<void> => {
    interrupting ??= client.turnInterrupt(ids).then(
      () => undefined,
      () => undefined, // gone or fenced already, or the host is unreachable: the lease lapse ends the turn
    );
    return interrupting;
  };

  // Lease renewal. Its own loop (not setInterval) so a slow renew never overlaps the next one. The first renew is
  // immediate: it teaches us the host's real lease (a host may be configured far below the 30 s default) before any wait.
  const renewLoop = (async () => {
    let failures = 0;
    let first = true;
    while (!stopped) {
      if (!first) await Promise.race([sleep(renewEvery), stopSignal]);
      first = false;
      if (stopped) return;
      try {
        const { leaseMs } = await client.turnRenew(ids);
        failures = 0;
        renewEvery = Math.min(Math.max(Math.floor(leaseMs / 3), MIN_RENEW_MS), MAX_RENEW_MS);
      } catch (err) {
        if (err instanceof LoginHostError && (err.code === "ENOTFOUND" || err.code === "ESTALE")) return; // the turn is over or fenced
        if (++failures >= 2) {
          // Cut the stream NOW and send the interrupt alongside. Waiting for the interrupt first would hold the caller for as long as the
          // dead link takes to fail it, while the worker has already ended the turn (the lease lapses after ~30 s).
          void interrupt();
          stream.close();
          return;
        }
      }
    }
  })();

  let graceTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    void interrupt();
    graceTimer = setTimeout(() => stream.close(), opts.abortGraceMs ?? 10_000);
    graceTimer.unref?.();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let result: ResultEvent | undefined;
    const it = stream.events[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<ProviderEvent>;
      try {
        next = await it.next();
      } catch (err) {
        // Only a failure while READING the stream is "the connection dropped". If the final answer already arrived, it stands.
        if (err instanceof LoginHostError && err.ambiguous) return result ? { kind: "completed", result } : { kind: "unknown_outcome", reason: "stream_dropped" };
        throw err;
      }
      if (next.done) break;
      const ev = next.value;
      if (ev.type === "result") result = ev;
      try {
        await opts.onEvent?.(ev);
      } catch (err) {
        // The caller's own failure is theirs to see: never folded into "outcome unknown".
        await interrupt();
        stream.close();
        throw err;
      }
    }
    return result ? { kind: "completed", result } : { kind: "unknown_outcome", reason: "stream_dropped" };
  } finally {
    stopped = true;
    wake();
    if (graceTimer) clearTimeout(graceTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    stream.close();
    void renewLoop; // never awaited: a renew still in flight must not hold the caller (the loop swallows its own errors)
  }
}
