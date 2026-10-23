/**
 * ENG-2113 PR A: the plan-route decision. Every rule below is a safety rule (who may run on a customer's plan, and that a failed pick never
 * turns into an AgentWeb-paid run), so each deny path has its own case.
 */
import {
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
import { LLM_MODEL_REGISTRY } from "../../agentMode/llmModelRegistry";

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
    ["the share entry", { entry: "share" }],
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
    const r = pickHostedClaudeConnection(records, NOW, "u1");
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
      "u1",
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

describe("strict inputs: anything that is not a real false is treated as true and denied", () => {
  it.each([undefined, null, 0, "false", "", NaN])("isDelegated = %p is denied", async (v) => {
    const d = deps();
    expect(await resolveSubscriptionRoute(input({ isDelegated: v as never }), d)).toEqual({ route: "stop", reason: "not_allowed_here" });
    expect(d.calls).toEqual({ flag: 0, list: 0 });
  });
  it.each([undefined, null, 0, "false", "", NaN])("isInteractiveShare = %p is denied", async (v) => {
    expect(await resolveSubscriptionRoute(input({ isInteractiveShare: v as never }), deps())).toEqual({ route: "stop", reason: "not_allowed_here" });
  });
  it("ids are compared exactly: case, whitespace and unicode normalization differences are denied", async () => {
    for (const initiatorUserId of ["U1", "u1 ", " u1", "u1\u0000", "\u0075\u0031\u200b"]) {
      expect(await resolveSubscriptionRoute(input({ initiatorUserId }), deps())).toEqual({ route: "stop", reason: "not_allowed_here" });
    }
    expect(await resolveSubscriptionRoute(input({ sessionOwnerUserId: "caf\u00e9", initiatorUserId: "cafe\u0301" }), deps())).toEqual({ route: "stop", reason: "not_allowed_here" });
  });
});

describe("the connection must belong to the session owner, whatever the list contains", () => {
  it("ignores a record owned by someone else even if the lookup returned it", async () => {
    const d = await resolveSubscriptionRoute(input(), deps({ records: [conn({ ownerUserId: "u2", connectionId: "theirs" })] }));
    expect(d).toEqual({ route: "stop", reason: "no_connection" });
  });
  it("takes the funding owner from the session owner, never from the record", async () => {
    const d = await resolveSubscriptionRoute(input(), deps({ records: [conn({ connectionId: "mine" }), conn({ ownerUserId: "u2", connectionId: "theirs", updatedAt: "2030-01-01T00:00:00Z" })] }));
    expect(d).toMatchObject({ route: "claude_subscription", connectionId: "mine", ownerUserId: "u1" });
  });
  it("a lookup that returns something that is not a list is a lookup failure, not a crash and not agentweb", async () => {
    for (const bad of [undefined, null, {}, "x"]) {
      expect(await resolveSubscriptionRoute(input(), deps({ listConnections: async () => bad as never }))).toEqual({ route: "stop", reason: "lookup_failed" });
    }
    expect(await resolveSubscriptionRoute(input(), deps({ listConnections: async () => [null as never] }))).toEqual({ route: "stop", reason: "lookup_failed" });
  });
  it("a dependency that throws synchronously fails closed", async () => {
    const boom = () => {
      throw new Error("sync");
    };
    expect(await resolveSubscriptionRoute(input(), deps({ isEnabledFor: boom as never }))).toEqual({ route: "stop", reason: "lookup_failed" });
    expect(await resolveSubscriptionRoute(input(), deps({ listConnections: boom as never }))).toEqual({ route: "stop", reason: "lookup_failed" });
  });
});

describe("pickHostedClaudeConnection: more shapes", () => {
  const pick = (records: LlmConnectionRecord[]) => pickHostedClaudeConnection(records, NOW, "u1");
  it("an unusable expiry value counts as expired, an absent one does not", () => {
    for (const bad of [Number.NaN, "999999999999999" as unknown as number, Infinity * 0, -5]) {
      const r = pick([conn({ subRefreshExpiresAtMs: bad })]);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe("expired");
    }
    expect(pick([conn({ subRefreshExpiresAtMs: undefined })]).ok).toBe(true);
  });
  it("an unknown status string never routes", () => {
    const r = pick([conn({ status: "weird" as never })]);
    expect(!r.ok && r.reason).toBe("revoked_or_disabled");
  });
  it("status revoked without a revokedAt still never routes", () => {
    const r = pick([conn({ status: "revoked" })]);
    expect(!r.ok && r.reason).toBe("revoked_or_disabled");
  });
  it("expired is reported before needs_reconnect when both are present", () => {
    const r = pick([conn({ connectionId: "a", status: "expired" }), conn({ connectionId: "b", status: "invalid", subNeedsReconnect: true })]);
    expect(!r.ok && r.reason).toBe("expired");
  });
  it("ties are broken deterministically: newest, then higher epoch, then lowest id; a missing updatedAt falls back to createdAt", () => {
    const same = "2026-10-05T00:00:00Z";
    const a = pick([conn({ connectionId: "b", updatedAt: same, subHostEpoch: 2 }), conn({ connectionId: "a", updatedAt: same, subHostEpoch: 2 }), conn({ connectionId: "c", updatedAt: same, subHostEpoch: 7 })]);
    expect(a.ok && a.record.connectionId).toBe("c");
    const b = pick([conn({ connectionId: "b", updatedAt: same, subHostEpoch: 2 }), conn({ connectionId: "a", updatedAt: same, subHostEpoch: 2 })]);
    expect(b.ok && b.record.connectionId).toBe("a");
    // ids deliberately sort the OTHER way round from the dates, so only the createdAt fallback can pick the newer one
    const c = pick([conn({ connectionId: "a-older", updatedAt: undefined, createdAt: "2026-01-01T00:00:00Z" }), conn({ connectionId: "z-newer", updatedAt: undefined, createdAt: "2026-06-01T00:00:00Z" })]);
    expect(c.ok && c.record.connectionId).toBe("z-newer");
  });
});

describe("check order and timers", () => {
  it("the flag is checked before the model: an unlisted user with an unservable model sees not_enabled, not model_not_on_plan", async () => {
    expect(await resolveSubscriptionRoute(input({ model: "gpt-5" }), deps({ isEnabledFor: async () => false }))).toEqual({ route: "stop", reason: "not_enabled" });
  });
  it("leaves no timer behind after a normal answer, a failure or a timeout", async () => {
    jest.useFakeTimers();
    try {
      await resolveSubscriptionRoute(input(), deps());
      await resolveSubscriptionRoute(input(), deps({ isEnabledFor: async () => Promise.reject(new Error("x")) }));
      const slow = resolveSubscriptionRoute(input(), deps({ isEnabledFor: () => new Promise<boolean>(() => undefined), lookupTimeoutMs: 50 }));
      jest.advanceTimersByTime(60);
      expect(await slow).toEqual({ route: "stop", reason: "lookup_failed" });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("alias table vs the real model registry", () => {
  it("every key is a real registry id, so a rename fails CI instead of silently disabling the plan route", () => {
    for (const id of Object.keys(PLAN_MODEL_ALIASES)) expect((LLM_MODEL_REGISTRY as Record<string, unknown>)[id]).toBeDefined();
  });
  it("pins today's visibility: haiku-5.5 and sonnet-5.5 are admin-only in the registry, opus-5.5 and fable-5.1 are not (picker visibility is an L5 decision)", () => {
    const adminOnly = (id: string) => (LLM_MODEL_REGISTRY as Record<string, { adminOnly?: boolean } | undefined>)[id]?.adminOnly === true;
    expect(adminOnly("openrouter/anthropic/claude-haiku-5.5")).toBe(true);
    expect(adminOnly("openrouter/anthropic/claude-sonnet-5.5")).toBe(true);
    expect(adminOnly("openrouter/anthropic/claude-opus-5.5")).toBe(false);
    expect(adminOnly("openrouter/anthropic/claude-fable-5.1")).toBe(false);
  });
});

describe("toRunFunding billing subject", () => {
  const decision = { route: "claude_subscription", connectionId: "c9", epoch: 4, alias: "opus", modelId: "m", ownerUserId: "member-1" } as const;
  it("defaults to the owner, and takes the controller's resolved billing subject (the org root) when given", () => {
    expect(toRunFunding(decision, "t").billingUserId).toBe("member-1");
    expect(toRunFunding(decision, "t", "org-root-9")).toMatchObject({ billingUserId: "org-root-9", ownerUserId: "member-1", fundingPrincipalId: "member-1", fallback: "stop" });
  });
});
