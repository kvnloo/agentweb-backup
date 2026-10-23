/**
 * ENG-2113 PR A: the plan-route decision. Every rule below is a safety rule (who may run on a customer's plan, and that a failed pick never
 * turns into an AgentWeb-paid run), so each deny path has its own case.
 */
import {
  admissionPlanFor,
  DEFAULT_SERVED_ALIASES,
  PLAN_MODEL_ALIASES,
  pickHostedClaudeConnection,
  planAliasFor,
  resolveSubscriptionRoute,
  toRunFunding,
  type RouteDecision,
  type RouteInput,
  type SubscriptionRouteDeps,
} from "../subscriptionRoute";
import type { LlmConnectionRecord } from "../llmConnectionDb";

const NOW = 1_800_000_000_000;
const SONNET = "openrouter/anthropic/claude-sonnet-5.5";

const conn = (over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord =>
  ({
    connectionId: "conn-1",
    ownerUserId: "u1",
    kind: "claude_subscription",
    provider: "anthropic",
    status: "active",
    keyLast4: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    subHosted: true,
    subHostEpoch: 1,
    subRefreshExpiresAtMs: NOW + 86_400_000,
    ...over,
  }) as LlmConnectionRecord;

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  initiatorUserId: "u1",
  sessionOwnerUserId: "u1",
  entry: "owner_chat",
  isDelegated: false,
  isInteractiveShare: false,
  model: SONNET,
  fundingChoice: "claude_subscription",
  ...over,
});

function deps(over: Partial<SubscriptionRouteDeps> & { records?: LlmConnectionRecord[] } = {}): SubscriptionRouteDeps & { calls: { flag: number; list: number } } {
  const calls = { flag: 0, list: 0 };
  return {
    calls,
    isEnabledFor: over.isEnabledFor ?? (async () => (calls.flag++, true)),
    listConnections: over.listConnections ?? (async () => (calls.list++, over.records ?? [conn()])),
    now: () => NOW,
    ...(over.servedAliases ? { servedAliases: over.servedAliases } : {}),
    ...(over.lookupTimeoutMs ? { lookupTimeoutMs: over.lookupTimeoutMs } : {}),
  };
}

describe("planAliasFor", () => {
  it("maps the current-generation registry ids to the aliases the pinned CLI resolves to", () => {
    expect(planAliasFor("openrouter/anthropic/claude-haiku-5.5")).toBe("haiku");
    expect(planAliasFor(SONNET)).toBe("sonnet");
    expect(planAliasFor("openrouter/anthropic/claude-opus-5.5")).toBe("opus");
  });
  it("has no plan route for older versions, non-Claude models, junk, or prototype keys (an alias would run a different model than the one picked)", () => {
    for (const id of ["claude-opus-4-8", "anthropic.claude-sonnet-4-5-20250929-v1:0", "gpt-5", "", "__proto__", "constructor", "toString"]) {
      expect(planAliasFor(id)).toBeUndefined();
    }
    expect(planAliasFor(undefined as unknown as string)).toBeUndefined();
  });
  it("fable has an alias but is not served until the host config serves it", () => {
    expect(PLAN_MODEL_ALIASES["openrouter/anthropic/claude-fable-5.1"]).toBe("fable");
    expect(DEFAULT_SERVED_ALIASES.has("fable")).toBe(false);
    expect(planAliasFor("openrouter/anthropic/claude-fable-5.1")).toBeUndefined();
    expect(planAliasFor("openrouter/anthropic/claude-fable-5.1", new Set(["haiku", "sonnet", "opus", "fable"]))).toBe("fable");
  });
});

describe("resolveSubscriptionRoute: no pick means AgentWeb, with no I/O", () => {
  it("returns agentweb immediately when the user did not pick the plan", async () => {
    const d = deps();
    expect(await resolveSubscriptionRoute(input({ fundingChoice: undefined }), d)).toEqual({ route: "agentweb" });
    expect(d.calls).toEqual({ flag: 0, list: 0 });
  });
  it("does not even look at the entry or initiator when there is no pick (today's paths are untouched)", async () => {
    const d = deps();
    for (const entry of ["slack", "email", "scheduled", "continuation", "owner_chat"] as const) {
      expect(await resolveSubscriptionRoute(input({ fundingChoice: undefined, entry, initiatorUserId: undefined }), d)).toEqual({ route: "agentweb" });
    }
    expect(d.calls).toEqual({ flag: 0, list: 0 });
  });
});

describe("resolveSubscriptionRoute: the allow-list is default deny", () => {
  const denied: Array<[string, Partial<RouteInput>]> = [
    ["a plain admin acting in another user's session", { initiatorUserId: "admin-1", sessionOwnerUserId: "u1" }],
    ["an unknown initiator (background caller)", { initiatorUserId: undefined }],
    ["an empty initiator", { initiatorUserId: "" }],
    ["a delegated session", { isDelegated: true }],
    ["an interactive share", { isInteractiveShare: true }],
    ["a conversable visitor", { entry: "conversable" }],
    ["slack", { entry: "slack" }],
    ["email", { entry: "email" }],
    ["teams/other transports", { entry: "teams_or_other_transport" }],
    ["approval inbox resume", { entry: "approval_inbox_resume" }],
    ["plan launch", { entry: "plan_launch" }],
    ["automatic continuation", { entry: "continuation" }],
    ["scheduled", { entry: "scheduled" }],
    ["gtm plan", { entry: "gtm_plan" }],
    ["admin launch", { entry: "admin_launch" }],
    ["onboarding", { entry: "onboarding" }],
    ["an unclassified entry", { entry: "other" }],
  ];
  it.each(denied)("stops (never agentweb, never subscription) for %s", async (_name, over) => {
    const d = deps();
    expect(await resolveSubscriptionRoute(input(over), d)).toEqual({ route: "stop", reason: "not_allowed_here" });
    expect(d.calls).toEqual({ flag: 0, list: 0 }); // denied before any lookup
  });
  it("an entry value outside the union (a future string) is denied too", async () => {
    expect(await resolveSubscriptionRoute(input({ entry: "something_new" as never }), deps())).toEqual({ route: "stop", reason: "not_allowed_here" });
  });
  it("the same user as initiator and owner, plain chat, is the ONLY allowed shape", async () => {
    const d = await resolveSubscriptionRoute(input(), deps());
    expect(d.route).toBe("claude_subscription");
  });
});

describe("resolveSubscriptionRoute: flag, model, connection", () => {
  it("stops with not_enabled when the user is not enabled (flag off, kill switch or not listed)", async () => {
    expect(await resolveSubscriptionRoute(input(), deps({ isEnabledFor: async () => false }))).toEqual({ route: "stop", reason: "not_enabled" });
  });
  it("stops with lookup_failed when the flag read throws or times out (fail closed, never agentweb)", async () => {
    expect(await resolveSubscriptionRoute(input(), deps({ isEnabledFor: async () => Promise.reject(new Error("boom")) }))).toEqual({ route: "stop", reason: "lookup_failed" });
    expect(await resolveSubscriptionRoute(input(), deps({ isEnabledFor: () => new Promise<boolean>(() => undefined), lookupTimeoutMs: 20 }))).toEqual({ route: "stop", reason: "lookup_failed" });
  });
  it("stops with model_not_on_plan for a model with no alias, even with a perfect connection", async () => {
    expect(await resolveSubscriptionRoute(input({ model: "claude-opus-4-8" }), deps())).toEqual({ route: "stop", reason: "model_not_on_plan" });
    expect(await resolveSubscriptionRoute(input({ model: "gpt-5" }), deps())).toEqual({ route: "stop", reason: "model_not_on_plan" });
  });
  it("stops with lookup_failed when the connection list throws or times out", async () => {
    expect(await resolveSubscriptionRoute(input(), deps({ listConnections: async () => Promise.reject(new Error("ddb")) }))).toEqual({ route: "stop", reason: "lookup_failed" });
    expect(await resolveSubscriptionRoute(input(), deps({ listConnections: () => new Promise<LlmConnectionRecord[]>(() => undefined), lookupTimeoutMs: 20 }))).toEqual({ route: "stop", reason: "lookup_failed" });
  });
  it("returns the connection reference, epoch and alias for a good pick, owned by the session owner", async () => {
    const d = await resolveSubscriptionRoute(input(), deps({ records: [conn({ subHostEpoch: 3 })] }));
    expect(d).toEqual({ route: "claude_subscription", connectionId: "conn-1", epoch: 3, alias: "sonnet", modelId: SONNET, ownerUserId: "u1" });
  });
});

describe("pickHostedClaudeConnection", () => {
  const reason = (records: LlmConnectionRecord[]) => {
    const r = pickHostedClaudeConnection(records, NOW);
    return r.ok ? "ok" : r.reason;
  };
  it("no_connection: none, a revoked one, an api-key one, a legacy (not hosted) login", () => {
    expect(reason([])).toBe("no_connection");
    expect(reason([conn({ revokedAt: "2026-10-02T00:00:00Z" })])).toBe("no_connection");
    expect(reason([conn({ kind: "api_key" })])).toBe("no_connection");
    expect(reason([conn({ subHosted: undefined })])).toBe("no_connection");
  });
  it("needs_reconnect: invalid status or the reconnect flag", () => {
    expect(reason([conn({ status: "invalid" })])).toBe("needs_reconnect");
    expect(reason([conn({ subNeedsReconnect: true })])).toBe("needs_reconnect");
  });
  it("expired: status expired, or the fixed 30-day expiry has passed", () => {
    expect(reason([conn({ status: "expired" })])).toBe("expired");
    expect(reason([conn({ subRefreshExpiresAtMs: NOW - 1 })])).toBe("expired");
    expect(reason([conn({ subRefreshExpiresAtMs: NOW })])).toBe("expired"); // boundary: expiry at "now" is expired
  });
  it("revoked_or_disabled: revoking and disabled never route", () => {
    expect(reason([conn({ status: "revoking" })])).toBe("revoked_or_disabled");
    expect(reason([conn({ status: "disabled" })])).toBe("revoked_or_disabled");
  });
  it("an unusable epoch never routes (missing, zero, fractional)", () => {
    expect(reason([conn({ subHostEpoch: undefined })])).toBe("revoked_or_disabled");
    expect(reason([conn({ subHostEpoch: 0 })])).toBe("revoked_or_disabled");
    expect(reason([conn({ subHostEpoch: 1.5 })])).toBe("revoked_or_disabled");
  });
  it("a missing expiry is treated as not expired (older rows) but everything else must still hold", () => {
    expect(reason([conn({ subRefreshExpiresAtMs: undefined })])).toBe("ok");
  });
  it("picks the most recently updated usable connection and ignores unusable ones", () => {
    const picked = pickHostedClaudeConnection(
      [conn({ connectionId: "old", updatedAt: "2026-09-01T00:00:00Z" }), conn({ connectionId: "dead", status: "invalid", updatedAt: "2026-10-09T00:00:00Z" }), conn({ connectionId: "new", updatedAt: "2026-10-05T00:00:00Z" })],
      NOW,
    );
    expect(picked.ok && picked.record.connectionId).toBe("new");
  });
  it("prefers a usable connection over reporting the reason of an unusable one", () => {
    expect(reason([conn({ connectionId: "dead", status: "expired" }), conn({ connectionId: "ok" })])).toBe("ok");
  });
});

describe("a failed pick is never converted into an AgentWeb-paid run", () => {
  it("every non-success outcome of an explicit pick is a stop", async () => {
    const outcomes: RouteDecision[] = [
      await resolveSubscriptionRoute(input(), deps({ isEnabledFor: async () => false })),
      await resolveSubscriptionRoute(input(), deps({ records: [] })),
      await resolveSubscriptionRoute(input(), deps({ records: [conn({ status: "expired" })] })),
      await resolveSubscriptionRoute(input(), deps({ records: [conn({ status: "invalid" })] })),
      await resolveSubscriptionRoute(input({ model: "gpt-5" }), deps()),
      await resolveSubscriptionRoute(input({ isDelegated: true }), deps()),
    ];
    for (const o of outcomes) expect(o.route).toBe("stop");
  });
});

describe("toRunFunding", () => {
  it("builds a plan RunFunding that can never fall back to AgentWeb", () => {
    const decision = { route: "claude_subscription", connectionId: "c9", epoch: 4, alias: "opus", modelId: "m", ownerUserId: "u1" } as const;
    expect(toRunFunding(decision, "2026-10-23T00:00:00.000Z")).toEqual({
      route: "claude_subscription",
      connectionId: "c9",
      provider: "anthropic",
      fallback: "stop",
      ownerUserId: "u1",
      billingUserId: "u1",
      fundingPrincipalId: "u1",
      hostEpoch: 4,
      planModel: "opus",
      resolvedAt: "2026-10-23T00:00:00.000Z",
    });
  });
});

describe("admissionPlanFor", () => {
  const agentweb: RouteDecision = { route: "agentweb" };
  const plan: RouteDecision = { route: "claude_subscription", connectionId: "c", epoch: 1, alias: "sonnet", modelId: SONNET, ownerUserId: "u1" };
  const stop: RouteDecision = { route: "stop", reason: "no_connection" };

  it("an AgentWeb turn keeps every allowance gate exactly as today", () => {
    for (const allowed of [true, false]) {
      expect(admissionPlanFor(agentweb, { agentwebAllowanceAllowed: allowed })).toEqual({
        runTurn: true,
        checkAgentWebAllowanceForModel: true,
        recordPaygAdmission: true,
        applyModelPolicySwap: true,
        requirePlanEntitlement: false,
        auxiliaryAgentWebSpend: "allowed",
      });
    }
  });
  it("a plan turn is not blocked, billed or model-swapped by the AgentWeb allowance", () => {
    const p = admissionPlanFor(plan, { agentwebAllowanceAllowed: false });
    expect(p).toMatchObject({ runTurn: true, checkAgentWebAllowanceForModel: false, recordPaygAdmission: false, applyModelPolicySwap: false, requirePlanEntitlement: true });
  });
  it("auxiliary AgentWeb spend on a plan turn is refused while the allowance is paused, allowed otherwise", () => {
    expect(admissionPlanFor(plan, { agentwebAllowanceAllowed: false }).auxiliaryAgentWebSpend).toBe("refused");
    expect(admissionPlanFor(plan, { agentwebAllowanceAllowed: true }).auxiliaryAgentWebSpend).toBe("allowed");
  });
  it("a stopped decision runs nothing and spends nothing", () => {
    expect(admissionPlanFor(stop, { agentwebAllowanceAllowed: true })).toEqual({
      runTurn: false,
      checkAgentWebAllowanceForModel: false,
      recordPaygAdmission: false,
      applyModelPolicySwap: false,
      requirePlanEntitlement: false,
      auxiliaryAgentWebSpend: "refused",
    });
  });
});
