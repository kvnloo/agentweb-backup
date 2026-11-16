/**
 * ENG-2113: protocol 4 — the tools manifest, the dual turn.run shape, turn.toolResult's images/tools and the per-route body cap (through the socket).
 */
import { mkdtempSync, rmSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { IMAGE_LIMITS, MODEL_TOOL_NAME_MAX_CHARS, PROTOCOL_VERSION, qualifiedToolPrefix, RELAY_MCP_SERVER_NAME, maxToolNameChars, ROUTES, TOOL_LIMITS, TOOL_NAME, TOOL_NAME_MAX_CHARS } from "../protocol";
import { startHostServer, type HostServerHandle } from "../server";
import { makeRig, signIn, turnReq, type Rig } from "./helpers";

const BASE = { connectionId: "c1", epoch: 1, idempotencyKey: "k1", turnId: "t1", prompt: "hi", model: "fast" };
const TOKEN = "bridge-token-0123456789";
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: "d", inputSchema: { type: "object", properties: {} }, ...extra });
const run = (over: Record<string, unknown>) => ROUTES["turn.run"].safeParse({ ...BASE, ...over });
const detail = (r: ReturnType<typeof run>) => (r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}:${i.code === "custom" ? i.message : i.code}`).join(","));

describe("protocol 4: version", () => {
  it("is 4", () => expect(PROTOCOL_VERSION).toBe(4));
});

describe("turn.run: exactly one tool transport", () => {
  it("legacy (bridgeToken) and relay (tools) are both accepted", () => {
    expect(run({ bridgeToken: TOKEN }).success).toBe(true);
    expect(run({ tools: [tool("search")] }).success).toBe(true);
  });
  it("both together, or neither, is refused with a clear detail", () => {
    expect(detail(run({ bridgeToken: TOKEN, tools: [tool("search")] }))).toBe("tools:bridge_and_tools_mixed");
    expect(detail(run({}))).toBe("tools:bridge_or_tools_required");
  });
  it("every other protocol-3 field keeps its bounds (completionNonce/onlyIfPending live on other routes and are untouched)", () => {
    expect(run({ bridgeToken: TOKEN, deadlineMs: 999 }).success).toBe(false);
    expect(run({ bridgeToken: TOKEN, deadlineMs: 3_600_001 }).success).toBe(false);
    expect(run({ bridgeToken: TOKEN, priority: "scheduled" }).success).toBe(true);
    expect(run({ bridgeToken: TOKEN, extra: 1 }).success).toBe(false);
    expect(run({ tools: [tool("search")], bridgeUrl: "http://x" }).success).toBe(false);
    expect(ROUTES["login.complete"].safeParse({ connectionId: "c1", loginRef: "l1", code: "abcdefgh#12345678", completionNonce: "nonce-12345678" }).success).toBe(true);
    expect(ROUTES["login.cancel"].safeParse({ connectionId: "c1", loginRef: "l1", onlyIfPending: true }).success).toBe(true);
  });
});

describe("tools manifest bounds", () => {
  const bad = (tools: unknown[]) => detail(run({ tools }));
  it("names are the function-name shape every Emma tool already has, at most TOOL_NAME_MAX_CHARS (53)", () => {
    for (const n of ["", "-a", "--dangerously-skip-permissions", "a b", "a.b", "../x", "a/b", "x".repeat(54), "x".repeat(64), "é", "a\0", "a$b", "a%b"]) expect(run({ tools: [tool(n)] }).success).toBe(false);
    // what user-connected MCP servers and the registry produce today
    expect(run({ tools: [tool("browser_navigate"), tool("getIssue"), tool("list-pages"), tool("x".repeat(53)), tool("A_1")] }).success).toBe(true);
    expect(run({ tools: [tool("x".repeat(54))] }).success).toBe(false);
  });
  it("MUTATION TARGET: the name cap is DERIVED from the qualified prefix the CLI adds (mcp__<server>__) and the model API's 64 characters", () => {
    expect(qualifiedToolPrefix(RELAY_MCP_SERVER_NAME)).toBe("mcp__emma__");
    expect(qualifiedToolPrefix(RELAY_MCP_SERVER_NAME)).toHaveLength(11);
    expect(TOOL_NAME_MAX_CHARS).toBe(MODEL_TOOL_NAME_MAX_CHARS - qualifiedToolPrefix(RELAY_MCP_SERVER_NAME).length);
    expect(TOOL_NAME_MAX_CHARS).toBe(53);
    // a different server name changes the cap
    expect(maxToolNameChars("emma")).toBe(53);
    expect(maxToolNameChars("emma2")).toBe(52);
    expect(maxToolNameChars("x")).toBe(64 - "mcp__x__".length);
    // the longest accepted name, qualified, is exactly what the model API takes; one more is not
    expect(`${qualifiedToolPrefix(RELAY_MCP_SERVER_NAME)}${"x".repeat(TOOL_NAME_MAX_CHARS)}`).toHaveLength(64);
    expect(TOOL_NAME.safeParse("x".repeat(TOOL_NAME_MAX_CHARS)).success).toBe(true);
    expect(TOOL_NAME.safeParse("x".repeat(TOOL_NAME_MAX_CHARS + 1)).success).toBe(false);
  });
  it("the shim-reserved prefix and duplicates are refused, and there is no `locked` flag any more", () => {
    expect(bad([tool("aw_relay_ping")])).toBe("tools:tool_name_reserved");
    expect(bad([tool("a"), tool("a")])).toBe("tools:tool_duplicate");
    // case-insensitive: names differing only in case, and the reserved prefix in any case
    expect(bad([tool("getIssue"), tool("getissue")])).toBe("tools:tool_duplicate");
    expect(bad([tool("AW_RELAY_x")])).toBe("tools:tool_name_reserved");
    expect(bad([tool("Aw_Relay_ping")])).toBe("tools:tool_name_reserved");
    expect(run({ tools: [tool("getIssue"), tool("getIssues")] }).success).toBe(true);
    expect(run({ tools: [tool("a", { locked: true })] }).success).toBe(false); // a closed schema: the open set is all there is
  });
  it("MUTATION TARGET: the limits are pinned by literal (the plan route must be able to offer the whole registry, and nothing unbounded)", () => {
    expect(TOOL_LIMITS).toEqual({ maxTools: 600, maxTotalBytes: 1024 * 1024, maxDescriptionBytes: 48 * 1024, maxSchemaBytes: 32 * 1024 });
    expect(run({ tools: Array.from({ length: 600 }, (_, i) => tool(`t${i}`)) }).success).toBe(true);
    expect(run({ tools: Array.from({ length: 601 }, (_, i) => tool(`t${i}`)) }).success).toBe(false);
    const answer = (tools: unknown[]) => ROUTES["turn.toolResult"].safeParse({ connectionId: "c1", turnId: "t1", epoch: 1, operationId: "a".repeat(32), content: "r", tools });
    expect(answer(Array.from({ length: 600 }, (_, i) => tool(`t${i}`))).success).toBe(true);
    expect(answer(Array.from({ length: 601 }, (_, i) => tool(`t${i}`))).success).toBe(false);
  });
  it("count, total bytes, description and schema sizes are capped", () => {
    expect(run({ tools: Array.from({ length: TOOL_LIMITS.maxTools }, (_, i) => tool(`t${i}`)) }).success).toBe(true);
    expect(run({ tools: Array.from({ length: TOOL_LIMITS.maxTools + 1 }, (_, i) => tool(`t${i}`)) }).success).toBe(false);
    expect(run({ tools: [tool("a", { description: "x".repeat(TOOL_LIMITS.maxDescriptionBytes + 1) })] }).success).toBe(false);
    expect(bad([tool("a", { description: "é".repeat(TOOL_LIMITS.maxDescriptionBytes / 2 + 1) })])).toBe("tools:tool_description_too_large");
    const bigSchema = { type: "object", properties: { p: { type: "string", description: "x".repeat(TOOL_LIMITS.maxSchemaBytes) } } };
    expect(bad([tool("a", { inputSchema: bigSchema })])).toBe("tools:tool_schema_too_large");
    // 60 tools x ~12 KB each pass the per-tool caps but not the 512 KiB total
    // 40 tools x ~30 KB each pass the per-tool caps but not the 1 MiB total
    const mid = { type: "object", properties: { p: { type: "string", description: "x".repeat(30_000) } } };
    expect(bad(Array.from({ length: 40 }, (_, i) => tool(`t${i}`, { inputSchema: mid })))).toBe("tools:tools_too_large");
  });
  it("MUTATION TARGET: a schema nested past the stack is refused as too large (the size check must not throw), in a manifest and in an answer", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 200_000; i++) deep = [deep];
    const schema = { type: "object", properties: { p: deep } };
    expect(() => JSON.stringify(schema)).toThrow(RangeError);
    expect(bad([tool("a", { inputSchema: schema })])).toBe("tools:tool_schema_too_large");
    const r = ROUTES["turn.toolResult"].safeParse({ connectionId: "c1", turnId: "t1", epoch: 1, operationId: "a".repeat(32), content: "r", tools: [tool("a", { inputSchema: schema })] });
    expect(r.success ? "" : r.error.issues[0].message).toBe("tool_schema_too_large");
  });
  it("a schema must be an object schema; unknown tool fields are refused", () => {
    expect(bad([tool("a", { inputSchema: { type: "string" } })])).toBe("tools:tool_schema_not_object");
    expect(bad([tool("a", { inputSchema: {} })])).toBe("tools:tool_schema_not_object");
    expect(run({ tools: [tool("a", { command: "x" })] }).success).toBe(false);
  });
});

describe("turn.toolResult shape", () => {
  const base = { connectionId: "c1", turnId: "t1", epoch: 1, operationId: "a".repeat(32), content: "r" };
  const parse = (o: Record<string, unknown>) => ROUTES["turn.toolResult"].safeParse({ ...base, ...o });
  const img = (n: number, mimeType = "image/png") => ({ mimeType, data: "A".repeat(n) });
  it("MUTATION TARGET: the image count is pinned by literal (4 pass, 5 fail), not through the constant it is defined by", () => {
    expect(parse({ images: Array.from({ length: 4 }, () => img(8)) }).success).toBe(true);
    expect(parse({ images: Array.from({ length: 5 }, () => img(8)) }).success).toBe(false);
    expect(IMAGE_LIMITS.maxImages).toBe(4);
    expect(IMAGE_LIMITS.maxBase64Each).toBe(2_500_000);
    expect(IMAGE_LIMITS.maxBase64Total).toBe(6_000_000);
  });
  it("accepts text, isError, up to 4 images of the 4 mime types, and new tool definitions", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ isError: true }).success).toBe(true);
    expect(parse({ images: ["image/png", "image/jpeg", "image/webp", "image/gif"].map((m) => img(8, m)), tools: [tool("late_tool")] }).success).toBe(true);
  });
  it("refuses a fifth image, other mime types, non-base64, per-image and total overflows", () => {
    expect(parse({ images: Array.from({ length: IMAGE_LIMITS.maxImages + 1 }, () => img(8)) }).success).toBe(false);
    expect(parse({ images: [img(8, "image/svg+xml")] }).success).toBe(false);
    expect(parse({ images: [{ mimeType: "image/png", data: "not base64!" }] }).success).toBe(false);
    expect(parse({ images: [{ mimeType: "image/png", data: "AAA" }] }).success).toBe(false); // length not a multiple of 4
    expect(parse({ images: [img(IMAGE_LIMITS.maxBase64Each)] }).success).toBe(true);
    expect(parse({ images: [img(IMAGE_LIMITS.maxBase64Each + 4)] }).success).toBe(false);
    expect(parse({ images: [img(2_000_000), img(2_000_000), img(2_000_000)] }).success).toBe(true); // exactly 6M
    expect(parse({ images: [img(2_000_000), img(2_000_000), img(2_000_000), img(4)] }).success).toBe(false);
  });
  it("tools carried by a result: each entry validated like the manifest's (name pattern and length, reserved prefix in any case, schema and description caps, object schema)", () => {
    const bad = (tools: unknown[]) => (parse({ tools }).success ? "" : parse({ tools }).error!.issues.map((i) => i.message).join(","));
    expect(parse({ tools: [tool("late_tool")] }).success).toBe(true);
    for (const n of ["", "-x", "../x", "a b", "x".repeat(TOOL_NAME_MAX_CHARS + 1)]) expect(parse({ tools: [tool(n)] }).success).toBe(false);
    expect(bad([tool("aw_relay_x")])).toBe("tool_name_reserved");
    expect(bad([tool("AW_RELAY_x")])).toBe("tool_name_reserved");
    expect(bad([tool("a", { inputSchema: { type: "string" } })])).toBe("tool_schema_not_object");
    expect(bad([tool("a", { inputSchema: { type: "object", properties: { p: { type: "string", description: "x".repeat(TOOL_LIMITS.maxSchemaBytes) } } } })])).toBe("tool_schema_too_large");
    expect(parse({ tools: [tool("a", { description: "x".repeat(TOOL_LIMITS.maxDescriptionBytes + 1) })] }).success).toBe(false);
    expect(parse({ tools: [tool("a", { locked: true })] }).success).toBe(false);
    expect(parse({ tools: [] }).success).toBe(false);
    expect(parse({ tools: Array.from({ length: TOOL_LIMITS.maxTools + 1 }, (_, i) => tool(`t${i}`)) }).success).toBe(false);
  });
  it("tools carried by a result: case variants inside one answer are refused, an exact repeat is a harmless no-op", () => {
    const bad = parse({ tools: [tool("getIssue"), tool("getissue")] });
    expect(bad.success ? "" : bad.error.issues[0].message).toBe("tool_duplicate");
    expect(parse({ tools: [tool("getIssue"), tool("getIssue")] }).success).toBe(true);
  });
  it("refuses the old `unlock` field, a legacy `ok` field and any unknown field", () => {
    expect(parse({ unlock: ["late_tool"] }).success).toBe(false);
    expect(parse({ ok: true }).success).toBe(false);
    expect(parse({ images: [{ ...img(8), extra: 1 }] }).success).toBe(false);
  });
});

function post(sock: string, route: string, body: string): Promise<{ status: number; json: { error?: string; detail?: string } }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = {};
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* ignore */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("socket", (s) => s.on("error", () => undefined));
    req.on("error", reject);
    req.end(body);
  });
}

describe("per-route body cap (through the socket)", () => {
  let rig: Rig;
  let dir: string;
  let sock: string;
  let handle: HostServerHandle;
  beforeEach(async () => {
    rig = makeRig({ adapter: { relay: true } });
    dir = mkdtempSync(join(tmpdir(), "lh-relay-"));
    sock = join(dir, "host.sock");
    handle = await startHostServer(rig.mgr, { socketPath: sock, tickMs: 60_000, sweepMs: 60_000 });
  });
  afterEach(async () => {
    await handle.close();
    rig.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("turn.toolResult accepts a body of ~6 MiB (images); turn.run and toolResult stop at 8 MiB; every other route still stops at 5 MiB", async () => {
    await signIn(rig, "c1", 1);
    const big = JSON.stringify({
      connectionId: "c1",
      turnId: "t1",
      epoch: 1,
      operationId: "a".repeat(32),
      content: "r",
      images: [2_400_000, 2_400_000, 1_200_000].map((n) => ({ mimeType: "image/png", data: "A".repeat(n) })),
    });
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(big.length).toBeLessThan(8 * 1024 * 1024);
    const r = await post(sock, "turn.toolResult", big);
    expect(r.status).toBe(404); // passed the cap and the schema: no such turn
    const pad = JSON.stringify({ ...turnReq("c1", 1), prompt: "p".repeat(8 * 1024 * 1024 + 10) });
    expect((await post(sock, "turn.run", pad)).status).toBe(413);
    const other = JSON.stringify({ connectionId: "c1", loginRef: "l1", code: "abcdefgh#" + "1".repeat(5 * 1024 * 1024) });
    expect((await post(sock, "login.complete", other)).status).toBe(413);
    const over = JSON.stringify({ connectionId: "c1", turnId: "t1", epoch: 1, operationId: "a".repeat(32), content: "x".repeat(8 * 1024 * 1024 + 10) });
    expect((await post(sock, "turn.toolResult", over)).status).toBe(413);
  });

  it("invalid tool definitions in a result are refused (route or host) and the operation stays PENDING; the retry without them succeeds", async () => {
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "tool-call", operationId: "op1", messageId: "m", name: "t", input: {} }, { wait: new Promise<void>(() => undefined) }];
    const it = (await rig.mgr.runTurn({ ...turnReq("c1", 1, { turnId: "t1" }), bridgeToken: undefined, tools: [tool("t")] })).events![Symbol.asyncIterator]();
    await it.next();
    const body = (tools: unknown[]) => JSON.stringify({ connectionId: "c1", turnId: "t1", epoch: 1, operationId: "op1", content: "r", tools });
    expect(await post(sock, "turn.toolResult", body([tool("aw_relay_x")]))).toMatchObject({ status: 400, json: { error: "EINVALID", detail: "tools:tool_name_reserved" } });
    expect(await post(sock, "turn.toolResult", body([tool("x".repeat(TOOL_NAME_MAX_CHARS + 1))]))).toMatchObject({ status: 400, json: { error: "EINVALID" } });
    expect(await post(sock, "turn.toolResult", body([tool("T")]))).toMatchObject({ status: 400, json: { error: "EINVALID", detail: "tools_invalid" } }); // case variant of the visible "t"
    expect(rig.script.answers).toHaveLength(0);
    expect((await post(sock, "turn.toolResult", body([tool("late")]))).status).toBe(200); // still pending
    expect(rig.script.answers).toHaveLength(1);
    await it.return?.();
  });

  it("MUTATION TARGET: nothing passes turn.run's 8 MiB cap, relay shape included (413)", async () => {
    const big = JSON.stringify({ ...turnReq("c1", 1), bridgeToken: undefined, tools: [tool("search")], prompt: "x", junk: "y".repeat(8 * 1024 * 1024 + 10) });
    expect(Buffer.byteLength(big)).toBeGreaterThan(8 * 1024 * 1024);
    expect((await post(sock, "turn.run", big)).status).toBe(413);
  });

  it("MUTATION TARGET: turn.run over 5 MiB is accepted ONLY in the relay shape (a legacy request keeps protocol 3's cap)", async () => {
    await signIn(rig, "c1", 1);
    const prompt = "€".repeat(2_000_000); // ~6 MB as UTF-8
    const legacy = JSON.stringify({ ...turnReq("c1", 1), prompt });
    const relay = JSON.stringify({ ...turnReq("c1", 1), bridgeToken: undefined, tools: [tool("search")], prompt });
    expect(Buffer.byteLength(legacy)).toBeGreaterThan(5 * 1024 * 1024);
    expect((await post(sock, "turn.run", legacy)).status).toBe(413);
    const r = await post(sock, "turn.run", relay);
    expect(r.status).not.toBe(413); // read in full, parsed and run (the point is the cap)
  });

  it("mixing bridgeToken and tools answers EINVALID with the reason, end to end", async () => {
    const r = await post(sock, "turn.run", JSON.stringify({ ...turnReq("c1", 1), tools: [tool("search")] }));
    expect(r).toMatchObject({ status: 400, json: { error: "EINVALID", detail: "tools:bridge_and_tools_mixed" } });
    const none = await post(sock, "turn.run", JSON.stringify({ ...BASE }));
    expect(none.json.detail).toBe("tools:bridge_or_tools_required");
  });
});
