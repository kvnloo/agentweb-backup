/**
 * ENG-2113: protocol 4 — the tools manifest, the dual turn.run shape, turn.toolResult's images/unlock and the per-route body cap (through the socket).
 */
import { mkdtempSync, rmSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { IMAGE_LIMITS, PROTOCOL_VERSION, ROUTES, TOOL_LIMITS } from "../protocol";
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
  it("names are the function-name shape every Emma tool already has: ^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$", () => {
    for (const n of ["", "-a", "--dangerously-skip-permissions", "a b", "a.b", "../x", "a/b", "x".repeat(65), "é", "a\0", "a$b", "a%b"]) expect(run({ tools: [tool(n)] }).success).toBe(false);
    // what user-connected MCP servers and the registry produce today
    expect(run({ tools: [tool("browser_navigate"), tool("getIssue"), tool("list-pages"), tool("x".repeat(64)), tool("A_1")] }).success).toBe(true);
    expect(run({ tools: [tool("x".repeat(48)), tool("a_1")] }).success).toBe(true);
  });
  it("the shim-reserved prefix, duplicates and an all-locked manifest are refused", () => {
    expect(bad([tool("aw_relay_ping")])).toBe("tools:tool_name_reserved");
    expect(bad([tool("a"), tool("a")])).toBe("tools:tool_duplicate");
    // case-insensitive: names differing only in case, and the reserved prefix in any case
    expect(bad([tool("getIssue"), tool("getissue")])).toBe("tools:tool_duplicate");
    expect(bad([tool("AW_RELAY_x")])).toBe("tools:tool_name_reserved");
    expect(bad([tool("Aw_Relay_ping")])).toBe("tools:tool_name_reserved");
    expect(run({ tools: [tool("getIssue"), tool("getIssues")] }).success).toBe(true);
    expect(bad([tool("a", { locked: true })])).toBe("tools:tool_all_locked");
    expect(run({ tools: [tool("a"), tool("b", { locked: true })] }).success).toBe(true);
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
  it("accepts text, isError, up to 4 images of the 4 mime types, and unlock names", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ isError: true }).success).toBe(true);
    expect(parse({ images: ["image/png", "image/jpeg", "image/webp", "image/gif"].map((m) => img(8, m)), unlock: ["late_tool"] }).success).toBe(true);
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
  it("refuses bad unlock names, a legacy `ok` field and any unknown field", () => {
    expect(parse({ unlock: ["../x"] }).success).toBe(false);
    expect(parse({ unlock: [] }).success).toBe(false);
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

  it("mixing bridgeToken and tools answers EINVALID with the reason, end to end", async () => {
    const r = await post(sock, "turn.run", JSON.stringify({ ...turnReq("c1", 1), tools: [tool("search")] }));
    expect(r).toMatchObject({ status: 400, json: { error: "EINVALID", detail: "tools:bridge_and_tools_mixed" } });
    const none = await post(sock, "turn.run", JSON.stringify({ ...BASE }));
    expect(none.json.detail).toBe("tools:bridge_or_tools_required");
  });
});
