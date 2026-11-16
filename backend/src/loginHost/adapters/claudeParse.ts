/**
 * ENG-2110 PR 1b-i: pure parsing for the Claude adapter. Nothing here starts a process or opens a file.
 * Raw CLI output is parsed for specific fields and never logged or returned whole: `claude doctor` and
 * `auth status` can print account details, so hazards carry fixed codes, never CLI text.
 */
import type { AuthStatus, ErrorKind, Hazard, ProviderEvent } from "../adapter";
import { stripAnsi } from "../../services/funding/claudeLoginParse";
import { boundedValue } from "../relay/bounds";

/** Ids and names forwarded from the CLI's stream: an event with a longer one is dropped (informational events only). */
const MAX_FIELD_CHARS = 256;

/** `claude auth status` JSON (verified on 2.1.294: signed in => loggedIn + subscriptionType; logged out => loggedIn:false, exit 1). */
export function parseAuthStatus(stdout: string): AuthStatus | undefined {
  const text = stripAnsi(stdout);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.loggedIn !== "boolean") return undefined;
  const plan = typeof o.subscriptionType === "string" && /^[a-z0-9_-]{1,32}$/i.test(o.subscriptionType) ? o.subscriptionType.toLowerCase() : undefined;
  return {
    loggedIn: o.loggedIn,
    ...(plan ? { planLabel: plan } : {}),
    ...(o.orgId || o.orgName ? { orgPresent: true } : { orgPresent: false }),
  };
}

const MANAGED_LINE = /managed settings \(remote\)\s*:\s*(.*)/i;
const ORG_LINE = /organization policy\s*:\s*(.*)/i;

/**
 * `claude doctor` output => hazards. Verified wording for Pro/Max (s8, 2.1.294): "Managed settings (remote):
 * not fetched — requires an Enterprise or Team subscription" and "Organization policy: not applicable to Pro
 * and Max accounts". Anything else fails closed: the lines are missing => `other`; the managed-settings line
 * says anything but the Pro/Max wording => `managed_settings_present`; the policy line likewise =>
 * `policy_blocks_agentweb`. Team/Enterprise wording is unverified, which is why every deviation refuses.
 */
export function parseDoctorHazards(output: string): Hazard[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const managed = lines.map((l) => l.match(MANAGED_LINE)).find((m): m is RegExpMatchArray => !!m);
  const org = lines.map((l) => l.match(ORG_LINE)).find((m): m is RegExpMatchArray => !!m);
  if (!managed || !org) return [{ kind: "other", detail: "doctor_output_unrecognised" }];
  const hazards: Hazard[] = [];
  if (!/requires an enterprise or team subscription/i.test(managed[1])) hazards.push({ kind: "managed_settings_present" });
  if (!/not applicable to pro and max/i.test(org[1])) hazards.push({ kind: "policy_blocks_agentweb", detail: "org_policy_present" });
  return hazards;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/** The CLI reports `resetsAt` in seconds; a value that is already milliseconds is kept. */
function resetMs(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  return n > 1e12 ? n : n * 1000;
}

/** The most unified windows kept from one rate-limit event, and the most keys looked at to find them. */
export const MAX_RATE_WINDOWS = 16;
const MAX_RATE_WINDOWS_SEEN = 64;
/** Status words from the CLI ("allowed", "allowed_warning", "rejected"...) are short tokens: anything else is dropped, not forwarded. */
function statusWord(v: unknown): string | undefined {
  return typeof v === "string" && /^[a-z0-9_-]{1,40}$/i.test(v) ? v : undefined;
}
/** Content blocks of one message looked at: the CLI sends a handful, a hostile one may send a quarter million in one line. */
export const MAX_BLOCKS_NORMALIZED = 32;

/** One stream-json event => zero or more normalized events. Unknown fields stay unknown (never 0). The final `result` event is handled by the caller. */
export function normalizeClaudeEvent(raw: Record<string, unknown>): ProviderEvent[] {
  switch (raw.type) {
    case "assistant": {
      const content = asRecord(raw.message)?.content;
      if (!Array.isArray(content)) return [];
      const out: ProviderEvent[] = [];
      for (let k = 0; k < content.length && k < MAX_BLOCKS_NORMALIZED; k++) {
        const b = asRecord(content[k]);
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) out.push({ type: "text", delta: b.text });
        else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string" && b.id.length <= MAX_FIELD_CHARS && b.name.length <= MAX_FIELD_CHARS) out.push({ type: "tool-use", operationId: b.id, name: b.name, input: boundedValue(b.input) }); // informational only: a hostile CLI's deep or huge input becomes a fixed marker before it is forwarded to the backend
      }
      return out;
    }
    case "user": {
      const content = asRecord(raw.message)?.content;
      if (!Array.isArray(content)) return [];
      const out: ProviderEvent[] = [];
      for (let k = 0; k < content.length && k < MAX_BLOCKS_NORMALIZED; k++) {
        const b = asRecord(content[k]);
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string" && b.tool_use_id.length <= MAX_FIELD_CHARS) out.push({ type: "tool-result", operationId: b.tool_use_id, ok: b.is_error !== true });
      }
      return out;
    }
    case "rate_limit_event": {
      const info = asRecord(raw.rate_limit_info);
      if (!info) return [];
      const windows: Array<{ name: string; utilization?: number; resetsAtMs?: number }> = [];
      const unified = asRecord(info.unifiedWindows);
      if (unified) {
        // The CLI reports a handful of windows; a hostile one may print millions. Look at a bounded number of keys (for-in, not Object.entries: that builds them all).
        let seen = 0;
        for (const name in unified) {
          if (++seen > MAX_RATE_WINDOWS_SEEN || windows.length >= MAX_RATE_WINDOWS) break;
          if (!Object.prototype.hasOwnProperty.call(unified, name)) continue;
          const rec = asRecord(unified[name]);
          if (!rec || !/^[a-z0-9_]{1,40}$/i.test(name)) continue;
          windows.push({ name, ...(num(rec.utilization) !== undefined ? { utilization: num(rec.utilization) } : {}), ...(resetMs(rec.resetsAt) !== undefined ? { resetsAtMs: resetMs(rec.resetsAt) } : {}) });
        }
      } else if (typeof info.rateLimitType === "string" && /^[a-z0-9_]{1,40}$/i.test(info.rateLimitType)) {
        windows.push({ name: info.rateLimitType, ...(num(info.utilization) !== undefined ? { utilization: num(info.utilization) } : {}), ...(resetMs(info.resetsAt) !== undefined ? { resetsAtMs: resetMs(info.resetsAt) } : {}) });
      }
      const overageStatus = statusWord(info.overageStatus);
      return [
        {
          type: "entitlement",
          observation: {
            windows,
            ...(statusWord(info.status) !== undefined ? { status: statusWord(info.status) } : {}),
            ...(typeof info.isUsingOverage === "boolean" ? { overage: { using: info.isUsingOverage, ...(overageStatus ? { status: overageStatus } : {}) } } : {}),
          },
        },
      ];
    }
    case "system": {
      if (raw.subtype === "init") {
        // Fail closed: the pinned CLI reports `apiKeySource: "none"` for a subscription login; anything else (or nothing) means billing may have left the plan.
        const src = raw.apiKeySource;
        return src === "none" ? [] : [{ type: "alarm", hazard: { kind: "api_key_source", source: typeof src === "string" && /^[a-z_]{1,32}$/i.test(src) ? src : "missing" } }];
      }
      if (typeof raw.subtype === "string" && raw.subtype.startsWith("hook")) return [{ type: "alarm", hazard: { kind: "hook_event" } }];
      return [];
    }
    default:
      return [];
  }
}

/** Token counts from the final `result` event; a count the CLI did not report is left out, never 0. */
export function usageFromResult(raw: Record<string, unknown>): Extract<ProviderEvent, { type: "usage" }> | undefined {
  const u = asRecord(raw.usage);
  if (!u) return undefined;
  const ev: Extract<ProviderEvent, { type: "usage" }> = { type: "usage" };
  if (num(u.input_tokens) !== undefined) ev.inputTokens = num(u.input_tokens);
  if (num(u.output_tokens) !== undefined) ev.outputTokens = num(u.output_tokens);
  if (num(u.cache_read_input_tokens) !== undefined) ev.cacheReadTokens = num(u.cache_read_input_tokens);
  if (num(u.cache_creation_input_tokens) !== undefined) ev.cacheWriteTokens = num(u.cache_creation_input_tokens);
  return ev.inputTokens === undefined && ev.outputTokens === undefined && ev.cacheReadTokens === undefined && ev.cacheWriteTokens === undefined ? undefined : ev;
}

export type FailureClass = "auth_like" | "usage_limit" | "transient" | "unknown";

/**
 * Classifies the text of a failed turn. `auth_like` is only a SUSPICION: the adapter confirms with
 * `claude auth status` before reporting `auth_dead`, because a refresh that failed on the network prints
 * similar words.
 */
/** The failure text comes from the customer's CLI (any length up to the line cap): the patterns below have unbounded gaps, so only a bounded head is ever searched (no quadratic scan). */
export const MAX_CLASSIFY_CHARS = 8192;
export function classifyFailureText(text: string): FailureClass {
  const t = text.slice(0, MAX_CLASSIFY_CHARS).toLowerCase();
  if (/(session|weekly|opus|sonnet|usage) limit|rate[_ ]limit|\b429\b|quota|credits? (are )?(required|exhausted)/.test(t)) return "usage_limit";
  if (/not logged in|please run \/login|oauth[^.]*\b(expired|revoked|invalid)|authentication_error|invalid (api key|credentials)|session expired|\b401\b/.test(t)) return "auth_like";
  if (/overloaded|\b5\d\d\b|econn|etimedout|enotfound|socket hang up|network|timed? ?out|stream[^.]*(closed|disconnect)|temporar/.test(t)) return "transient";
  return "unknown";
}

export function failureClassToKind(c: FailureClass): ErrorKind {
  return c === "usage_limit" ? "usage_limit" : c === "transient" ? "transient" : "unknown"; // auth_like is resolved by the adapter, never mapped blindly
}
