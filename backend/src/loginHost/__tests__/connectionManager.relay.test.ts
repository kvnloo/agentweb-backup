/**
 * ENG-2113: the host core's side of the tool relay: the dual request shape, the `tool-call` operation, turn.toolResult's typed "result lost" answers,
 * the per-turn call clock and the double-execution conformance rule.
 */
import { createHash } from "crypto";
import { HostError, TOOL_LIMITS, type ToolDef } from "../protocol";
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
];
/** Arrives with an answer (a skill install). */
const LATE: ToolDef = { name: "late_tool", description: "Appears after install_skills", inputSchema: { type: "object", properties: {} } };
const def = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({ name, description: "d", inputSchema: { type: "object", properties: {} }, ...extra });
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
    expect(await code(rig.mgr.runTurn({ ...req, tools: [{ ...TOOLS[0], description: "different" }] }))).toBe("EEXISTS");
    // A legacy request's hash has no tools component, so a turn recorded before this change still de-duplicates after an upgrade.
    const legacy = turnReq("c1", 1, { idempotencyKey: "k2", turnId: "tr2" });
    await drain((await rig.mgr.runTurn(legacy)).events!);
    expect((await rig.mgr.runTurn({ ...legacy, bridgeToken: "another-token-0123456789" })).duplicate).toBe(true);
  });
});

describe("relay: the LEGACY idempotency hash is exactly what the pre-relay host stored", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());
  /** The pre-relay formula, written out independently of the code under test: sha256 of JSON {c, e, t, p, m, pr} in this key order. */
  const legacyHash = (o: { c: string; e: number; t: string; p: string; m: string; pr: string }) => createHash("sha256").update(JSON.stringify({ c: o.c, e: o.e, t: o.t, p: o.p, m: o.m, pr: o.pr })).digest("hex");

  it("MUTATION TARGET: a turn recorded without tools stores sha256({c,e,t,p,m,pr}) (priority defaults to interactive): a hash that mentions tools, even as null, would make every persisted record EEXISTS after an upgrade", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    const a = turnReq("c1", 1, { idempotencyKey: "kh1", turnId: "trh1", prompt: "hi", model: "fast" });
    await drain((await rig.mgr.runTurn(a)).events!);
    expect(rig.store.get().idempotency["turn:c1:kh1"].requestHash).toBe(legacyHash({ c: "c1", e: 1, t: "trh1", p: "hi", m: "fast", pr: "interactive" }));
    const b = turnReq("c1", 1, { idempotencyKey: "kh2", turnId: "trh2", prompt: "yo", model: "fast", priority: "background" });
    await drain((await rig.mgr.runTurn(b)).events!);
    expect(rig.store.get().idempotency["turn:c1:kh2"].requestHash).toBe(legacyHash({ c: "c1", e: 1, t: "trh2", p: "yo", m: "fast", pr: "background" }));
  });

  it("MUTATION TARGET: a relay turn's hash is NOT the legacy one (it covers the manifest), and the same request with other tools is a different hash", async () => {
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    const req = relayReq("c1", { idempotencyKey: "kr1", turnId: "trr1" });
    await drain((await rig.mgr.runTurn(req)).events!);
    const stored = rig.store.get().idempotency["turn:c1:kr1"].requestHash;
    expect(stored).not.toBe(legacyHash({ c: "c1", e: 1, t: "trr1", p: req.prompt, m: req.model, pr: "interactive" }));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
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
    const reordered = TOOLS.map((t) => ({ inputSchema: { properties: (t.inputSchema as { properties: object }).properties, type: "object" }, description: t.description, name: t.name }));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(TOOLS));
    expect((await rig.mgr.runTurn({ ...req, tools: reordered as ToolDef[] })).duplicate).toBe(true);
    // a difference far below the 32 levels canonicalJson looks at is still a different manifest (the idempotency digest covers everything)
    const nestedDesc = (leaf: string) => ({ ...TOOLS[0], inputSchema: { type: "object", properties: Array.from({ length: 40 }).reduce<Record<string, unknown>>((acc) => ({ x: acc }), { leaf }) } });
    const k2 = relayReq("c1", { idempotencyKey: "k2", turnId: "tr2" });
    await drain((await rig.mgr.runTurn({ ...k2, tools: [nestedDesc("one")] })).events!);
    expect(await code(rig.mgr.runTurn({ ...k2, tools: [nestedDesc("two")] }))).toBe("EEXISTS");
    // a genuinely different manifest still conflicts
    expect(await code(rig.mgr.runTurn({ ...req, tools: [{ ...TOOLS[0], description: "other" }] }))).toBe("EEXISTS");
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

  it("a tool-call is answerable once; the provider gets the content, error flag, images and new tools", async () => {
    const it = await start();
    const image = { mimeType: "image/png" as const, data: "AAAA" };
    expect(await code(answer(rig, "op1", { isError: true, images: [image], tools: [LATE] }))).toBe("OK");
    expect(rig.script.answers).toHaveLength(1);
    expect(rig.script.answers[0]).toEqual({ operationId: "op1", answer: { kind: "tool-result", ok: false, content: "r", images: [image], tools: [LATE] } });
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

  it("tools that arrive with an answer are added to the turn's visible set and handed to the provider with the definitions", async () => {
    const it = await start({}, [call("op1"), call("op2"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }]);
    await it.next();
    expect(await code(answer(rig, "op1", { tools: [LATE] }))).toBe("OK");
    expect(rig.script.answers[0].answer).toEqual({ kind: "tool-result", ok: true, content: "r", tools: [LATE] });
    await it.return?.();
  });

  it("IDEMPOTENT: a tool that is already visible (open at the start, or added earlier) is a no-op; the provider is not sent it again", async () => {
    const it = await start({}, [call("op1"), call("op2"), call("op3"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }]);
    await it.next();
    await it.next();
    expect(await code(answer(rig, "op1", { tools: [LATE, TOOLS[0]] }))).toBe("OK"); // search is open already
    expect(await code(answer(rig, "op2", { tools: [LATE, { ...LATE, description: "changed" }] }))).toBe("OK"); // repeat of a visible name: first definition stays
    expect(await code(answer(rig, "op3", { tools: [TOOLS[0]] }))).toBe("OK");
    expect(rig.script.answers.map((a) => a.answer)).toEqual([
      { kind: "tool-result", ok: true, content: "r", tools: [LATE] },
      { kind: "tool-result", ok: true, content: "r" },
      { kind: "tool-result", ok: true, content: "r" },
    ]);
    await it.return?.();
  });

  it("MUTATION TARGET: an exact repeat WITHIN one answer is sent once (not twice to the shim, not double-counted)", async () => {
    const it = await start();
    expect(await code(answer(rig, "op1", { tools: [LATE, { ...LATE }, LATE] }))).toBe("OK");
    expect(rig.script.answers[0].answer).toEqual({ kind: "tool-result", ok: true, content: "r", tools: [LATE] });
    await it.return?.();
  });

  it("MUTATION TARGET: a name that differs only in case from a visible tool is refused (tools_invalid) and the operation stays pending", async () => {
    const it = await start();
    expect(await code(answer(rig, "op1", { tools: [def("SEARCH")] }))).toBe("EINVALID:tools_invalid"); // open at the start
    expect(rig.script.answers).toHaveLength(0);
    expect(await code(answer(rig, "op1", { tools: [LATE] }))).toBe("OK"); // the operation was still pending: the backend retries without it
    await it.return?.();
  });

  it("a case variant of a tool ADDED by an earlier answer is refused too", async () => {
    const it = await start({}, [call("op1"), call("op2"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }]);
    await it.next();
    expect(await code(answer(rig, "op1", { tools: [LATE] }))).toBe("OK");
    expect(await code(answer(rig, "op2", { tools: [def("LATE_TOOL")] }))).toBe("EINVALID:tools_invalid");
    await it.return?.();
  });

  it("MUTATION TARGET: the cumulative caps cover everything visible so far (count and bytes); a refused answer leaves the operation pending and the set unchanged", async () => {
    const open = Array.from({ length: TOOL_LIMITS.maxTools - 1 }, (_, i) => def(`open_${i}`));
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [call("op1"), call("op2"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    const it = (await rig.mgr.runTurn({ ...relayReq("c1"), tools: open })).events![Symbol.asyncIterator]();
    await it.next();
    expect(await code(answer(rig, "op1", { tools: [def("one_more"), def("two_more")] }))).toBe("EINVALID:tools_limit"); // 600 + 1
    expect(rig.script.answers).toHaveLength(0);
    expect(await code(answer(rig, "op1", { tools: [def("one_more")] }))).toBe("OK"); // exactly at the cap
    await it.next();
    expect(await code(answer(rig, "op2", { tools: [def("over")] }))).toBe("EINVALID:tools_limit"); // full now
    expect(await code(answer(rig, "op2", { tools: [def("one_more")] }))).toBe("OK"); // already visible: still a no-op at the cap
    await it.return?.();
  });

  it("MUTATION TARGET: the byte cap is cumulative too (a turn that opened near 1 MiB cannot add a large definition)", async () => {
    const big = (n: number) => def(`big_${n}`, { description: "x".repeat(TOOL_LIMITS.maxDescriptionBytes) });
    const open = Array.from({ length: 21 }, (_, i) => big(i)); // 21 x 48 KiB: just over 1000 KiB
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [call("op1"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    const it = (await rig.mgr.runTurn({ ...relayReq("c1"), tools: open })).events![Symbol.asyncIterator]();
    await it.next();
    expect(await code(answer(rig, "op1", { tools: [big(99)] }))).toBe("EINVALID:tools_limit");
    expect(await code(answer(rig, "op1", { tools: [def("tiny")] }))).toBe("OK"); // small ones still fit
    await it.return?.();
  });

  it("MUTATION TARGET: accepted answers ACCUMULATE against the byte cap (two answers that each fit alone cannot together exceed it)", async () => {
    const big = (n: number) => def(`acc_${n}`, { description: "x".repeat(TOOL_LIMITS.maxDescriptionBytes) });
    rig = makeRig({ adapter: { relay: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [call("op1"), call("op2"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    const it = (await rig.mgr.runTurn(relayReq("c1"))).events![Symbol.asyncIterator]();
    await it.next();
    await it.next();
    expect(await code(answer(rig, "op1", { tools: Array.from({ length: 15 }, (_, i) => big(i)) }))).toBe("OK"); // ~720 KiB: fits
    expect(await code(answer(rig, "op2", { tools: Array.from({ length: 10 }, (_, i) => big(100 + i)) }))).toBe("EINVALID:tools_limit"); // ~480 KiB more: fits alone, not together
    expect(await code(answer(rig, "op2", { tools: Array.from({ length: 5 }, (_, i) => big(100 + i)) }))).toBe("OK"); // ~240 KiB: still under 1 MiB
    await it.return?.();
  });

  it("tools in an answer for a turn without a relay manifest (legacy bridge turn) are refused", async () => {
    rig = makeRig({ adapter: { toolTransport: "host_relay" } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "tool-use", operationId: "op1", name: "t", input: {} }, { wait: new Promise<void>(() => undefined) }];
    const it = (await rig.mgr.runTurn(turnReq("c1", 1, { turnId: "tr1" }))).events![Symbol.asyncIterator]();
    await it.next();
    expect(await code(answer(rig, "op1", { tools: [LATE] }))).toBe("EINVALID:tools_invalid");
    await it.return?.();
  });

  it("MUTATION TARGET: an answer carrying tools for an ABORTED turn is refused (ESTALE) and adds nothing", async () => {
    const it = await start();
    await rig.mgr.interruptTurn({ connectionId: "c1", turnId: "tr1", epoch: 1 });
    expect(await code(answer(rig, "op1", { tools: [LATE] }))).toBe("ESTALE:turn_aborted");
    expect(rig.script.answers).toHaveLength(0);
    await it.return?.();
  });

  it("a refused answer followed by the same tools again (backend retry) works once the problem is fixed", async () => {
    const it = await start();
    const big = "a".repeat(2_400_000);
    const images = Array.from({ length: 3 }, () => ({ mimeType: "image/png" as const, data: big }));
    expect(await code(answer(rig, "op1", { content: "é".repeat(2_000_000), images, tools: [LATE] }))).toBe("EINVALID:result_too_large");
    expect(await code(answer(rig, "op1", { tools: [LATE] }))).toBe("OK");
    expect(rig.script.answers[0].answer).toMatchObject({ tools: [LATE] });
    await it.return?.();
  });

  it("a provider that already dropped the operation does not make the tools visible (ESTALE result_lost; the retry path stays open)", async () => {
    const it = await start({}, [call("op1"), call("op2"), { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }]);
    await it.next();
    rig.script.staleOperations.add("op1");
    expect(await code(answer(rig, "op1", { tools: [LATE] }))).toBe("ESTALE:result_lost");
    // LATE was not committed: a later answer still carries it to the provider
    expect(await code(answer(rig, "op2", { tools: [LATE] }))).toBe("OK");
    expect(rig.script.answers[1].answer).toMatchObject({ tools: [LATE] });
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

  it("MUTATION TARGET: a turn's answered bytes are budgeted (64 MiB): the answer that would pass it is refused before its operation is consumed, and small answers still work", async () => {
    const ops = Array.from({ length: 22 }, (_, i) => call("op" + (i + 1), "m" + (i + 1)));
    const it = await start({}, [...ops, { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }]);
    for (let i = 0; i < 22; i++) {
      const r = await Promise.race([it.next(), new Promise<string>((res) => setTimeout(() => res("STUCK"), 300))]);
      if (r === "STUCK") break; // (all the events there are have been consumed)
    }
    const big = "a".repeat(4_000_000); // a frame of about 4 MB
    for (let i = 1; i <= 16; i++) expect(await code(answer(rig, "op" + i, { content: big }))).toBe("OK");
        const c17 = await code(answer(rig, "op17", { content: big }));
        expect(c17).toBe("EINVALID:result_budget"); // 17 x 4 MB > 64 MiB
    const small = await code(answer(rig, "op17", { content: "small" }));
        expect(small).toBe("OK"); // the operation was not consumed, and a small answer fits
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
