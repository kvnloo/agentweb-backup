/**
 * ENG-2113 approval cards: MANUAL live test, on the TEST BOX (host test1), of approval decks on the Claude plan route. The REAL `ClaudeCodeBackend` (relay on, post-halt
 * siblings admitted, exactly the production instance's settings), the REAL ToolBridge (MCP adapter), the REAL `runHostTurn`, the REAL login host + the REAL pinned
 * `claude`, on the KEPT login (reuse only: this script never opens, prints or types a credential), and the REAL `AgentModeService.stageApprovalDeckForPlanTurn` and
 * `submitApprovalDeckAnswers` against the real DEV DynamoDB tables (a throwaway chat session of the Dev test account, deleted at the end). The only fakes are the three
 * scripted tools behind the bridge (`live_ad_change`: a Meta-write-shaped preview, `live_ask`: a question-deck halt, `live_read`: a read). No Meta, CRM, customer or
 * Dev business data is touched; no deck item is ever APPROVED for a write (the only answer given is to a question deck, which runs nothing).
 *
 * Models: Haiku AND Sonnet, one after the other, results per model. Never Opus or Fable. AW_LIVE_ALIAS=haiku|sonnet restricts a run to one model.
 *
 *   bundle (from backend/):  npx esbuild src/loginHost/__tests__/live/claudeCardsLive.ts --bundle --platform=node --target=node22 --log-level=error --external:'*.node' --outfile=/tmp/claudeCardsLive.js
 *   run on the box:          sudo NODE_ENV=development AWS_REGION=us-west-2 node /tmp/claudeCardsLive.js [--all]
 *
 *   K1  three previews in ONE message: the real CLI sends them as siblings, all three run, ONE deck of three items (in call order, distinct digests) is staged and
 *       written to the Dev session; the visible answer is the deck prompt and not the model's own text; a fourth call asked for afterwards never runs
 *   K2  a read and two previews in one message: the read runs and is answered, the deck holds the two previews only
 *   K3  a preview asked for in a LATER message (after the halt) never runs; the deck holds the first one only
 *   K4  a question deck, answered through the real submitApprovalDeckAnswers with the NON-recommended option; the next plan turn is handed the outcome and the model
 *       names the option that was chosen (not the recommended one) and does not ask again
 *   K5  a second halt while a deck still waits: no second deck, the first deck is untouched, the answer is the plain confirmation prompt
 *   K6  (model independent, once) a large deck (many previews with big parameters) against the real Dev table: it persists whole, or it throws and nothing is left behind
 */
import { readFileSync } from "fs";
import AWS from "aws-sdk";
import { randomBytes } from "crypto";
import { agentModeService } from "../../../services/agentModeService";
import { chatbotDb, dynamodb as chatDynamo } from "../../../services/chatbotService";
import { userDb } from "../../../services/db";
import { renderApprovalDeckPrompt } from "../../../services/agentMode/core/approvalDeck";
import { stripImageDataForPersistence } from "../../../services/agentMode/incrementalPersist";
import { EMPTY_FINAL_RESPONSE_FALLBACK } from "../../../services/agentMode/core/termination";
import { LoginHostClient, UnixSocketTransport } from "../../../services/funding/loginHostClient";
import { runHostTurn, type HostTurnOutcome } from "../../../services/funding/loginHostTurn";
import { ToolBridge, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps } from "../../../services/funding/toolBridge";
import { ToolBridgeMcpAdapter } from "../../../services/funding/toolBridgeMcp";
import { ClaudeRunRegistry } from "../../../services/funding/claudeRunRegistry";
import { ClaudeCodeBackend, type ClaudeBackendDeps, type ClaudeTurnParams, type ClaudeTurnResult } from "../../../services/funding/claudeCodeBackend";
import { ClaudeRouteStopError } from "../../../services/funding/claudeRouteErrors";
import { PROTOCOL_VERSION } from "../../protocol";

type Alias = "haiku" | "sonnet";
const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const STATE_FILE = "/var/lib/aw-probe/kept-connection.json";
if (process.env.AW_LIVE_ALIAS && process.env.AW_LIVE_ALIAS !== "haiku" && process.env.AW_LIVE_ALIAS !== "sonnet") throw new Error("the kept login runs haiku or sonnet only");
const ALIASES: Alias[] = process.env.AW_LIVE_ALIAS ? [process.env.AW_LIVE_ALIAS as Alias] : ["haiku", "sonnet"];
let ALIAS: Alias = ALIASES[0];
const llm = () => `openrouter/anthropic/claude-${ALIAS}-5.5`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const out = (k: string, v: unknown) => console.log(`RESULT ${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`);
const tally: Record<string, { checks: number; failed: string[]; skipped: string[] }> = {};
const bucket = () => (tally[ALIAS] ??= { checks: 0, failed: [], skipped: [] });
function check(id: string, name: string, ok: boolean, detail?: unknown) {
  const b = bucket();
  b.checks++;
  if (!ok) b.failed.push(`${id} ${name}`);
  out(`${ok ? "PASS" : "FAIL"} [${ALIAS}] ${id} ${name}`, detail === undefined ? "" : detail);
}
function skip(id: string, name: string, why: unknown) {
  bucket().skipped.push(`${id} ${name}`);
  out(`SKIP [${ALIAS}] ${id} ${name}`, why);
}
const nonce = () => "N" + randomBytes(4).toString("hex").toUpperCase();

// ───────────────────────────── the scripted tools ─────────────────────────────
const exec = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, nonces: [] as string[] };
const base = { isError: false, requiresConfirmation: false, toolsChanged: false };
const reply = (content: string, extra: Partial<BridgeExecuteOutcome> = {}): BridgeExecuteOutcome => ({ ...base, content, ...extra });
const str = { type: "string" };
const defs = new Map<string, { tool: BridgeTool; readOnly: boolean }>([
  ["live_ad_change", { readOnly: false, tool: { name: "live_ad_change", description: "Previews a change to an ad (a write). Nothing is changed until the user approves it on a card.", inputSchema: { type: "object", properties: { name: str }, required: ["name"] } } }],
  ["live_ask", { readOnly: false, tool: { name: "live_ask", description: "Asks the user a multiple-choice question on a card. Nothing else happens until they answer.", inputSchema: { type: "object", properties: { question: str }, required: ["question"] } } }],
  ["live_read", { readOnly: true, tool: { name: "live_read", description: "Reads a value and returns a marker. Read-only.", inputSchema: { type: "object", properties: { q: str }, required: ["q"] } } }],
]);
const DISPATCH = { entity_type: "AD", action: "UPDATE", account_id: "000000000000001", campaign_id: "c1", ad_set_id: "s1", ad_id: "a1" };
function adChangeResult(name: string, pad = 0) {
  const digest = `live-digest-${name}-${randomBytes(4).toString("hex")}`;
  return {
    success: true,
    requiresConfirmation: true,
    awaitingUserConfirmation: true,
    confirmationPrompt: `Rename the ad to "${name}"`,
    confirmationDetail: `Rename the ad to "${name}"`,
    summary: `Rename the ad to "${name}"`,
    target: { account_id: DISPATCH.account_id },
    metaWriteManifestDigest: digest,
    metaWriteDispatch: { ...DISPATCH, resolvedAccountId: DISPATCH.account_id, params: { name, padding: "x".repeat(pad) } },
  };
}
const askResult = (question: string) => ({
  success: true,
  awaitingUserConfirmation: true,
  questionDeckPayload: [
    {
      question,
      options: [
        { id: "a", label: "Leads", consequence: "Focus on leads first", recommended: true, why: "Cheapest to test" },
        { id: "b", label: "Sales", consequence: "Focus on sales first" },
      ],
    },
  ],
});
const open = new Set<string>();
const toolDeps: ToolBridgeDeps & { registerRun(r: string, c: unknown): void; beginTurn(r: string, t: unknown): void; releaseRun(r: string): void } = {
  resolveTools: async () => [...open].map((n) => defs.get(n)!.tool),
  isReadOnly: (n) => defs.get(n)?.readOnly === true,
  isStrictEffect: (n) => n === "live_ad_change",
  isLive: async () => true,
  registerRun: () => undefined,
  beginTurn: () => undefined,
  releaseRun: () => undefined,
  execute: async (_run, call): Promise<BridgeExecuteOutcome> => {
    exec.calls.push({ name: call.name, args: call.args });
    if (call.name === "live_ad_change") {
      const name = String(call.args.name);
      return reply(`Preview: rename the ad to "${name}". This needs the user's confirmation. Nothing has been changed.`, { requiresConfirmation: true, result: adChangeResult(name) });
    }
    if (call.name === "live_ask") {
      const q = String(call.args.question);
      return reply(`The question "${q}" was put to the user. Waiting for their answer.`, { requiresConfirmation: true, result: askResult(q) });
    }
    if (call.name === "live_read") {
      const n = nonce();
      exec.nonces.push(n);
      return reply(`READ_${String(call.args.q)} MARKER=${n}`);
    }
    return reply("unknown tool", { isError: true });
  },
};
const adapter = new ToolBridgeMcpAdapter(new ToolBridge(toolDeps));
const registry = new ClaudeRunRegistry();
const client = new LoginHostClient(new UnixSocketTransport(SOCK));
let hostProtocol = 0;
let hostText = "";
let n = 0;
let history: any[] = [];
const staged: Array<{ sessionId: string; results: unknown[] }> = [];
const recordingRunHostTurn: ClaudeBackendDeps["runHostTurn"] = async (c, req, opts) => {
  const o: HostTurnOutcome = await runHostTurn(c, req, opts);
  hostText = o.kind === "completed" && "text" in o.result ? String((o.result as { text?: string }).text ?? "") : "";
  return o;
};
const backend = new ClaudeCodeBackend({
  hostClient: () => client,
  prepareTurnContext: async () => ({ messages: history }),
  trimToolMessages: (m) => m,
  runHostTurn: recordingRunHostTurn,
  bridge: adapter,
  executor: toolDeps,
  registry,
  relay: { workerProtocol: () => hostProtocol, protocolStatus: () => (hostProtocol === PROTOCOL_VERSION ? "match" : "mismatch"), allowLegacyBridge: () => false },
  // exactly the production instance's settings (claudeCodeBackendInstance.ts)
  relayAdmitPostHaltSiblings: true,
  stageApprovalDeck: async (sessionId, results) => {
    staged.push({ sessionId, results });
    return agentModeService.stageApprovalDeckForPlanTurn(sessionId, results as any[]);
  },
  isCancelled: () => false,
  persistMessages: async () => undefined,
  markNeedsReconnect: async () => undefined,
  writeJournal: async () => undefined,
  emptyFallbackText: EMPTY_FINAL_RESPONSE_FALLBACK,
  now: () => Date.now(),
  newRunId: () => `cards-live-${++n}-${Date.now().toString(36)}`,
  drainTimeoutMs: 8_000,
  lateWatchPollMs: 2_000,
  lateWatchMaxMs: 60_000,
});

// HARNESS ONLY: chatbotService builds its DynamoDB client with explicit (possibly empty) static keys, which masks the box's instance role. On the test box there are no
// static keys in this process, so that one client is pointed at the instance role (metadata credentials). Production code is untouched.
(chatDynamo as unknown as { service: { config: { update(c: unknown): void } } }).service.config.update({ credentials: new AWS.EC2MetadataCredentials({ httpOptions: { timeout: 5_000 }, maxRetries: 3 }) });

let kept: { connectionId: string; expiresAt: string } | undefined;
let userId = "";
const sessions: string[] = [];
const SYSTEM = "You are a concise assistant. Use the tools exactly as asked, in the order asked, and no others. When asked for several calls 'in the same message', issue ALL of them together as parallel tool calls in ONE message. Reply in as few words as possible.";
const q = (name: string) => `mcp__emma__${name}`;

async function newSession(): Promise<string> {
  const s = await chatbotDb.createChatSession(userId, undefined, "agent", "agent-mode");
  sessions.push(s.sessionId);
  return s.sessionId;
}
async function turn(label: string, sessionId: string, user: string): Promise<{ r?: ClaudeTurnResult; stop?: ClaudeRouteStopError; seconds: number; hostText: string }> {
  history = [...history.filter((m) => m.role !== "system"), { role: "user", content: user }];
  history.unshift({ role: "system", content: SYSTEM });
  exec.calls = [];
  exec.nonces = [];
  staged.length = 0;
  open.clear();
  for (const k of defs.keys()) open.add(k);
  const t0 = Date.now();
  try {
    const p: ClaudeTurnParams = {
      decision: { route: "claude_subscription", connectionId: kept!.connectionId, epoch: 1, alias: ALIAS, modelId: llm(), ownerUserId: userId },
      sessionId,
      userId,
      messageContent: user,
      sessionHistory: [],
      llmModel: llm(),
      turnStartMs: Date.now(),
    } as ClaudeTurnParams;
    const r = await backend.run(p);
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    out(`${label}.result`, { seconds, content: r.content.slice(0, 160), calls: exec.calls.map((c) => `${c.name}:${String(c.args.name ?? c.args.q ?? c.args.question ?? "")}`), deck: r.pendingApprovalDeck?.deckId, items: r.pendingApprovalDeck?.items.length });
    // The controller's persistence step: the turn's messages go to the chat, so the next turn and a reload see them.
    if (r.responseMessages.length > 0) await chatbotDb.addMessagesToSession(sessionId, stripImageDataForPersistence(r.responseMessages));
    history = [...history.filter((m) => m.role !== "system"), ...r.responseMessages.map((m: any) => ({ ...m }))];
    return { r, seconds, hostText };
  } catch (e) {
    if (e instanceof ClaudeRouteStopError) {
      out(`${label}.stop`, { code: e.code, status: e.httpStatus });
      return { stop: e, seconds: Math.round((Date.now() - t0) / 100) / 10, hostText };
    }
    out(`${label}.error`, String((e as Error).message ?? e).slice(0, 240));
    throw e;
  }
}
/** A case only means something if the model really made the calls: up to three tries on fresh sessions, said out loud. */
async function until(label: string, user: string, enough: () => boolean): Promise<{ session: string; run: Awaited<ReturnType<typeof turn>>; ok: boolean }> {
  let session = "";
  let run!: Awaited<ReturnType<typeof turn>>;
  for (let attempt = 1; attempt <= 3; attempt++) {
    session = await newSession();
    history = [];
    run = await turn(label, session, user);
    if (enough()) return { session, run, ok: true };
    out(`${label}.retry`, { attempt, calls: exec.calls.map((c) => c.name), note: "the model did not make the expected calls, so this case cannot be judged; trying again" });
    await sleep(2_000);
  }
  return { session, run, ok: false };
}
const names = () => exec.calls.filter((c) => c.name === "live_ad_change").map((c) => String(c.args.name));
const deckOf = async (sessionId: string) => (await chatbotDb.getChatSession(sessionId, true))?.pendingApprovalDeck;

// ───────────────────────────── the checks ─────────────────────────────
async function k1() {
  const { session, run, ok } = await until("K1", `Call ${q("live_ad_change")} three times IN THE SAME MESSAGE, with name='alpha', name='beta' and name='gamma'. After the results, say one short sentence about what you did. Then, if you can, call ${q("live_ad_change")} a fourth time with name='delta'.`, () => names().length >= 2);
  if (!ok || !run.r) return skip("K1", "three previews in one message", { calls: exec.calls, note: "the model never made at least two sibling calls in 3 tries" });
  const r = run.r;
  const deck = await deckOf(session);
  const items = r.pendingApprovalDeck?.items ?? [];
  check("K1", "all previews of the message ran (siblings admitted after the first halt) and the later 'delta' call never did", names().length >= 2 && !names().includes("delta"), { ran: names() });
  check("K1", "the stager was called ONCE with every halt of the message, in call order", staged.length === 1 && staged[0].results.length === names().length && staged[0].results.every((x: any, i) => String(x?.summary).includes(names()[i])), { stagedCalls: staged.length, results: staged[0]?.results.length, ran: names() });
  check("K1", "ONE deck with one meta_write item per preview (distinct digests) is written to the Dev session and is the deck returned", !!deck && deck.deckId === r.pendingApprovalDeck?.deckId && deck.status === "awaiting" && items.length === names().length && items.every((i) => i.kind === "meta_write") && new Set(items.map((i) => i.metaWriteManifestDigest)).size === items.length, { deckId: deck?.deckId, kinds: items.map((i) => i.kind), session: session.slice(0, 8) });
  check("K1", "the visible answer is the deck prompt, not the model's own words", !!r.pendingApprovalDeck && r.content === renderApprovalDeckPrompt(r.pendingApprovalDeck) && (hostText.length === 0 || !r.content.includes(hostText.slice(0, 40))), { modelSaid: hostText.slice(0, 80) });
  const last: any = r.responseMessages[r.responseMessages.length - 1];
  check("K1", "the halt message carries the card metadata exactly as Emma's chat does (deck id + items + awaiting flag) and the plan stamp", last?.metadata?.pendingApprovalDeckId === r.pendingApprovalDeck?.deckId && Array.isArray(last?.metadata?.approvalDeckItems) && last?.metadata?.awaitingUserConfirmation === true && last?.metadata?.funding === "subscription", Object.keys(last?.metadata ?? {}));
  check("K1", "nothing is left registered or running", registry.size === 0);
}
async function k2() {
  const { session, run, ok } = await until("K2", `In the SAME MESSAGE call ${q("live_read")} with q='one', ${q("live_ad_change")} with name='kappa' and ${q("live_ad_change")} with name='lambda'. Then say one short sentence.`, () => exec.calls.some((c) => c.name === "live_read") && names().length >= 1);
  if (!ok || !run.r) return skip("K2", "read + previews in one message", { calls: exec.calls });
  const deck = await deckOf(session);
  const toolMsgs = run.r.responseMessages.filter((m: any) => m.role === "tool");
  check("K2", "the read ran and its answer is in the transcript; the deck holds the previews only", exec.nonces.length === 1 && toolMsgs.some((m: any) => String(m.content).includes(exec.nonces[0])) && (deck?.items.length ?? 0) === names().length && deck!.items.every((i) => i.kind === "meta_write"), { previews: names(), deckItems: deck?.items.length });
}
async function k3() {
  const { session, run, ok } = await until("K3", `Call ${q("live_ad_change")} with name='zeta' FIRST and wait for its result. After you see the result, call ${q("live_ad_change")} with name='eta' as well, then say one short sentence.`, () => names().includes("zeta"));
  if (!ok || !run.r) return skip("K3", "a later-message preview", { calls: exec.calls });
  const deck = await deckOf(session);
  const attempted = run.r.toolCalls.some((t: any) => String(JSON.stringify(t.arguments)).includes("eta"));
  check("K3", "a preview asked for AFTER the halt (a later message) never ran; the deck holds the first one only", !names().includes("eta") && deck?.items.length === 1, { ran: names(), laterAttempted: attempted, deckItems: deck?.items.length });
  if (!attempted) skip("K3", "the model did not attempt the later call, so its refusal was not exercised", "soft: the property (it never ran) holds either way");
}
async function k4() {
  const { session, run, ok } = await until("K4", `Call ${q("live_ask")} with question='Which audience should we target first?' and nothing else. Then say one short sentence.`, () => exec.calls.some((c) => c.name === "live_ask"));
  if (!ok || !run.r) return skip("K4", "question deck", { calls: exec.calls });
  const deck = await deckOf(session);
  check("K4", "a question deck of one item is written (plan_choice, two options, one recommended)", !!deck && deck.items.length === 1 && deck.items[0].kind === "plan_choice" && deck.items[0].options?.length === 2, { items: deck?.items.length });
  if (!deck) return;
  const answered = await agentModeService.submitApprovalDeckAnswers(session, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: "b" }] as any, "user");
  check("K4", "the answer (the NON-recommended option 'Sales') is accepted by the real answer path", answered.outcome === "submitted", answered.outcome);
  if (answered.outcome !== "submitted") return;
  const picked = answered.answeredDeck.items[0].options?.find((o) => o.id === "b")?.label ?? "b";
  // the controller's own outcome text for a question deck, handed to the model with the user's message
  const directive = `[Approval deck outcome: ${JSON.stringify({ status: "answered", selections: [{ itemId: deck.items[0].itemId, question: deck.items[0].question, selected: picked }] })}]`;
  const t2 = await turn("K4.next", session, `Chose ${picked}\n\n${directive} Tell me in one short sentence which audience the user chose, and do not ask the question again.`);
  const text = t2.r?.content ?? "";
  check("K4", "the next plan turn names the option that was CHOSEN (Sales), not the recommended one, and does not ask again", /sales/i.test(text) && !exec.calls.some((c) => c.name === "live_ask"), { answer: text.slice(0, 140), calls: exec.calls.map((c) => c.name) });
  check("K4", "that next turn wrote no new deck", (await deckOf(session))?.status !== "awaiting" || (await deckOf(session))?.deckId === deck.deckId);
}
async function k5() {
  const { session, run, ok } = await until("K5.first", `Call ${q("live_ad_change")} with name='mu', then say one short sentence.`, () => names().includes("mu"));
  if (!ok || !run.r) return skip("K5", "second halt while a deck waits", { calls: exec.calls });
  const first = await deckOf(session);
  const t2 = await turn("K5.second", session, `Call ${q("live_ad_change")} with name='nu', then say one short sentence.`);
  const after = await deckOf(session);
  check("K5", "a second halt while a deck still waits writes NO second deck: the first deck is untouched and the answer is the plain confirmation prompt", !!first && after?.deckId === first.deckId && after.items.length === first.items.length && t2.r?.pendingApprovalDeck === undefined && /nu/.test(t2.r?.content ?? ""), { firstDeck: first?.deckId?.slice(0, 8), after: after?.deckId?.slice(0, 8), answer: (t2.r?.content ?? "").slice(0, 120) });
}
async function k6() {
  const session = await newSession();
  const big = (count: number, pad: number) => Array.from({ length: count }, (_, i) => adChangeResult(`big-${i}`, pad));
  for (const [count, pad] of [[12, 2_000], [64, 6_000]] as Array<[number, number]>) {
    const s = await newSession();
    let threw = "";
    let kind = "";
    try {
      kind = (await agentModeService.stageApprovalDeckForPlanTurn(s, big(count, pad))).kind;
    } catch (e) {
      threw = String((e as Error).message ?? e).slice(0, 120);
    }
    const deck = await deckOf(s);
    check("K6", `${count} previews x ${pad} bytes: the deck persists whole, or it throws and NOTHING is left behind`, (kind === "deck" && deck?.items.length === count && !threw) || (!!threw && !deck) || (kind === "text" && !deck), { kind, threw, items: deck?.items.length });
  }
  void session;
}

async function main() {
  kept = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { connectionId: string; expiresAt: string };
  if (Date.now() > Date.parse(kept.expiresAt)) throw new Error("the kept login expired; ask Manan to sign in again with b4-probe-live.sh --keep");
  const host = await client.hostInfo();
  hostProtocol = host.protocol;
  out("preflight", { hostProtocol, expectProtocol: PROTOCOL_VERSION, keptDaysLeft: Math.round(((Date.parse(kept.expiresAt) - Date.now()) / 86_400_000) * 10) / 10 });
  if (hostProtocol !== PROTOCOL_VERSION) throw new Error("the test host does not speak the relay protocol");
  const testUser = await userDb.getUserByEmail("test@example.com");
  if (!testUser?.userId) throw new Error("no Dev test account test@example.com");
  userId = testUser.userId;
  out("setup", { user: "Dev test account", sessionsAreThrowaway: true });
  for (const alias of ALIASES) {
    ALIAS = alias;
    out("model", alias);
    await k1();
    await k2();
    await k3();
    await k4();
    await k5();
  }
  ALIAS = ALIASES[0];
  await k6();
}

main()
  .catch((e) => check("runner", "the run completed", false, String((e as { code?: string }).code ?? (e as Error).message).slice(0, 300)))
  .finally(async () => {
    for (const s of sessions) await chatbotDb.deleteSession(s).catch(() => undefined);
    let left = 0;
    for (const s of sessions) if (await chatbotDb.getChatSession(s).catch(() => null)) left++;
    check("cleanup", "every throwaway Dev session was deleted", left === 0, { created: sessions.length, left });
    for (const [alias, t] of Object.entries(tally)) out(`SUMMARY [${alias}]`, { checks: t.checks, failed: t.failed, skipped: t.skipped });
    const failed = Object.values(tally).some((t) => t.failed.length > 0);
    setTimeout(() => process.exit(failed ? 1 : 0), 500);
  });
