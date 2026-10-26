/**
 * ENG-2113 PR C: MANUAL live test, on the test instance, of the REAL `ClaudeCodeBackend` with EMMA'S REAL TOOLS, REAL PROMPT and REAL Dev DATA, driven
 * through the REAL login host and the REAL pinned `claude`, on the kept login (reuse only: no sign-in, no token handled). Haiku only. Bounded.
 * Everything except the HTTP front door (the controller's route and the worker-reachable relay, which are later PRs) is the production code path:
 * `prepareTurnContext`, `trimToolMessagesForContext`, the renderer, `EmmaToolBridgeExecutor` + `executePreparedTools`, the bridge liveness check
 * against the real Dev connection record and flags, the mapper, the persistence calls, the attempt journal.
 *
 *   sudo NODE_ENV=development AWS_REGION=us-west-2 node claudeEmmaToolsLive.js
 *
 * Writes to DEV only, and undoes it: the funding-flags row is set for ONE user and restored byte for byte (or deleted if there was none); one Dev
 * connection row (id = the kept host connection) is created and deleted; one throwaway chat session is created and deleted. Journal rows are append-only
 * and stay (Dev, run id = the throwaway session id). Read-only Emma tools only: nothing here changes a customer's data.
 *
 *   E1  a plain turn with the real prompt (reports the real prompt size)
 *   E2  a real Emma read tool through the CLI -> bridge -> executor
 *   E3  the persisted turn is replayed as history: a follow-up turn uses the earlier tool result
 *   E4  install_skills mid-turn unlocks a tool in the SAME run (the real result text), when a suitable skill exists
 *   E5  AgentWeb was not charged: no cost on the session, journal rows are on the plan, tokens are recorded
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "fs";
import AWS from "aws-sdk";
import { agentModeService } from "../../../services/agentModeService";
import { chatbotDb } from "../../../services/chatbotService";
import { userDb } from "../../../services/db";
import { settingsService } from "../../../services/settingsService";
import { stripImageDataForPersistence } from "../../../services/agentMode/incrementalPersist";
import { EMPTY_FINAL_RESPONSE_FALLBACK } from "../../../services/agentMode/core/termination";
import { isCancelled } from "../../../utils/sseProgress";
import { LoginHostClient, UnixSocketTransport } from "../../../services/funding/loginHostClient";
import { runHostTurn } from "../../../services/funding/loginHostTurn";
import { ClaudeCodeBackend, type ClaudeTurnResult } from "../../../services/funding/claudeCodeBackend";
import { ClaudeRunRegistry } from "../../../services/funding/claudeRunRegistry";
import { emmaToolBridgeExecutor, toolBridgeMcp } from "../../../services/funding/toolBridgeService";
import { getAttemptUsageJournal } from "../../../services/funding/attemptUsageJournal";
import { LLM_CONNECTIONS_TABLE, LlmConnectionDb, type LlmConnectionRecord } from "../../../services/funding/llmConnectionDb";
import { FUNDING_FLAGS_SETTING_NAME, __resetFundingFlagsCacheForTests } from "../../../services/funding/fundingFlags";
import { resolveSubscriptionRoute } from "../../../services/funding/subscriptionRoute";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const PORT = Number(process.env.AW_BRIDGE_PORT ?? 3991);
const STATE_FILE = "/var/lib/aw-probe/kept-connection.json";
const LLM = "openrouter/anthropic/claude-haiku-5.5";
const results: Array<{ name: string; ok: boolean }> = [];
const out = (k: string, v: unknown) => console.log(`RESULT ${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`);
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok });
  out(`${ok ? "PASS" : "FAIL"} ${name}`, detail === undefined ? "" : detail);
};

const dc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const connDb = new LlmConnectionDb();
const settingsTable = settingsService.getTableName();
let originalFlags: Record<string, unknown> | null | undefined;
let flagsRestored = false;
let createdConnection: string | undefined;
let createdSession: string | undefined;
let currentRunId = "";

async function restoreFlags(): Promise<void> {
  if (flagsRestored || originalFlags === undefined) return;
  if (originalFlags === null) await dc.delete({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  else await dc.put({ TableName: settingsTable, Item: originalFlags }).promise();
  flagsRestored = true;
  __resetFundingFlagsCacheForTests();
}

const http = createServer((req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", async () => {
    try {
      req.body = body ? JSON.parse(body) : undefined;
    } catch {
      /* leave undefined */
    }
    try {
      if (!(await toolBridgeMcp.handle(req, res, currentRunId))) res.writeHead(404).end();
    } catch (e) {
      console.error("handler error:", (e as Error).message);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
});

const client = new LoginHostClient(new UnixSocketTransport(SOCK));
const registry = new ClaudeRunRegistry();
const journalRows: any[] = [];
const realJournal = getAttemptUsageJournal();
let n = 0;

const backend = new ClaudeCodeBackend({
  hostClient: () => client,
  prepareTurnContext: (input) => agentModeService.prepareTurnContext(input),
  trimToolMessages: (m) => agentModeService.trimToolMessagesForContext(m),
  runHostTurn,
  bridge: toolBridgeMcp,
  executor: emmaToolBridgeExecutor,
  registry,
  isCancelled,
  persistMessages: async (s, m) => void (await chatbotDb.addMessagesToSession(s, stripImageDataForPersistence(m))),
  markNeedsReconnect: async () => undefined,
  writeJournal: async (row) => {
    journalRows.push(row);
    await realJournal.record(row);
  },
  emptyFallbackText: EMPTY_FINAL_RESPONSE_FALLBACK,
  now: () => Date.now(),
  newRunId: () => (currentRunId = `claude-live-e-${++n}-${Date.now().toString(36)}`),
  drainTimeoutMs: 10_000,
});

async function chat(label: string, userId: string, cid: string, text: string): Promise<{ r: ClaudeTurnResult; seconds: number; progress: string[] }> {
  const sessionId = createdSession!;
  const stamp = new Date().toISOString();
  await chatbotDb.addMessageToSession(sessionId, { role: "user", content: text, timestamp: stamp, metadata: { portalType: "agent", timestamp: stamp, attachments: [] } } as any);
  const session = await chatbotDb.getChatSession(sessionId);
  const progress: string[] = [];
  const t0 = Date.now();
  const r = await backend.run({
    decision: { route: "claude_subscription", connectionId: cid, epoch: 1, alias: "haiku", modelId: LLM, ownerUserId: userId },
    sessionId,
    userId,
    messageContent: text,
    sessionHistory: session!.messages as any[],
    llmModel: LLM,
    isDelegatedAccess: false,
    excludeTools: ["get_visual_context"],
    turnStartMs: t0,
    onProgress: (p) => void progress.push(p.status),
  });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (!r.cancelled && r.responseMessages.length > 0) await chatbotDb.addMessagesToSession(sessionId, stripImageDataForPersistence(r.responseMessages));
  out(`${label}.result`, { seconds, content: r.content.slice(0, 200), roles: r.responseMessages.map((m) => m.role), tools: r.toolCalls.map((t) => t.name), progress: [...new Set(progress)] });
  return { r, seconds, progress };
}

async function main() {
  if (!settingsTable.startsWith("Dev-") || !LLM_CONNECTIONS_TABLE.startsWith("Dev-")) throw new Error(`refusing: not Dev tables (${settingsTable}, ${LLM_CONNECTIONS_TABLE})`);
  const kept = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { connectionId: string; expiresAt: string };
  if (Date.now() > Date.parse(kept.expiresAt)) throw new Error("the kept login expired; sign in again with the 1st probe script --keep");
  const cid = kept.connectionId;

  // The user whose Dev data the tools read: the documented Dev test account, else refuse (no synthetic user would exercise real data).
  const testUser = await userDb.getUserByEmail("test@example.com");
  if (!testUser?.userId) throw new Error("no Dev test account test@example.com: cannot exercise real data");
  const userId: string = testUser.userId;
  out("setup", { user: "Dev test account", table: settingsTable });

  if (await connDb.get(cid)) throw new Error("refusing: a Dev connection row with the kept connection id already exists");
  const now = new Date().toISOString();
  await connDb.create({
    connectionId: cid, ownerUserId: userId, kind: "claude_subscription", provider: "anthropic", status: "active", keyLast4: "",
    createdAt: now, updatedAt: now, subHosted: true, subHostEpoch: 1, subNeedsReconnect: false, subType: "max", subRefreshExpiresAtMs: Date.parse(kept.expiresAt),
  } as LlmConnectionRecord);
  createdConnection = cid;

  const existing = await dc.get({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise();
  originalFlags = (existing.Item as Record<string, unknown> | undefined) ?? null;
  await settingsService.setSetting(
    FUNDING_FLAGS_SETTING_NAME,
    JSON.stringify({ byok: { enabled: false, allowUserIds: [] }, claudeSubscription: { enabled: true, allowUserIds: [userId] }, killSwitch: false }),
    "ENG-2113 live check (temporary)",
    "live-check",
  );
  __resetFundingFlagsCacheForTests();

  const decision = await resolveSubscriptionRoute({ initiatorUserId: userId, sessionOwnerUserId: userId, entry: "owner_chat", isDelegated: false, isInteractiveShare: false, model: LLM, fundingChoice: "claude_subscription" });
  check("setup: the real resolver routes the Dev test user to the plan (real flag, real connection row)", decision.route === "claude_subscription", decision.route === "stop" ? decision.reason : decision.route);
  if (decision.route !== "claude_subscription") return;

  const session = await chatbotDb.createChatSession(userId, undefined, "agent", "agent-mode");
  createdSession = session.sessionId;
  const sys = await agentModeService.getMarketingSystemPrompt();
  await chatbotDb.addMessageToSession(session.sessionId, { role: "system", content: sys, metadata: { timestamp: new Date().toISOString(), portalType: "agent" } } as any);
  out("setup", { systemPromptChars: sys.length });

  await new Promise<void>((r) => http.listen(PORT, "127.0.0.1", () => r()));

  // E1
  const e1 = await chat("E1.plain", userId, cid, "Reply with exactly one word: READY");
  check("E1 the real turn answered", /READY/i.test(e1.r.content), e1.r.content.slice(0, 80));
  check("E1 the answer is a single Emma-shaped assistant message with the registry id", e1.r.responseMessages.length === 1 && e1.r.responseMessages[0].llm === LLM);

  // D1: what the executor offers for this session, and what the CLI actually received
  emmaToolBridgeExecutor.registerRun("diag-run", { llmModel: LLM, excludeTools: ["get_visual_context"] });
  const offered = await emmaToolBridgeExecutor.resolveTools({ runId: "diag-run", userId, sessionId: session.sessionId, connectionId: cid, epoch: 1 } as any);
  emmaToolBridgeExecutor.releaseRun("diag-run");
  const offeredNames = offered.map((t) => t.name);
  out("D1.executorOffers", { count: offeredNames.length, names: offeredNames.slice(0, 60), hasInstallSkills: offeredNames.includes("install_skills"), hasListAvailableSkills: offeredNames.includes("list_available_skills") });
  const d1 = await chat("D1.cliTools", userId, cid, "List the exact names of every tool you can call whose name starts with mcp__emma__. Output only the names, comma separated, nothing else.");
  const seenByCli = (d1.r.content.match(/mcp__emma__[A-Za-z0-9_]+/g) ?? []).map((x) => x.replace(/^mcp__emma__/, ""));
  out("D1.cliSees", { count: seenByCli.length, names: seenByCli.slice(0, 60) });
  check("D1 the CLI is offered the tools the executor lists (same names)", offeredNames.length > 0 && offeredNames.every((n) => seenByCli.includes(n)), { executor: offeredNames.length, cli: seenByCli.length, missing: offeredNames.filter((n) => !seenByCli.includes(n)).slice(0, 20) });

  // E2
  const e2 = await chat("E2.readTool", userId, cid, "Call the tool mcp__emma__list_available_skills exactly once. Then tell me how many skills it listed, as a number only.");
  check("E2 a real Emma read tool ran through the CLI, bridge and executor, once", e2.r.toolCalls.filter((t) => t.name === "list_available_skills").length === 1, e2.r.toolCalls.map((t) => t.name));
  const toolMsg = e2.r.responseMessages.find((m) => m.role === "tool");
  check("E2 the tool message holds Emma's real result text", !!toolMsg && typeof toolMsg.content === "string" && toolMsg.content.length > 0 && !e2.r.toolCalls[0]?.error, toolMsg?.content?.slice(0, 120));
  check("E2 the assistant message carries OpenAI-shape tool_calls with a JSON-string arguments field", e2.r.responseMessages[0]?.tool_calls?.[0]?.function?.arguments !== undefined && typeof e2.r.responseMessages[0].tool_calls[0].function.arguments === "string");

  // E3
  const e3 = await chat("E3.replay", userId, cid, "Without calling any tool: what tool did you call earlier in this conversation? Reply with the tool name only.");
  check("E3 the follow-up turn used the persisted tool call from history (no new tool call)", /list_available_skills/.test(e3.r.content) && e3.r.toolCalls.length === 0, e3.r.content.slice(0, 80));

  // E4
  const listed: any = await agentModeService.listSkills(userId, session.sessionId);
  const skillList: any[] = Array.isArray(listed?.availableSkills) ? listed.availableSkills : Array.isArray(listed?.skills) ? listed.skills : [];
  const readTool = (s: any): string | undefined => (Array.isArray(s.toolNames) ? s.toolNames.find((t: string) => emmaToolBridgeExecutor.isReadOnly(t)) : undefined);
  const candidate = skillList.find((s: any) => readTool(s) !== undefined);
  if (!candidate) {
    out("E4.skip", { reason: "no skill with a read-only tool in the Dev library", seen: skillList.length, sample: skillList.slice(0, 3).map((s: any) => ({ id: s.skillId, tools: s.toolNames })) });
  } else {
    const tool = readTool(candidate) as string;
    const e4 = await chat("E4.install", userId, cid, `Call mcp__emma__install_skills for the skill id "${candidate.skillId}". As soon as it succeeds, call the newly available tool mcp__emma__${tool} once with no arguments (or the minimum it needs). Then reply DONE.`);
    const names = e4.r.toolCalls.map((t) => t.name);
    check("E4 install_skills ran, then the newly unlocked tool was offered and called in the SAME run", names.includes("install_skills") && names.includes(tool), names);
  }

  // E5
  const after = await chatbotDb.getChatSession(session.sessionId);
  const cost = (after as any)?.totalCost ?? 0;
  const tokens = (after as any)?.totalTokens?.total_tokens ?? 0;
  check("E5 the session was charged no cost (the plan paid), and tokens were recorded", cost === 0 && tokens > 0, { totalCost: cost, totalTokens: tokens });
  check("E5 every journal row is on the plan, for this user's connection, succeeded, with tokens", journalRows.length >= 3 && journalRows.every((j) => j.fundingSource === "claude_subscription" && j.connectionId === cid && j.userId === userId && j.outcome === "succeeded" && j.usage.inputTokens + j.usage.outputTokens > 0), journalRows.map((j) => ({ outcome: j.outcome, tokens: j.usage.inputTokens + j.usage.outputTokens + j.usage.cacheReadTokens + j.usage.cacheWriteTokens })));
  check("E5 nothing is left registered", registry.size === 0);
}

const onSignal = () => {
  restoreFlags().finally(() => process.exit(130));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

main()
  .catch((e) => check("runner", false, String((e as { code?: string }).code ?? (e as Error).message).slice(0, 300)))
  .finally(async () => {
    http.close();
    await restoreFlags().catch((e) => check("RESTORE-FAILED-FIX-BY-HAND", false, String((e as Error).message).slice(0, 200)));
    if (createdSession) await chatbotDb.deleteSession(createdSession).catch(() => undefined);
    if (createdConnection) await dc.delete({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: createdConnection } }).promise().catch(() => undefined);
    const connLeft = createdConnection ? await connDb.get(createdConnection).catch(() => null) : null;
    const sessionLeft = createdSession ? await chatbotDb.getChatSession(createdSession).catch(() => null) : null;
    const flagsNow = await dc.get({ TableName: settingsTable, Key: { settingName: FUNDING_FLAGS_SETTING_NAME } }).promise().catch(() => undefined);
    const same = originalFlags === undefined ? true : originalFlags === null ? !flagsNow?.Item : JSON.stringify(flagsNow?.Item) === JSON.stringify(originalFlags);
    check("cleanup: flags row restored exactly, connection row and session deleted", same && !connLeft && !sessionLeft, { flagsRestored: same, connectionLeft: !!connLeft, sessionLeft: !!sessionLeft });
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
  });
