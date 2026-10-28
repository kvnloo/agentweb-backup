/**
 * ENG-2113: the host core's side of the tool relay: the dual request shape, the `tool-call` operation, turn.toolResult's typed "result lost" answers,
 * the per-turn call clock and the double-execution conformance rule.
 */
import { HostError, type ToolDef } from "../protocol";
import { drain, makeRig, signIn, turnReq, type Rig } from "./helpers";

async function code<T>(p: Promise<T> | T): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof HostError ? e.code + (e.detail ? `:${e.detail}` : "") : `OTHER:${(e as Error).message}`;
  }
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const TOOLS: ToolDef[] = [
  { name: "search", description: "Search", inputSchema: { type: "object", properties: {} } },
  { name: "late_tool", description: "Only after install_skills", inputSchema: { type: "object", properties: {} }, locked: true },
];
const relayReq = (conn: string, extra: Record<string, unknown> = {}) => ({ ...turnReq(conn, 1, { turnId: "tr1", ...extra }), bridgeToken: undefined, tools: TOOLS });
const call = (op: string, messageId = "m1") => ({ type: "tool-call" as const, operationId: op, messageId, name: "search", input: { q: "x" } });
const answer = (rig: Rig, op: string, extra: Record<string, unknown> = {}, conn = "c1") =>
  rig.mgr.turnToolResult({ connectionId: conn, turnId: "tr1", epoch: 1, operationId: op, content: "r", ...extra });

describe("relay: dual request shape", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a legacy request (bridgeToken, no tools) reaches the provider exactly as before: a bridge token and no relay", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    await drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    expect(rig.script.turnInputs).toHaveLength(1);
    expect(rig.script.turnInputs[0].bridgeToken).toBe("bridge-token-0123456789");
    expect(rig.script.turnInputs[0].relay).toBeUndefined();
  });

  it("a relay request hands the provider the manifest and NO bridge token", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    await drain((await rig.mgr.runTurn(relayReq("c1"))).events!);
    const input = rig.script.turnInputs[0];
    expect(input.bridgeToken).toBeUndefined();
    expect(input.relay?.tools).toEqual(TOOLS);
    expect(typeof input.relay?.callTimeoutMs).toBe("function");
  });

  it("a provider that cannot relay refuses a tools request before anything starts", async () => {
    rig = makeRig({ adapter: { relay: false } });
    await signIn(rig, "c1", 1);
    expect(await code(rig.mgr.runTurn(relayReq("c1")))).toBe("EINVALID:relay_unsupported");
    expect(rig.script.opened).toBe(0);
  });

  it("idempotency covers the manifest: same key + same tools is a duplicate, same key + different tools is EEXISTS; legacy hashes are unchanged", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    const req = relayReq("c1", { idempotencyKey: "k1" });
    rig.script.turnEvents = [{ type: "result", ok: true, text: "x" }];
    await drain((await rig.mgr.runTurn(req)).events!);
    expect((await rig.mgr.runTurn({ ...req })).duplicate).toBe(true);
    expect(await code(rig.mgr.runTurn({ ...req, tools: [TOOLS[0]] }))).toBe("EEXISTS");
    // A legacy request's hash has no tools component, so a turn recorded before this change still de-duplicates after an upgrade.
    const legacy = turnReq("c1", 1, { idempotencyKey: "k2", turnId: "tr2" });
    await drain((await rig.mgr.runTurn(legacy)).events!);
    expect((await rig.mgr.runTurn({ ...legacy, bridgeToken: "another-token-0123456789" })).duplicate).toBe(true);
  });
});

describe("relay: idempotency hash of the manifest", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());
  it("is independent of key order (a retry whose JSON was re-serialized is a duplicate, not EEXISTS)", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "result", ok: true, text: "x" }];
    const req = relayReq("c1", { idempotencyKey: "k1" });
    await drain((await rig.mgr.runTurn(req)).events!);
    const reordered = TOOLS.map((t) => ({ locked: t.locked, inputSchema: { properties: (t.inputSchema as { properties: object }).properties, type: "object" }, description: t.description, name: t.name }));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(TOOLS));
    expect((await rig.mgr.runTurn({ ...req, tools: reordered as ToolDef[] })).duplicate).toBe(true);
    // a genuinely different manifest still conflicts
    expect(await code(rig.mgr.runTurn({ ...req, tools: [{ ...TOOLS[0], description: "other" }, TOOLS[1]] }))).toBe("EEXISTS");
  });
});

describe("relay: tool-call operations and turn.toolResult", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  async function start(over: Record<string, unknown> = {}, events?: Rig["script"]["turnEvents"]) {
    rig = makeRig({ adapter: { relay: true }, config: { toolCallTimeoutMs: 1_000 } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = events ?? [call("op1"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    const started = await rig.mgr.runTurn(relayReq("c1", over));
    const it = started.events![Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: "tool-call", operationId: "op1", messageId: "m1", name: "search", input: { q: "x" } });
    return it;
  }

  it("a tool-call is answerable once; the provider gets the content, error flag, images and unlock", async () => {
    const it = await start();
    const image = { mimeType: "image/png" as const, data: "AAAA" };
    expect(await code(answer(rig, "op1", { isError: true, images: [image], unlock: ["late_tool"] }))).toBe("OK");
    expect(rig.script.answers).toHaveLength(1);
    expect(rig.script.answers[0]).toEqual({ operationId: "op1", answer: { kind: "tool-result", ok: false, content: "r", images: [image], unlock: ["late_tool"] } });
    expect(await code(answer(rig, "op1"))).toBe("ENOTFOUND:operation_unknown"); // once
    await it.return?.();
  });

  it("a different connection, an unknown operation and a wrong epoch cannot answer", async () => {
    const it = await start();
    await signIn(rig, "c2", 1);
    expect(await code(answer(rig, "op1", {}, "c2"))).toBe("ENOTFOUND:operation_unknown"); // never a bare ENOTFOUND ("no such connection": destructive for revoke)
    expect(await code(rig.mgr.turnToolResult({ connectionId: "c1", turnId: "no-such-turn", epoch: 1, operationId: "op1", content: "r" }))).toBe("ENOTFOUND:operation_unknown");
    expect(await code(answer(rig, "nope"))).toBe("ENOTFOUND:operation_unknown");
    expect(await code(rig.mgr.turnToolResult({ connectionId: "c1", turnId: "tr1", epoch: 2, operationId: "op1", content: "r" }))).toMatch(/^ESTALE|EINVALID|ENOTFOUND/);
    expect(rig.script.answers).toHaveLength(0);
    await it.return?.();
  });

  it("an aborted turn rejects a late result with ESTALE (the host ended the turn: result lost)", async () => {
    const it = await start();
    await rig.mgr.interruptTurn({ connectionId: "c1", turnId: "tr1", epoch: 1 });
    expect(await code(answer(rig, "op1"))).toBe("ESTALE:turn_aborted");
    expect(rig.script.answers).toHaveLength(0);
    await it.return?.();
  });

  it("a result for an operation the provider no longer has (its timer fired first) is ESTALE result_lost", async () => {
    const it = await start();
    rig.script.staleOperations.add("op1");
    expect(await code(answer(rig, "op1"))).toBe("ESTALE:result_lost");
    await it.return?.();
  });

  it("a result after the operation expired is ENOTFOUND (no deadline: the host default)", async () => {
    const it = await start();
    rig.clock.advance(2_000);
    rig.mgr.tick();
    await flush();
    expect(await code(answer(rig, "op1"))).toBe("ENOTFOUND:operation_unknown");
    await it.return?.();
  });

  it("DOUBLE EXECUTION: the stream’s tool_use is informational; answering the stream's tool_use id is ENOTFOUND; only the host-generated operation is accepted", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "tool-use", operationId: "tu1", name: "search", input: { q: "x" } }, call("op1"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    const started = await rig.mgr.runTurn(relayReq("c1"));
    const it = started.events![Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: "tool-use", operationId: "tu1" });
    expect((await it.next()).value).toMatchObject({ type: "tool-call", operationId: "op1" });
    expect(await code(answer(rig, "tu1"))).toBe("ENOTFOUND:operation_unknown");
    expect(rig.script.answers).toHaveLength(0);
    expect(await code(answer(rig, "op1"))).toBe("OK");
    expect(rig.script.answers.map((a) => a.operationId)).toEqual(["op1"]);
    await it.return?.();
  });

  it("DOUBLE EXECUTION (legacy transports): an mcp_direct provider’s tool-use is never an operation either", async () => {
    rig = makeRig({ adapter: { toolTransport: "mcp_direct" } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "tool-use", operationId: "tu1", name: "search", input: {} }, { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    const started = await rig.mgr.runTurn(turnReq("c1", 1, { turnId: "tr1" }));
    const it = started.events![Symbol.asyncIterator]();
    await it.next();
    expect(await code(answer(rig, "tu1"))).toBe("ENOTFOUND:operation_unknown");
    await it.return?.();
  });

  it("unlock: only names the manifest marked locked, and a refused answer does not consume the operation (the backend can retry)", async () => {
    const it = await start();
    expect(await code(answer(rig, "op1", { unlock: ["search"] }))).toBe("EINVALID:unlock_unknown_tool"); // not locked
    expect(await code(answer(rig, "op1", { unlock: ["nope"] }))).toBe("EINVALID:unlock_unknown_tool"); // not in the manifest
    expect(rig.script.answers).toHaveLength(0);
    expect(await code(answer(rig, "op1", { unlock: ["late_tool"] }))).toBe("OK");
    await it.return?.();
  });

  it("an unlocked name cannot be unlocked twice", async () => {
    const it = await start({}, [call("op1"), call("op2"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }]);
    await it.next();
    expect(await code(answer(rig, "op1", { unlock: ["late_tool"] }))).toBe("OK");
    // already unlocked: a harmless no-op (a backend retry), the operation is answered, and the provider is NOT told to unlock it again
    expect(await code(answer(rig, "op2", { unlock: ["late_tool"] }))).toBe("OK");
    expect(rig.script.answers.map((a) => a.answer)).toEqual([
      { kind: "tool-result", ok: true, content: "r", unlock: ["late_tool"] },
      { kind: "tool-result", ok: true, content: "r" },
    ]);
    await it.return?.();
  });

  it("a name the manifest never marked locked is still refused even after other unlocks (validated against the locked set from the start)", async () => {
    const it = await start({}, [call("op1"), call("op2"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }]);
    await it.next();
    expect(await code(answer(rig, "op1", { unlock: ["late_tool"] }))).toBe("OK");
    expect(await code(answer(rig, "op2", { unlock: ["search", "late_tool"] }))).toBe("EINVALID:unlock_unknown_tool");
    expect(await code(answer(rig, "op2", { unlock: ["late_tool", "late_tool"] }))).toBe("OK"); // duplicates in one answer are fine too
    await it.return?.();
  });

  it("a refused answer followed by the same unlock again (backend retry) works once the problem is fixed", async () => {
    const it = await start();
    const big = "a".repeat(2_400_000);
    const images = Array.from({ length: 3 }, () => ({ mimeType: "image/png" as const, data: big }));
    expect(await code(answer(rig, "op1", { content: "é".repeat(2_000_000), images, unlock: ["late_tool"] }))).toBe("EINVALID:result_too_large");
    expect(await code(answer(rig, "op1", { unlock: ["late_tool"] }))).toBe("OK");
    expect(rig.script.answers[0].answer).toMatchObject({ unlock: ["late_tool"] });
    await it.return?.();
  });

  it("a result for a turn that has FINISHED is ENOTFOUND with a detail, never a bare ENOTFOUND, and differs from an aborted turn (ESTALE)", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [call("op1"), { type: "result", ok: true, text: "x" }];
    await drain((await rig.mgr.runTurn(relayReq("c1"))).events!);
    expect(await code(answer(rig, "op1"))).toBe("ENOTFOUND:operation_unknown");
    expect(await code(answer(rig, "op1"))).not.toBe("ENOTFOUND");
  });

  it("MUTATION TARGET: a tool-call event is registered as an operation (a tick past the host default answers an unanswered one with a timeout; a stream tool-use never is)", async () => {
    rig = makeRig({ adapter: { relay: true }, config: { toolCallTimeoutMs: 1_000 } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "tool-use", operationId: "tu1", name: "search", input: {} }, { type: "tool-call", operationId: "op1", messageId: "m", name: "search", input: {} }, { wait: new Promise<void>(() => undefined) }];
    const it = (await rig.mgr.runTurn(relayReq("c1"))).events![Symbol.asyncIterator]();
    await it.next();
    await it.next();
    rig.clock.advance(2_000);
    rig.mgr.tick();
    await flush();
    expect(rig.script.answers.map((a) => a.operationId)).toEqual(["op1"]); // only the relay call; tu1 was never an operation
    await it.return?.();
  });

  it("a result whose shim frame would exceed 8 MiB is refused before the operation is consumed", async () => {
    const it = await start();
    const big = "a".repeat(2_400_000);
    const images = Array.from({ length: 3 }, () => ({ mimeType: "image/png" as const, data: big }));
    expect(await code(answer(rig, "op1", { content: "é".repeat(2_000_000), images }))).toBe("EINVALID:result_too_large");
    expect(await code(answer(rig, "op1", { content: "small" }))).toBe("OK");
    await it.return?.();
  });

  it("tool-call events after an abort are not registered", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rig.script.turnEvents = [{ wait: gate }, call("op1"), { wait: new Promise<void>(() => undefined) }];
    rig.script.ignoreInterrupt = true;
    const started = await rig.mgr.runTurn(relayReq("c1"));
    const it = started.events![Symbol.asyncIterator]();
    const first = it.next();
    await flush();
    await rig.mgr.interruptTurn({ connectionId: "c1", turnId: "tr1", epoch: 1 });
    release();
    await first;
    expect(await code(answer(rig, "op1"))).toMatch(/^(ESTALE:turn_aborted|ENOTFOUND)/);
    await it.return?.();
  });
});

describe("relay: the call clock is the turn's deadline", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("callTimeoutMs() is the turn's remaining time to its deadline, read at call time; without a deadline it is the host default", async () => {
    rig = makeRig({ adapter: { relay: true }, config: { toolCallTimeoutMs: 120_000 } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
    void (await rig.mgr.runTurn(relayReq("c1", { deadlineMs: 590_000 }))).events![Symbol.asyncIterator]().next();
    await flush();
    const f = rig.script.turnInputs[0].relay!.callTimeoutMs;
    expect(f()).toBe(590_000); // not 120 000
    rig.clock.advance(100_000);
    expect(f()).toBe(490_000);
    rig.clock.advance(1_000_000);
    expect(f()).toBe(0);

    await signIn(rig, "c2", 1);
    void (await rig.mgr.runTurn({ ...turnReq("c2", 1, { turnId: "tr9" }), bridgeToken: undefined, tools: TOOLS })).events![Symbol.asyncIterator]().next();
    await flush();
    expect(rig.script.turnInputs[1].relay!.callTimeoutMs()).toBe(120_000);
  });

  it("a relay operation with a turn deadline outlives the host default but expires with the turn", async () => {
    rig = makeRig({ adapter: { relay: true }, config: { toolCallTimeoutMs: 1_000, leaseMs: 10_000_000 } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [call("op1"), { wait: new Promise<void>(() => undefined) }];
    const started = await rig.mgr.runTurn(relayReq("c1", { deadlineMs: 50_000 }));
    const it = started.events![Symbol.asyncIterator]();
    await it.next();
    rig.clock.advance(10_000); // 10x the host default, well inside the turn's deadline
    rig.mgr.tick();
    await flush();
    expect(rig.script.answers).toHaveLength(0);
    expect(await code(answer(rig, "op1"))).toBe("OK");
    await it.return?.();
  });
});
