import { classifyFailureText, normalizeClaudeEvent, parseAuthStatus, parseDoctorHazards, usageFromResult } from "../adapters/claudeParse";

const OK_DOCTOR = [
  "Diagnostics",
  " └ Managed settings (remote): not fetched — requires an Enterprise or Team subscription",
  " └ Organization policy: not applicable to Pro and Max accounts",
].join("\n");

describe("parseAuthStatus", () => {
  it("reads the signed-in Max shape (null org/email) without a fingerprint", () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":null,"orgId":null,"orgName":null}')).toEqual({ loggedIn: true, planLabel: "max", orgPresent: false });
  });
  it("reads logged out, and an org login", () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({ loggedIn: false, orgPresent: false });
    expect(parseAuthStatus('{"loggedIn":true,"subscriptionType":"team","orgId":"o1"}')).toMatchObject({ loggedIn: true, planLabel: "team", orgPresent: true });
  });
  it("tolerates surrounding text and ANSI, and rejects non-JSON or a missing loggedIn", () => {
    expect(parseAuthStatus('\x1b[2mnote\x1b[0m {"loggedIn":true,"subscriptionType":"pro"} done')).toMatchObject({ loggedIn: true, planLabel: "pro" });
    for (const bad of ["", "not json", "{}", '{"loggedIn":"yes"}', "[1,2]", "{broken"]) expect(parseAuthStatus(bad)).toBeUndefined();
  });
  it("drops a plan label that is not a short token (no CLI text leaks into the record)", () => {
    expect(parseAuthStatus('{"loggedIn":true,"subscriptionType":"max\\nsecret=1"}')?.planLabel).toBeUndefined();
  });
});

describe("parseDoctorHazards (fail closed)", () => {
  it("the verified Pro/Max wording is clean", () => expect(parseDoctorHazards(OK_DOCTOR)).toEqual([]));
  it("missing lines => other (unrecognised), never clean", () => {
    expect(parseDoctorHazards("")).toEqual([{ kind: "other", detail: "doctor_output_unrecognised" }]);
    expect(parseDoctorHazards("Managed settings (remote): not fetched — requires an Enterprise or Team subscription")).toEqual([{ kind: "other", detail: "doctor_output_unrecognised" }]);
  });
  it("any other managed-settings wording => managed_settings_present", () => {
    expect(parseDoctorHazards(OK_DOCTOR.replace("not fetched — requires an Enterprise or Team subscription", "fetched, 3 settings applied"))).toEqual([{ kind: "managed_settings_present" }]);
  });
  it("any other policy wording => policy_blocks_agentweb with a fixed code (no CLI text)", () => {
    const h = parseDoctorHazards(OK_DOCTOR.replace("not applicable to Pro and Max accounts", "Acme Corp policy: block everything"));
    expect(h).toEqual([{ kind: "policy_blocks_agentweb", detail: "org_policy_present" }]);
    expect(JSON.stringify(h)).not.toContain("Acme");
  });
  it("both deviating => both reported; ANSI and bullets are ignored", () => {
    const h = parseDoctorHazards("\x1b[1m└ Managed settings (remote): applied\x1b[0m\n└ Organization policy: restrictive");
    expect(h.map((x) => x.kind).sort()).toEqual(["managed_settings_present", "policy_blocks_agentweb"]);
  });
  it("the logged-out wording is NOT clean (doctor is only meaningful after sign-in)", () => {
    expect(parseDoctorHazards(OK_DOCTOR.replace("requires an Enterprise or Team subscription", "no usable credentials for the settings fetch")).length).toBeGreaterThan(0);
  });
});

describe("normalizeClaudeEvent", () => {
  it("assistant text and tool_use blocks", () => {
    expect(normalizeClaudeEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "mcp__emma__search", input: { q: 1 } }, { type: "thinking", thinking: "x" }, { type: "text", text: "" }] } })).toEqual([
      { type: "text", delta: "hi" },
      { type: "tool-use", operationId: "tu1", name: "mcp__emma__search", input: { q: 1 } },
    ]);
  });
  it("user tool_result blocks carry ok from is_error", () => {
    expect(normalizeClaudeEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1" }, { type: "tool_result", tool_use_id: "tu2", is_error: true }] } })).toEqual([
      { type: "tool-result", operationId: "tu1", ok: true },
      { type: "tool-result", operationId: "tu2", ok: false },
    ]);
  });
  it("rate_limit_event => entitlement with unknown left unknown", () => {
    const [ev] = normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", isUsingOverage: false, overageStatus: "rejected", unifiedWindows: { five_hour: { utilization: 0.19, resetsAt: 1789728000 }, seven_day: { resetsAt: 1790000000000 } } } });
    expect(ev).toEqual({
      type: "entitlement",
      observation: { windows: [{ name: "five_hour", utilization: 0.19, resetsAtMs: 1789728000000 }, { name: "seven_day", resetsAtMs: 1790000000000 }], status: "allowed_warning", overage: { using: false, status: "rejected" } },
    });
    expect(normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toEqual([{ type: "entitlement", observation: { windows: [], status: "allowed" } }]);
    expect(normalizeClaudeEvent({ type: "rate_limit_event" })).toEqual([]);
    // the single-window fallback validates the window name like the unified branch does
    expect(normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1789728000 } })).toEqual([{ type: "entitlement", observation: { windows: [{ name: "five_hour", utilization: 0.5, resetsAtMs: 1789728000000 }], status: "allowed" } }]);
    expect(normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "bad name\nwith text" } })).toEqual([{ type: "entitlement", observation: { windows: [], status: "allowed" } }]);
  });
  it("init with apiKeySource none is silent; anything else (or missing) is an alarm", () => {
    expect(normalizeClaudeEvent({ type: "system", subtype: "init", apiKeySource: "none" })).toEqual([]);
    expect(normalizeClaudeEvent({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" })).toEqual([{ type: "alarm", hazard: { kind: "api_key_source", source: "ANTHROPIC_API_KEY" } }]); // a variable NAME is not a secret
    expect(normalizeClaudeEvent({ type: "system", subtype: "init", apiKeySource: "sk-ant-abc123 leaked text" })).toEqual([{ type: "alarm", hazard: { kind: "api_key_source", source: "missing" } }]); // anything that is not a short token is never echoed
    expect(normalizeClaudeEvent({ type: "system", subtype: "init", apiKeySource: "env" })).toEqual([{ type: "alarm", hazard: { kind: "api_key_source", source: "env" } }]);
    expect(normalizeClaudeEvent({ type: "system", subtype: "init" })).toEqual([{ type: "alarm", hazard: { kind: "api_key_source", source: "missing" } }]);
  });
  it("any hook event is an alarm; other system events and unknown types are ignored", () => {
    expect(normalizeClaudeEvent({ type: "system", subtype: "hook_started" })).toEqual([{ type: "alarm", hazard: { kind: "hook_event" } }]);
    expect(normalizeClaudeEvent({ type: "system", subtype: "hook_response" })).toEqual([{ type: "alarm", hazard: { kind: "hook_event" } }]);
    expect(normalizeClaudeEvent({ type: "system", subtype: "status" })).toEqual([]);
    expect(normalizeClaudeEvent({ type: "result", result: "x" })).toEqual([]);
    expect(normalizeClaudeEvent({ type: "assistant", message: null })).toEqual([]);
  });
});

describe("usage and failure classification", () => {
  it("usage counts: unknown stays out, never 0", () => {
    expect(usageFromResult({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } })).toEqual({ type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });
    expect(usageFromResult({ usage: { input_tokens: "10" } })).toBeUndefined();
    expect(usageFromResult({})).toBeUndefined();
  });
  it.each([
    ["You've hit your session limit · resets 3:45pm", "usage_limit"],
    ["API Error: 429 rate_limit_error", "usage_limit"],
    ["Not logged in · Please run /login", "auth_like"],
    ["OAuth session expired", "auth_like"],
    ["API Error: 401 authentication_error", "auth_like"],
    ["API Error: 529 overloaded_error", "transient"],
    ["connect ETIMEDOUT 1.2.3.4:443", "transient"],
    ["something odd happened", "unknown"],
    ["", "unknown"],
  ])("%j => %s", (text, cls) => expect(classifyFailureText(text)).toBe(cls));
});
