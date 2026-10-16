/**
 * ENG-2110 PR 1a: the conformance suite every provider adapter must pass. It checks the shape and
 * the behavioural promises the host core relies on, not any vendor's protocol. Called from each
 * adapter's own test file: the fake adapter now, the Claude and Codex adapters when they land.
 */
import type { AdapterContext, ErrorKind, ProviderEvent, SubscriptionProviderAdapter } from "../adapter";

const ERROR_KINDS: ErrorKind[] = ["usage_limit", "auth_dead", "transient", "device_code_disabled", "refresh_reused", "policy_blocks", "unknown"];

export function ctxFor(connectionId = "conf1"): AdapterContext {
  return {
    connectionId,
    uid: 400_123,
    homeDir: "/fake/home",
    workDir: "/fake/work",
    tmpDir: "/fake/tmp",
    spawnAs: () => {
      throw new Error("conformance ctx does not spawn");
    },
  };
}

export function describeAdapterConformance(name: string, make: () => SubscriptionProviderAdapter): void {
  describe(`provider adapter conformance: ${name}`, () => {
    let adapter: SubscriptionProviderAdapter;
    beforeEach(() => (adapter = make()));

    it("declares a complete, sane identity", () => {
      expect(adapter.id).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(adapter.flagKey).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(adapter.homeEnvVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(["paste_code", "device_code"]).toContain(adapter.ceremony);
      expect(Number.isInteger(adapter.maxProcessesPerHome) && adapter.maxProcessesPerHome >= 1).toBe(true);
      expect(Number.isInteger(adapter.maxTurnsPerProcess) && adapter.maxTurnsPerProcess >= 1).toBe(true);
      expect(adapter.loginTtlMs).toBeGreaterThan(0);
      expect(adapter.models.size).toBeGreaterThan(0);
      for (const m of adapter.models) expect(m).toMatch(/^[A-Za-z0-9._:-]{1,64}$/); // the protocol's model shape
    });

    it("resolves its binary by absolute path", () => {
      const b = adapter.binary();
      expect(b.path.startsWith("/")).toBe(true);
      expect(b.version.length).toBeGreaterThan(0);
      expect(b.digest.length).toBeGreaterThan(0);
      expect(["mcp_direct", "host_relay"]).toContain(adapter.toolTransport);
    });

    it("implements exactly the sign-in methods its ceremony needs", () => {
      if (adapter.ceremony === "paste_code") {
        expect(typeof adapter.loginComplete).toBe("function");
        expect(adapter.loginPoll).toBeUndefined();
      } else {
        expect(typeof adapter.loginPoll).toBe("function");
        expect(adapter.loginComplete).toBeUndefined();
      }
    });

    it("loginStart returns an https URL (and a user code for device-code ceremonies), and loginCancel is safe to call", async () => {
      const proc = await adapter.loginStart(ctxFor());
      expect(proc.data.url).toMatch(/^https:\/\//);
      if (adapter.ceremony === "device_code") expect(proc.data.userCode).toBeTruthy();
      await expect(adapter.loginCancel(proc)).resolves.toBeUndefined();
    });

    it("preflight (on the open session) and authStatus return their documented shapes", async () => {
      const session = await adapter.openSession(ctxFor(), { connectionId: "conf1", epoch: 1 });
      const pre = await session.preflight();
      expect(typeof pre.ok).toBe("boolean");
      if (!pre.ok) expect(ERROR_KINDS).toContain(pre.kind);
      await session.close();
      const st = await adapter.authStatus(ctxFor());
      expect(typeof st.loggedIn).toBe("boolean");
      const hz = await adapter.hazards(ctxFor());
      expect(Array.isArray(hz)).toBe(true);
    });

    it("a turn yields events ending in exactly one result, and close() is idempotent", async () => {
      const session = await adapter.openSession(ctxFor(), { connectionId: "conf1", epoch: 1 });
      const model = [...adapter.models][0];
      const events: ProviderEvent[] = [];
      for await (const ev of session.turn({ turnId: "t1", prompt: "hi", model, bridgeToken: "bridge-token-0123456789" })) events.push(ev);
      expect(events.filter((e) => e.type === "result")).toHaveLength(1);
      expect(events[events.length - 1].type).toBe("result");
      await expect(session.close()).resolves.toBeUndefined();
      await expect(session.close()).resolves.toBeUndefined();
      await expect(session.closed).resolves.toBeUndefined(); // closing makes `closed` resolve
    });

    it("interrupt() stops a turn in flight", async () => {
      const session = await adapter.openSession(ctxFor(), { connectionId: "conf1", epoch: 1 });
      const model = [...adapter.models][0];
      const it = session.turn({ turnId: "t2", prompt: "hi", model, bridgeToken: "bridge-token-0123456789" })[Symbol.asyncIterator]();
      await it.next();
      await session.interrupt("t2");
      const rest: ProviderEvent[] = [];
      for (let i = 0; i < 20; i++) {
        const n = await it.next();
        if (n.done) break;
        rest.push(n.value);
      }
      await session.close();
      expect(rest.length).toBeLessThan(20); // it ended
    });

    it("mapError never throws and always returns a known kind", () => {
      for (const raw of [undefined, null, 0, "x", {}, { code: "x" }, new Error("boom"), { message: "401", status: 401 }]) expect(ERROR_KINDS).toContain(adapter.mapError(raw));
    });

    it("expiryModel is monotonic in the sign-in time", () => {
      const a = adapter.expiryModel(1_000_000);
      const b = adapter.expiryModel(2_000_000);
      if (a?.refreshExpiresAtMs !== undefined && b?.refreshExpiresAtMs !== undefined) expect(b.refreshExpiresAtMs).toBeGreaterThan(a.refreshExpiresAtMs);
    });
  });
}
