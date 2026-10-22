/**
 * ENG-2110 PR 1c-i: the backend's login-host client and turn runner, driven against the REAL host server
 * (src/loginHost) over a real unix socket with the scripted fake provider. These protect the host's contract:
 * the turn lease must be renewed, EBUSY retried, a turn never run twice, and an unknown outcome never reported as a result.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProviderEvent } from "../../../loginHost/adapter";
import { startHostServer, type HostServerHandle } from "../../../loginHost/server";
import { makeRig, turnReq, type Rig } from "../../../loginHost/__tests__/helpers";
import { LoginHostClient, LoginHostError, UnixSocketTransport, type HostTransport, type StreamReply } from "../loginHostClient";
import { runHostTurn } from "../loginHostTurn";

const noSleep = () => Promise.resolve();

describe("login host client", () => {
  let rig: Rig;
  let dir: string;
  let sock: string;
  let handle: HostServerHandle;
  let client: LoginHostClient;
  let transport: UnixSocketTransport;

  async function boot(config: Parameters<typeof makeRig>[0] = {}) {
    rig = makeRig(config);
    dir = mkdtempSync(join(tmpdir(), "lh-client-"));
    sock = join(dir, "host.sock");
    handle = await startHostServer(rig.mgr, { socketPath: sock, socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 });
    transport = new UnixSocketTransport(sock);
    client = new LoginHostClient(transport);
  }
  async function signIn(connectionId = "c1") {
    const start = await client.loginStart({ connectionId, provider: "fake" });
    await client.loginComplete({ connectionId, loginRef: start.loginRef, code: "abcdefgh#12345678" });
    await client.loginPromote({ connectionId, loginRef: start.loginRef, epoch: 1 });
  }
  afterEach(async () => {
    await handle?.close();
    rig?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe("calls", () => {
    beforeEach(() => boot());

    it("signs in, reports status and revokes through the host", async () => {
      const start = await client.loginStart({ connectionId: "c1", provider: "fake" });
      expect(start).toMatchObject({ ceremony: "paste_code", url: "https://example.test/authorize" });
      expect(await client.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" })).toMatchObject({ status: "ready", planLabel: "max" });
      expect(await client.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 })).toEqual({ state: "active", epoch: 1 });
      expect(await client.connectionStatus({ connectionId: "c1" })).toMatchObject({ state: "active", epoch: 1, runningTurns: 0 });
      const revoked = await client.connectionRevoke({ connectionId: "c1", epoch: 2 });
      expect(revoked).toMatchObject({ state: "revoked", epoch: 2, cleanupConfirmed: true });
    });

    it("maps host errors to a code and never echoes the body", async () => {
      await expect(client.connectionStatus({ connectionId: "nope" })).rejects.toMatchObject({ name: "LoginHostError", code: "ENOTFOUND" });
      await signIn();
      await expect(client.connectionEnable({ connectionId: "c1", epoch: 2 })).rejects.toMatchObject({ code: "ESTALE" });
    });

    it("refuses a field the host would refuse, before any round trip", async () => {
      const spy = jest.spyOn(transport, "json");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately wrong input
      await expect(client.loginStart({ connectionId: "c1", provider: "fake", homeDir: "/etc" } as any)).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
    });

    it("treats a non-host answer as BAD_RESPONSE and an absent socket as UNREACHABLE", async () => {
      const odd: HostTransport = { json: async () => ({ status: 500, json: { error: "<script>alert(1)</script>" } }), stream: async () => { throw new Error("n/a"); } };
      await expect(new LoginHostClient(odd).connectionStatus({ connectionId: "c1" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
      const wrongShape: HostTransport = { json: async () => ({ status: 200, json: { state: 7 } }), stream: odd.stream };
      await expect(new LoginHostClient(wrongShape).connectionStatus({ connectionId: "c1" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
      const gone = new LoginHostClient(new UnixSocketTransport(join(dir, "missing.sock")));
      const err = await gone.connectionStatus({ connectionId: "c1" }).catch((e) => e);
      expect(err).toBeInstanceOf(LoginHostError);
      expect(err).toMatchObject({ code: "UNREACHABLE" });
      expect(err.ambiguous).toBe(true);
    });
  });

  describe("turns", () => {
    it("streams events to the caller and returns the result", async () => {
      await boot();
      await signIn();
      const seen: string[] = [];
      const out = await runHostTurn(client, turnReq("c1", 1), { onEvent: (e) => void seen.push(e.type), sleep: noSleep });
      expect(out).toMatchObject({ kind: "completed", result: { type: "result", ok: true, text: "hi" } });
      expect(seen).toEqual(["text", "result"]);
    });

    it("retries EBUSY until the host has room, with the same idempotency key", async () => {
      await boot({ config: { maxTurnsPerHost: 1 } });
      await signIn("c1");
      await signIn("c2");
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const first = turnReq("c1", 1);
      const running = runHostTurn(client, first, { sleep: noSleep });
      await waitFor(() => rig.script.activeTurns === 1);
      let slept = 0;
      const second = turnReq("c2", 1);
      const waiting = runHostTurn(client, second, {
        busyWaitMs: 60_000,
        random: () => 1,
        sleep: async () => {
          if (++slept === 3) await client.turnInterrupt({ connectionId: "c1", turnId: first.turnId, epoch: 1 }); // makes room
          await new Promise((r) => setTimeout(r, 20));
        },
      });
      rig.script.turnEvents = [{ type: "result", ok: true, text: "second" }];
      expect(await waiting).toMatchObject({ kind: "completed", result: { text: "second" } });
      expect(slept).toBeGreaterThanOrEqual(3);
      await running;
    });

    it("gives up on EBUSY when the wait is over", async () => {
      await boot({ config: { maxTurnsPerHost: 1 } });
      await signIn("c1");
      await signIn("c2");
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
      const first = turnReq("c1", 1);
      const running = runHostTurn(client, first, { sleep: noSleep });
      await waitFor(() => rig.script.activeTurns === 1);
      await expect(runHostTurn(client, turnReq("c2", 1), { busyWaitMs: 400, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })).rejects.toMatchObject({ code: "EBUSY" });
      await client.turnInterrupt({ connectionId: "c1", turnId: first.turnId, epoch: 1 });
      await running;
    });

    describe("a deploy never fails a customer's turn", () => {
      const turnRecords = () => Object.keys(rig.store.get().idempotency).filter((k) => k.startsWith("turn:")).length;

      it("a turn that starts while the host drains is held back, then runs exactly once under the same key when the drain lifts", async () => {
        await boot();
        await signIn();
        rig.mgr.setDrain({ mode: "strict" });
        let slept = 0;
        const out = runHostTurn(client, turnReq("c1", 1), {
          busyWaitMs: 60_000,
          random: () => 1,
          sleep: async () => {
            if (++slept === 2) rig.mgr.setDrain({ mode: "off" }); // the deploy finished
            await new Promise((r) => setTimeout(r, 10));
          },
        });
        expect(await out).toMatchObject({ kind: "completed", result: { ok: true } });
        expect(slept).toBeGreaterThanOrEqual(2);
        expect(turnRecords()).toBe(1);
      });

      it("a turn that starts while the worker is restarting (nothing listening) waits for it and runs exactly once", async () => {
        await boot();
        await signIn();
        await handle.close(); // the restart window: socket gone
        let slept = 0;
        const out = runHostTurn(client, turnReq("c1", 1), {
          busyWaitMs: 60_000,
          random: () => 1,
          sleep: async () => {
            if (++slept === 2) handle = await startHostServer(rig.mgr, { socketPath: sock, socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 }); // the new build is up
            await new Promise((r) => setTimeout(r, 10));
          },
        });
        expect(await out).toMatchObject({ kind: "completed", result: { ok: true } });
        expect(slept).toBeGreaterThanOrEqual(2);
        expect(turnRecords()).toBe(1);
      });

      it("the DEFAULT wait is 40 s (long enough for a restart, short enough that a dead worker fails a turn promptly)", async () => {
        await boot();
        await signIn();
        rig.mgr.setDrain({ mode: "strict", ttlSec: 3600 });
        let fake = Date.now();
        const spy = jest.spyOn(Date, "now").mockImplementation(() => fake);
        let slept = 0;
        try {
          await expect(runHostTurn(client, turnReq("c1", 1), { random: () => 1, sleep: async (ms) => void ((slept += ms), (fake += ms)) })).rejects.toMatchObject({ code: "EBUSY", detail: "draining" });
        } finally {
          spy.mockRestore();
        }
        expect(slept).toBeGreaterThan(35_000);
        expect(slept).toBeLessThanOrEqual(40_000);
      });

      it("still gives up (does not wait forever) when the worker never comes back", async () => {
        await boot();
        await signIn();
        await handle.close();
        await expect(runHostTurn(client, turnReq("c1", 1), { busyWaitMs: 300, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })).rejects.toMatchObject({ code: "UNREACHABLE" });
      });

      it("a turn that is already running is not touched by a refused drain attempt and finishes normally", async () => {
        await boot();
        await signIn();
        let release!: () => void;
        rig.script.turnEvents = [{ wait: new Promise<void>((r) => (release = r)) }, { type: "result", ok: true, text: "finished" }];
        const running = runHostTurn(client, turnReq("c1", 1), { sleep: noSleep });
        await waitFor(() => rig.script.activeTurns === 1);
        expect(rig.mgr.setDrain({ mode: "strict" }).ok).toBe(false); // busy: a deploy would have to wait
        release();
        expect(await running).toMatchObject({ kind: "completed", result: { text: "finished" } });
        expect(rig.mgr.setDrain({ mode: "strict" }).ok).toBe(true); // idle now
      });

      it("only an unestablished connection counts as 'not sent': a reset or a bad certificate does not", () => {
        for (const d of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOENT"]) expect(new LoginHostError("UNREACHABLE", d).notSent).toBe(true);
        expect(new LoginHostError("TIMEOUT", "connect").notSent).toBe(true);
        for (const d of ["ECONNRESET", "EPIPE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", undefined]) expect(new LoginHostError("UNREACHABLE", d).notSent).toBe(false);
        expect(new LoginHostError("TIMEOUT", "request").notSent).toBe(false);
        expect(new LoginHostError("TIMEOUT", "start").notSent).toBe(false);
        expect(new LoginHostError("BAD_RESPONSE").notSent).toBe(false);
      });
    });

    it("renews the lease so a long turn outlives the 30 s lease, and stops renewing when it ends", async () => {
      await boot();
      await signIn();
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
      const req = turnReq("c1", 1);
      const abort = new AbortController();
      let rounds = 0;
      const renews = jest.spyOn(client, "turnRenew");
      const run = runHostTurn(client, req, {
        signal: abort.signal,
        renewEveryMs: 10_000,
        // Each "10 s" passes instantly: the host's clock moves, then the host's own lease check runs.
        sleep: async (ms) => {
          rig.clock.advance(ms);
          rig.mgr.tick();
          rounds++;
          await new Promise((r) => setTimeout(r, 10));
          if (rounds === 6) abort.abort(); // 60 s of host time, double the lease
        },
      });
      const out = await run;
      expect(renews.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(out).toMatchObject({ kind: "completed", result: { aborted: "interrupted" } }); // our interrupt, not "lease_lapsed"
    });

    it("without renewals the host ends the turn at the lease (what the renew timer prevents)", async () => {
      await boot();
      await signIn();
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
      const stream = await client.turnRun(turnReq("c1", 1));
      rig.clock.advance(31_000);
      rig.mgr.tick();
      const events: ProviderEvent[] = [];
      for await (const e of stream.events) events.push(e);
      expect(events[events.length - 1]).toMatchObject({ type: "result", aborted: "lease_lapsed" });
    });

    it("stops the turn when renewals cannot reach the host twice in a row", async () => {
      await boot();
      await signIn();
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
      const renew = jest.spyOn(client, "turnRenew").mockRejectedValue(new LoginHostError("UNREACHABLE"));
      const req = turnReq("c1", 1);
      const out = await runHostTurn(client, req, { renewEveryMs: 1_000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
      expect(renew).toHaveBeenCalledTimes(2);
      expect(rig.script.interruptedTurns).toContain(req.turnId);
      expect(out.kind === "completed" ? out.result.aborted : "dropped").toBeDefined();
    });

    it("on two failed renewals the stream is cut IMMEDIATELY; a hung interrupt does not hold the caller", async () => {
      await boot();
      await signIn();
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
      jest.spyOn(client, "turnRenew").mockRejectedValue(new LoginHostError("UNREACHABLE"));
      const interrupt = jest.spyOn(client, "turnInterrupt").mockImplementation(() => new Promise(() => undefined)); // the dead link never answers
      const started = Date.now();
      const out = await runHostTurn(client, turnReq("c1", 1), { renewEveryMs: 1_000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(out).toMatchObject({ kind: "unknown_outcome", reason: "stream_dropped" });
      expect(interrupt).toHaveBeenCalledTimes(1); // still sent, alongside
    });

    it("does not interrupt when a renew says the turn is already over", async () => {
      await boot();
      await signIn();
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
      const abort = new AbortController();
      jest.spyOn(client, "turnRenew").mockRejectedValue(new LoginHostError("ENOTFOUND"));
      const interrupts = jest.spyOn(client, "turnInterrupt");
      const run = runHostTurn(client, turnReq("c1", 1), {
        signal: abort.signal,
        renewEveryMs: 1_000,
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 10));
        },
      });
      await waitFor(() => (client.turnRenew as jest.Mock).mock.calls.length >= 1);
      await new Promise((r) => setTimeout(r, 100));
      expect((client.turnRenew as jest.Mock).mock.calls.length).toBe(1); // stops renewing
      expect(interrupts).not.toHaveBeenCalled();
      abort.abort();
      await run;
    });

    it("never runs a turn twice: a known idempotency key is an unknown outcome", async () => {
      await boot();
      await signIn();
      const req = turnReq("c1", 1);
      expect(await runHostTurn(client, req, { sleep: noSleep })).toMatchObject({ kind: "completed" });
      const again = await runHostTurn(client, req, { sleep: noSleep });
      expect(again).toMatchObject({ kind: "unknown_outcome", reason: "duplicate", status: "finished" });
      expect(rig.script.opened).toBe(1);
    });

    it("a lost reply to turn.run is probed once with the same key and reported unknown, never re-run", async () => {
      await boot();
      await signIn();
      const real = transport;
      let streams = 0;
      const lossy: HostTransport = {
        json: (r, b) => real.json(r, b),
        stream: async (r, b): Promise<StreamReply> => {
          const reply = await real.stream(r, b); // the host admitted the turn ...
          if (++streams === 1) {
            reply.close();
            throw new LoginHostError("UNREACHABLE"); // ... but the answer never arrived
          }
          return reply;
        },
      };
      const out = await runHostTurn(new LoginHostClient(lossy), turnReq("c1", 1), { sleep: noSleep });
      expect(out).toMatchObject({ kind: "unknown_outcome", reason: "duplicate" });
      expect(streams).toBe(2);
      expect(rig.script.opened).toBe(1);
    });

    it("a request that never reached the host is run by the single probe", async () => {
      await boot();
      await signIn();
      const real = transport;
      let streams = 0;
      const flaky: HostTransport = {
        json: (r, b) => real.json(r, b),
        stream: async (r, b) => {
          if (++streams === 1) throw new LoginHostError("UNREACHABLE");
          return real.stream(r, b);
        },
      };
      expect(await runHostTurn(new LoginHostClient(flaky), turnReq("c1", 1), { sleep: noSleep })).toMatchObject({ kind: "completed" });
      expect(streams).toBe(2);
      // A second consecutive failure is not retried again.
      streams = -5;
      await expect(runHostTurn(new LoginHostClient({ json: real.json.bind(real), stream: async () => { throw new LoginHostError("TIMEOUT"); } }), turnReq("c1", 1), { sleep: noSleep })).rejects.toMatchObject({ code: "TIMEOUT" });
    });

    it("a stream that ends without a result is an unknown outcome, not a failure", async () => {
      await boot();
      await signIn();
      const real = transport;
      const cut: HostTransport = {
        json: (r, b) => real.json(r, b),
        stream: async (r, b) => {
          const reply = await real.stream(r, b);
          const it = reply.lines[Symbol.asyncIterator]();
          let n = 0;
          return {
            close: () => reply.close(),
            lines: { [Symbol.asyncIterator]: () => ({ next: async () => (++n <= 2 ? it.next() : Promise.reject(new LoginHostError("UNREACHABLE"))) }) },
          };
        },
      };
      rig.script.turnEvents = [{ type: "text", delta: "a" }, { type: "text", delta: "b" }, { type: "result", ok: true, text: "ab" }];
      expect(await runHostTurn(new LoginHostClient(cut), turnReq("c1", 1), { sleep: noSleep })).toMatchObject({ kind: "unknown_outcome", reason: "stream_dropped" });
    });

    it("a stream that closes cleanly before any result is also an unknown outcome", async () => {
      await boot();
      await signIn();
      const real = transport;
      const early: HostTransport = {
        json: (r, b) => real.json(r, b),
        stream: async (r, b) => {
          const reply = await real.stream(r, b);
          const it = reply.lines[Symbol.asyncIterator]();
          let n = 0;
          return { close: () => reply.close(), lines: { [Symbol.asyncIterator]: () => ({ next: async () => (++n <= 2 ? it.next() : { done: true as const, value: undefined }) }) } };
        },
      };
      expect(await runHostTurn(new LoginHostClient(early), turnReq("c1", 1), { sleep: noSleep })).toMatchObject({ kind: "unknown_outcome", reason: "stream_dropped" });
    });

    it("a result that arrived before the connection dropped stands as the answer", async () => {
      await boot();
      await signIn();
      const real = transport;
      const lateDrop: HostTransport = {
        json: (r, b) => real.json(r, b),
        stream: async (r, b) => {
          const reply = await real.stream(r, b);
          const it = reply.lines[Symbol.asyncIterator]();
          let n = 0;
          // accepted, text, result, then the connection dies instead of ending cleanly
          return { close: () => reply.close(), lines: { [Symbol.asyncIterator]: () => ({ next: async () => (++n <= 3 ? it.next() : Promise.reject(new LoginHostError("UNREACHABLE"))) }) } };
        },
      };
      const seen: string[] = [];
      const out = await runHostTurn(new LoginHostClient(lateDrop), turnReq("c1", 1), { sleep: noSleep, onEvent: (e) => void seen.push(e.type) });
      expect(out).toMatchObject({ kind: "completed", result: { type: "result", ok: true, text: "hi" } });
      expect(seen).toEqual(["text", "result"]);
    });

    it("an error thrown by the caller's onEvent reaches the caller even when it looks like a transport error", async () => {
      await boot();
      await signIn();
      rig.script.turnEvents = [{ type: "text", delta: "a" }, { wait: new Promise<void>(() => undefined) }];
      await expect(
        runHostTurn(client, turnReq("c1", 1), {
          sleep: noSleep,
          onEvent: () => {
            throw new LoginHostError("TIMEOUT");
          },
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
    });

    it("learns a short host lease before the first wait, so a 3 s lease survives a long turn", async () => {
      await boot({ config: { leaseMs: 3_000 } });
      await signIn();
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
      const abort = new AbortController();
      let rounds = 0;
      const out = await runHostTurn(client, turnReq("c1", 1), {
        signal: abort.signal,
        sleep: async (ms) => {
          rig.clock.advance(ms);
          rig.mgr.tick();
          await new Promise((r) => setTimeout(r, 10));
          if (++rounds === 12) abort.abort(); // ~12 s of host time against a 3 s lease
        },
      });
      expect(out).toMatchObject({ kind: "completed", result: { aborted: "interrupted" } });
    });

    it("returns promptly when a renew is still in flight at the end of the turn", async () => {
      await boot();
      await signIn();
      jest.spyOn(client, "turnRenew").mockImplementation(() => new Promise(() => undefined)); // never answers
      const started = Date.now();
      expect(await runHostTurn(client, turnReq("c1", 1), { sleep: noSleep })).toMatchObject({ kind: "completed" });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("rejects a known event with wrong fields instead of passing it on as the declared type", async () => {
      await boot();
      await signIn();
      const real = transport;
      const bad: HostTransport = {
        json: (r, b) => real.json(r, b),
        stream: async () => ({
          close: () => undefined,
          lines: (async function* () {
            yield { type: "accepted", turnId: "t1", duplicate: false };
            yield { type: "result" }; // no ok, no text
          })(),
        }),
      };
      const stream = await new LoginHostClient(bad).turnRun(turnReq("c1", 1));
      await expect((async () => { for await (const e of stream.events) void e; })()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
      expect(await runHostTurn(new LoginHostClient(bad), turnReq("c1", 1), { sleep: noSleep })).toMatchObject({ kind: "unknown_outcome", reason: "stream_dropped" });
    });

    it("a caller that throws in onEvent interrupts the turn and gets its own error back", async () => {
      await boot();
      await signIn();
      rig.script.turnEvents = [{ type: "text", delta: "a" }, { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const req = turnReq("c1", 1);
      await expect(
        runHostTurn(client, req, {
          sleep: noSleep,
          onEvent: () => {
            throw new Error("sink full");
          },
        }),
      ).rejects.toThrow("sink full");
      expect(rig.script.interruptedTurns).toContain(req.turnId);
    });

    it("a stale epoch is surfaced, not retried", async () => {
      await boot();
      await signIn();
      await expect(runHostTurn(client, turnReq("c1", 2), { sleep: noSleep })).rejects.toMatchObject({ code: "ESTALE" });
    });
  });
});

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
