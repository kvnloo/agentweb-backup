/**
 * ENG-2113: the plan route must offer EXACTLY the tools AgentWeb offers. The manifest limits are a DoS guard set at ~2x the real Emma registry; this file
 * (1) checks the REAL registry against them with headroom, so a registry that grows past the guard fails here instead of being trimmed in production, and
 * (2) pushes a manifest AT the limits through the request schema, the body cap, the turn wrapper's manifest line and the shim's tools/list.
 */
import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { admitNewTools, MODEL_TOOL_NAME_MAX_CHARS, qualifiedToolPrefix, RELAY_MCP_SERVER_NAME, ROUTES, TOOL_LIMITS, TOOL_NAME_MAX_CHARS, toolEntryProblem, toolManifest, TURN_RUN_MAX_BODY_BYTES, visibleFromManifest, type ToolDef, manifestLines } from "../../protocol";
import { startHostServer } from "../../server";
import { makeRig } from "../helpers";

jest.setTimeout(180_000);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** The Emma registry exactly as agentModeService.registerTools() loads it (the same side-effect imports), in manifest form. */
async function realRegistry(): Promise<ToolDef[]> {
  const mods = [
    "../../../emma/registry",
    "../../../mcp/server/evaluationTools",
    "../../../emma/tools",
    "../../../emma/fathomTools",
    "../../../emma/lumaTools",
    "../../../emma/meetingActionRouter",
    "../../../emma/notionGuideTools",
    "../../../emma/slackMessageTools",
    "../../../emma/tempEmailTools",
    "../../../emma/testAccountTools",
    "../../../emma/navigateTools",
    "../../../emma/connectAccountTool",
    "../../../emma/linkedInAccountRevokeTools",
    "../../../emma/solveRecaptchaTool",
    "../../../emma/siteSigninTools",
    "../../../emma/verificationCodeTool",
    "../../../emma/calendarTools",
    "../../../emma/jevTools",
    "../../../emma/localAgentTools",
  ];
  for (const m of mods) await import(m);
  const { emmaToolRegistry } = await import("../../../emma/registry");
  return emmaToolRegistry.getToolNames().map((n: string) => {
    const d = emmaToolRegistry.getTool(n)!.definition;
    return { name: d.name, description: d.description ?? "", inputSchema: d.inputSchema as Record<string, unknown> };
  });
}

/** A manifest AT the limits: maxTools tools, one description of exactly maxDescriptionBytes, one schema just under maxSchemaBytes, total just under maxTotalBytes. */
function maxManifest(): ToolDef[] {
  const n = TOOL_LIMITS.maxTools;
  const tools: ToolDef[] = Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: "", inputSchema: { type: "object", properties: {} } }));
  tools[0].description = "d".repeat(TOOL_LIMITS.maxDescriptionBytes);
  const schemaBase = bytes({ type: "object", properties: { p: { type: "string", description: "" } } });
  tools[1].inputSchema = { type: "object", properties: { p: { type: "string", description: "s".repeat(TOOL_LIMITS.maxSchemaBytes - schemaBase) } } };
  // fill the rest evenly up to just under the total
  const room = TOOL_LIMITS.maxTotalBytes - bytes(tools) - 64;
  const per = Math.floor(room / (n - 2));
  for (let i = 2; i < n; i++) tools[i].description = "f".repeat(Math.min(per, TOOL_LIMITS.maxDescriptionBytes));
  return tools;
}

const fits = (tools: ToolDef[], extraTools = 0) => {
  const maxDesc = Math.max(...tools.map((t) => Buffer.byteLength(t.description, "utf8")));
  const maxSchema = Math.max(...tools.map((t) => bytes(t.inputSchema)));
  const total = bytes(tools);
  return { count: (tools.length + extraTools) * 1.5 <= TOOL_LIMITS.maxTools, desc: maxDesc * 1.5 <= TOOL_LIMITS.maxDescriptionBytes, schema: maxSchema * 1.5 <= TOOL_LIMITS.maxSchemaBytes, total: total * 1.5 <= TOOL_LIMITS.maxTotalBytes, name: Math.max(...tools.map((t) => t.name.length)) <= TOOL_NAME_MAX_CHARS };
};
const ALL_TRUE = { count: true, desc: true, schema: true, total: true, name: true };

describe("the real Emma registry against the limits (Emma opens a chat with the foundation tools and adds a skill's tools when it is installed)", () => {
  let tools: ToolDef[];
  let foundation: ToolDef[];
  beforeAll(async () => {
    tools = await realRegistry();
    const { AgentModeService } = await import("../../../services/agentModeService");
    const names = new Set([...AgentModeService.DEFAULT_FOUNDATION_TOOLS, "install_skills"]);
    foundation = tools.filter((t) => names.has(t.name));
  });

  it("every registered tool is a valid manifest entry (names fit the 64-character model limit once qualified), and the whole registry is one valid manifest", () => {
    expect(tools.length).toBeGreaterThan(200);
    for (const t of tools) expect({ name: t.name, problem: toolEntryProblem(t), qualified: `${qualifiedToolPrefix(RELAY_MCP_SERVER_NAME)}${t.name}`.length <= MODEL_TOOL_NAME_MAX_CHARS }).toEqual({ name: t.name, problem: undefined, qualified: true });
    const r = toolManifest.safeParse(tools);
    expect(r.success ? "ok" : r.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).slice(0, 5)).toBe("ok");
  });

  it("(a) the foundation set (what a chat opens with) is a valid open set with plenty of headroom", () => {
    expect(foundation.length).toBeGreaterThan(40); // the registry holds most of the 78 (some foundation entries are agent-mode built-ins registered elsewhere)
    expect(toolManifest.safeParse(foundation).success).toBe(true);
    expect(fits(foundation)).toEqual(ALL_TRUE);
    expect(bytes(foundation) * 4).toBeLessThan(TOOL_LIMITS.maxTotalBytes);
    console.log(`foundation set from the registry: ${foundation.length} tools, ${bytes(foundation)} bytes`);
  });

  it("(b) the WHOLE registry, delivered in steps on top of the foundation set (worst case: every skill installed), fits the cumulative caps with >= 1.5x headroom", () => {
    expect(fits(tools, 20)).toEqual(ALL_TRUE); // +20: the agent-mode built-ins (search_tool_response, install_skills, ...) and a user's MCP tools come on top
    let visible = visibleFromManifest(foundation);
    const open = new Set(foundation.map((t) => t.name));
    const rest = tools.filter((t) => !open.has(t.name));
    for (let i = 0; i < rest.length; i += 7) {
      const r = admitNewTools(visible, rest.slice(i, i + 7));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const t of r.fresh) {
        visible.names.add(t.name);
        visible.folded.add(t.name.toLowerCase());
      }
      visible = { ...visible, bytes: r.bytes };
    }
    expect(visible.names.size).toBe(tools.length);
    expect(visible.bytes * 1.5).toBeLessThanOrEqual(TOOL_LIMITS.maxTotalBytes);
    console.log(`whole registry: ${tools.length} tools, ${bytes(tools)} bytes`);
  });
});

describe("a manifest AT the limits", () => {
  const tools = maxManifest();

  it("is accepted by the schema, and one byte more anywhere is refused", () => {
    expect(bytes(tools)).toBeGreaterThan(TOOL_LIMITS.maxTotalBytes - 4096);
    expect(toolManifest.safeParse(tools).success).toBe(true);
    expect(toolManifest.safeParse([...tools, { name: "one_more", description: "", inputSchema: { type: "object" } }]).success).toBe(false);
    const longer = tools.map((t, i) => (i === 0 ? { ...t, description: t.description + "d" } : t));
    expect(toolManifest.safeParse(longer).success).toBe(false);
    const fatter = tools.map((t, i) => (i === 2 ? { ...t, description: t.description + "f".repeat(2_000) } : t));
    expect(toolManifest.safeParse(fatter).success).toBe(false);
  });

  it("fits turn.run's body cap together with a maximal 2,000,000-character prompt of 3-byte characters", async () => {
    const body = JSON.stringify({ connectionId: "c1", epoch: 1, idempotencyKey: "k1", turnId: "t1", prompt: "€".repeat(2_000_000), model: "fast", tools });
    expect(Buffer.byteLength(body)).toBeLessThan(TURN_RUN_MAX_BODY_BYTES);
    expect(ROUTES["turn.run"].safeParse(JSON.parse(body)).success).toBe(true);
    const rig = makeRig({ adapter: { relay: true } });
    const dir = mkdtempSync(join(tmpdir(), "lh-limits-"));
    roots.push(dir);
    const handle = await startHostServer(rig.mgr, { socketPath: join(dir, "host.sock"), tickMs: 60_000, sweepMs: 60_000 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ socketPath: join(dir, "host.sock"), method: "POST", path: "/v1/turn.run", headers: { "content-type": "application/json" } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end(body);
      });
      expect(status).toBe(404); // read in full and parsed: the connection simply does not exist (not 413, not 400)
    } finally {
      await handle.close();
      rig.cleanup();
    }
  });

  it("travels intact through the turn wrapper's manifest line into tools.json, and the shim lists every tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "lh-limits-wrap-"));
    roots.push(root);
    const unitTmp = join(root, "tmp");
    mkdirSync(unitTmp);
    const wrapper = join(__dirname, "..", "..", "deploy", "claude-turn.sh");
    const shim = join(__dirname, "..", "..", "deploy", "aw-relay-shim.js");
    const line = JSON.stringify(tools);
    // The wrapper: line 1 = MCP config, line 2 = manifest; it then execs `cat` here (the CLI's place), which proves the rest of stdin is untouched.
    const t0 = Date.now();
    const out = await new Promise<string>((resolve, reject) => {
      const c = spawn(wrapper, ["/bin/cat"], { env: { PATH: "/usr/bin:/bin", TMPDIR: unitTmp, AW_TURN_TOOLS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
      let o = "";
      c.stdout.on("data", (d) => (o += d.toString()));
      c.on("error", reject);
      c.on("exit", () => resolve(o));
      c.stdin.on("error", () => {});
      c.stdin.end(`{"mcpServers":{}}\n${manifestLines(tools).map((l) => l + "\n").join("")}REST-OF-STDIN\n`);
    });
    const wrapMs = Date.now() - t0;
    expect(out).toBe("REST-OF-STDIN\n");
    expect(readFileSync(join(unitTmp, "aw-cfg", "tools.json"), "utf8")).toBe(line);
    // the wrapper's umask 077: the manifest and the MCP config are private to the unit's uid whatever the caller's umask
    expect(statSync(join(unitTmp, "aw-cfg", "tools.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(unitTmp, "aw-cfg", "mcp.json")).mode & 0o777).toBe(0o600);
    console.log(`wrapper manifest line at the limit: ${wrapMs} ms`);
    expect(wrapMs).toBeLessThan(30_000); // POSIX `read` takes the line a byte at a time; it must still be bounded and finish
    // The shim lists every tool from that file.
    const toolsFile = join(root, "tools.json");
    writeFileSync(toolsFile, line);
    const listed = await new Promise<number>((resolve, reject) => {
      const c = spawn(process.execPath, [shim], { env: { PATH: process.env.PATH ?? "", AW_RELAY_SOCKET: join(root, "none.sock"), AW_RELAY_TOOLS: toolsFile }, stdio: ["pipe", "pipe", "pipe"] });
      let buf = "";
      c.stdout.on("data", (d) => {
        buf += d.toString();
        const i = buf.indexOf("\n");
        if (i >= 0) {
          const m = JSON.parse(buf.slice(0, i));
          c.kill();
          resolve(m.result.tools.length);
        }
      });
      c.on("error", reject);
      c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    });
    expect(listed).toBe(TOOL_LIMITS.maxTools);
  });
});
