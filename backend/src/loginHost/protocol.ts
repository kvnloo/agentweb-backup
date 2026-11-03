/**
 * ENG-2110 PR 1a: the login host's request protocol.
 *
 * SECURITY BOUNDARY (read before changing): the caller is the AgentWeb backend, which is
 * not trusted with customers' login material. A compromised backend can spend customers'
 * plans; it must not be able to obtain a token or run code as a customer. So every request
 * schema is CLOSED (`.strict()`): unknown fields are rejected, and there is no field that
 * names a path, a uid, a command, an environment variable, a settings blob, an MCP server
 * or a hook. The host derives homes, uids and epochs from `connectionId` itself, takes the
 * bridge URL and prompt templates from its own configuration, and picks the model from an
 * allowlist per provider. Adding a field here means answering "can a compromised backend use
 * this to read a file or run something?" in the PR description.
 */
import { z } from "zod";

/**
 * The version of THIS protocol (routes, request and reply shapes). The backend and the worker both deploy automatically on a merge to main, but
 * as separate pipelines that finish at different times (the worker also waits for an idle moment), so they routinely run different commits. Bump it whenever a route or a field is added, removed or
 * changes meaning, and keep the deploy order in mind:
 *   - a change to what the backend SENDS (a new route or request field): deploy the WORKER first (an old worker refuses unknown fields);
 *   - a change to what the worker REPLIES (a new reply field the backend starts relying on): deploy the BACKEND first (its reply shapes
 *     ignore extra fields, so a newer worker is harmless to an older backend).
 * The backend asks `host.info` once after it builds its client and logs a mismatch; an unknown route answers EINVALID/route (never
 * ENOTFOUND, which means "no such connection" and has a destructive meaning for revoke and the sweeper).
 */
export const PROTOCOL_VERSION = 4;
// History: 2 = the first shipped protocol. 3 (ENG-2110) adds, all OPTIONAL and additive: login.complete.completionNonce (the host records which complete took
// the code and reports it back, so a loser of a double submit can stand down), login.cancel.onlyIfPending (a user-initiated cancel never discards a login
// that is already ready) and, on the host only, a time limit for a ready attempt that is never promoted. The backend sends the new fields only to a worker
// that reports 3 or more (loginHostProvider.workerProtocol()), so the two can deploy in either order.
// 4 (ENG-2113) adds the tool relay. turn.run is additive (the legacy shape is unchanged), but turn.toolResult is NOT: `ok` is replaced by `isError`, `images`
// and `tools` are new and the schema is strict (nothing called the old shape; Codex relays are not implemented). turn.run takes an optional bounded `tools` manifest INSTEAD of `bridgeToken` (a request
// with `bridgeToken` and no `tools` is the legacy shape and behaves exactly as under 3; both together, or neither, is refused), turn events gain `tool-call`
// (host-generated operationId), and turn.toolResult is reshaped (`isError`, `images`, `tools` = definitions newly available because of that call; its body limit is 8 MiB). The backend sends `tools` only to a
// worker that reports 4 or more, so the worker deploys first.

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id: letters, digits, _ and - only, 1-64 chars");
const PROVIDER = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const EPOCH = z.number().int().min(1).max(2_147_483_647);
const MODEL = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
/** Prompt text only; never a path. Bounded so a request cannot exhaust host memory. */
const PROMPT = z.string().min(1).max(2_000_000);
/** Opaque short-lived token for the backend's tool bridge, for this turn only. */
const BRIDGE_TOKEN = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,511}$/); // never starts with "-"
/** The pasted sign-in code (Claude: `<code>#<state>`). Never logged. */
const LOGIN_CODE = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~#-]{7,511}$/); // never starts with "-"

export const loginStartReq = z.object({ connectionId: ID, provider: PROVIDER, reconnect: z.boolean().optional() }).strict();
/** A random per-request value (not a secret) the backend sends with each complete; the host stores it on the attempt that took the code and returns it with the ready status. */
const COMPLETION_NONCE = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const loginCompleteReq = z.object({ connectionId: ID, loginRef: ID, code: LOGIN_CODE, completionNonce: COMPLETION_NONCE.optional() }).strict();
export const loginStatusReq = z.object({ connectionId: ID, loginRef: ID }).strict();
/** `onlyIfPending`: do nothing if the attempt already took its code (a stray cancel must not discard a ready login). Rollbacks leave it off. */
export const loginCancelReq = z.object({ connectionId: ID, loginRef: ID, onlyIfPending: z.boolean().optional() }).strict();
/** Phase 3 of sign-in: the backend created the record (epoch 1 or the reconnect epoch) and asks the host to promote the attempt. */
export const loginPromoteReq = z.object({ connectionId: ID, loginRef: ID, epoch: EPOCH }).strict();

// ───────────────────────────── tool relay (protocol 4) ─────────────────────────────

/** The MCP server name the adapter configures for the relay (and the legacy bridge): the CLI exposes every tool as `mcp__<server>__<tool>`. */
export const RELAY_MCP_SERVER_NAME = "emma";
/** The model API refuses a tool name longer than this; the NAME the model sees is the qualified one. */
export const MODEL_TOOL_NAME_MAX_CHARS = 64;
export const qualifiedToolPrefix = (server: string): string => `mcp__${server}__`;
/** The longest bare tool name that still fits the model's limit once the CLI qualifies it for `server`. */
export const maxToolNameChars = (server: string): number => MODEL_TOOL_NAME_MAX_CHARS - qualifiedToolPrefix(server).length;
// A new AgentWeb tool must fit these; see docs/plan-route-tool-limits.md, which exists on the backend branch (manan/eng-2113-relay-backend), not on this one. Changing a value: update that doc.
/**
 * The longest tool name the host accepts (53 for "emma": "mcp__emma__" is 11 characters). Derived from the prefix, never a bare number: a longer name would
 * become a qualified name the model API refuses, which fails the WHOLE turn. The real registry's longest name is 38.
 */
export const TOOL_NAME_MAX_CHARS = maxToolNameChars(RELAY_MCP_SERVER_NAME);
/**
 * The function-name shape every Emma tool already has to satisfy (OpenAI tool names: [A-Za-z0-9_-]), so the plan route can offer EXACTLY the tools AgentWeb
 * offers, user-connected MCP tools included. Never a leading "-"; no dot, slash or space (it is a name, not a path, and never reaches argv).
 */
export const TOOL_NAME = z.string().regex(new RegExp(`^[A-Za-z0-9_][A-Za-z0-9_-]{0,${TOOL_NAME_MAX_CHARS - 1}}$`), `tool name: A-Z a-z 0-9 _ - only, 1-${TOOL_NAME_MAX_CHARS} chars, no leading -`);
/** Names the relay shim keeps for itself (the whole `aw_relay_` prefix): a manifest may not use them. */
export const RELAY_RESERVED_PREFIX = "aw_relay_";
// A new AgentWeb tool must fit these; see docs/plan-route-tool-limits.md, which exists on the backend branch (manan/eng-2113-relay-backend), not on this one. Changing a value: update that doc.
/**
 * DoS guards, NOT a tool budget, and CUMULATIVE per turn (the open set plus every tool added by an answer): the plan route must be able to offer the same tools
 * as AgentWeb, so these sit at about 2x the whole registry (measured 2026-10-29: 271 tools, ~503 KB; largest description 24,232 bytes (call_meta_marketing_api),
 * largest schema 15,084 bytes (call_google_ads_api)); a chat normally opens with ~74 foundation tools, ~93 KB. A registry that outgrows them must raise them here
 * (worker first), never be trimmed silently by the backend.
 */
export const TOOL_LIMITS = {
  maxTools: 600,
  /** Serialized size of the whole manifest as the host writes it into the shim's config. */
  maxTotalBytes: 1024 * 1024,
  maxDescriptionBytes: 48 * 1024,
  maxSchemaBytes: 32 * 1024,
} as const;
/** Serialized size; a value that cannot be serialized (nested past the stack, from a hostile body) is infinitely large, so it is refused instead of throwing. */
const byteLen = (v: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(v), "utf8");
  } catch {
    return Infinity;
  }
};

/** A tool definition as the CLI sees it. */
export const toolDef = z
  .object({
    name: TOOL_NAME,
    description: z.string().max(TOOL_LIMITS.maxDescriptionBytes),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ToolDef = z.infer<typeof toolDef>;

/** What is wrong with ONE definition on its own (shared by the turn's open set and by tools that arrive with a result), or undefined. */
export function toolEntryProblem(t: ToolDef): string | undefined {
  if (t.name.toLowerCase().startsWith(RELAY_RESERVED_PREFIX)) return "tool_name_reserved";
  if (t.inputSchema.type !== "object") return "tool_schema_not_object";
  if (byteLen(t.inputSchema) > TOOL_LIMITS.maxSchemaBytes) return "tool_schema_too_large";
  if (Buffer.byteLength(t.description, "utf8") > TOOL_LIMITS.maxDescriptionBytes) return "tool_description_too_large";
  return undefined;
}

/**
 * The turn's OPEN set at its start (Emma starts a chat with only the foundation tools and adds a skill's tools when the model installs the skill; the plan
 * route does the same, so this is NOT the whole catalogue). More tools arrive later with a turn.toolResult (`tools`), bounded by the same TOOL_LIMITS
 * cumulatively (see admitNewTools).
 */
export const toolManifest = z
  .array(toolDef)
  .min(1)
  .max(TOOL_LIMITS.maxTools)
  .superRefine((tools, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const seen = new Set<string>();
    for (const t of tools) {
      // Case-insensitive: two names that differ only in case are too easy to confuse (for the model and in logs) to be two tools.
      const folded = t.name.toLowerCase();
      if (seen.has(folded)) return fail("tool_duplicate");
      seen.add(folded);
      const problem = toolEntryProblem(t);
      if (problem) return fail(problem);
    }
    if (byteLen(tools) > TOOL_LIMITS.maxTotalBytes) return fail("tools_too_large");
  });

/** Tools newly available because of one call (turn.toolResult `tools`): each entry valid on its own; the cumulative checks need the turn (admitNewTools). */
export const newToolsList = z
  .array(toolDef)
  .min(1)
  .max(TOOL_LIMITS.maxTools)
  .superRefine((tools, ctx) => {
    const byFolded = new Map<string, string>();
    for (const t of tools) {
      const folded = t.name.toLowerCase();
      const prior = byFolded.get(folded);
      if (prior !== undefined && prior !== t.name) return ctx.addIssue({ code: "custom", message: "tool_duplicate" }); // an exact repeat is a harmless no-op, a case variant is not
      byFolded.set(folded, t.name);
      const problem = toolEntryProblem(t);
      if (problem) return ctx.addIssue({ code: "custom", message: problem });
    }
  });

/** The tools a turn can currently call, as the host tracks them (bounded by TOOL_LIMITS, cumulatively). */
export interface VisibleTools {
  names: Set<string>;
  folded: Set<string>;
  bytes: number;
}
export function visibleFromManifest(tools: ToolDef[]): VisibleTools {
  return { names: new Set(tools.map((t) => t.name)), folded: new Set(tools.map((t) => t.name.toLowerCase())), bytes: byteLen(tools) };
}
/**
 * Decides whether `incoming` may join the visible set: an exact name already visible is a no-op (idempotent for a retrying backend, the first definition
 * stays); a name that differs from a visible one only in case is refused; the cumulative count and bytes may not pass TOOL_LIMITS. Pure: the caller commits
 * `fresh` (and `bytes`) only after the answer was really delivered.
 */
export function admitNewTools(visible: VisibleTools, incoming: ToolDef[]): { ok: true; fresh: ToolDef[]; bytes: number } | { ok: false; code: "tools_invalid" | "tools_limit" } {
  const fresh: ToolDef[] = [];
  const seen = new Set<string>();
  let bytes = visible.bytes;
  for (const t of incoming) {
    if (visible.names.has(t.name) || seen.has(t.name)) continue;
    if (visible.folded.has(t.name.toLowerCase())) return { ok: false, code: "tools_invalid" };
    seen.add(t.name);
    fresh.push(t);
    bytes += byteLen(t) + 1;
  }
  if (visible.names.size + fresh.length > TOOL_LIMITS.maxTools || bytes > TOOL_LIMITS.maxTotalBytes) return { ok: false, code: "tools_limit" };
  return { ok: true, fresh, bytes };
}

export const IMAGE_LIMITS = { maxImages: 4, maxBase64Each: 2_500_000, maxBase64Total: 6_000_000 } as const;

/**
 * The tool manifest as the lines the wrapper reads from stdin (deploy/claude-turn.sh): the decimal BYTE length, then the JSON (the runner adds the newline after
 * each line, so the block ends in the newline the wrapper expects). MANIFEST_WIRE_MAX_BYTES is the wrapper's own bound (TOOL_LIMITS.maxTotalBytes + 4096).
 */
export const MANIFEST_WIRE_MAX_BYTES = TOOL_LIMITS.maxTotalBytes + 4096;
export function manifestLines(tools: unknown): string[] {
  const json = JSON.stringify(tools);
  return [String(Buffer.byteLength(json, "utf8")), json];
}

/**
 * The largest tool RESULT the plan route hands to the model, in bytes: the same cap in-process Emma applies (MAX_TOOL_CONTENT_SIZE = 300,000 characters in
 * agentModeService, the size a result may have when it is persisted and offered back to the model; larger results are cut with a note there). One shared constant:
 * the backend applies it to the result it posts with turn.toolResult, and the CLI limit below is derived from it. The frame cap
 * (RELAY_FRAME_LIMITS.hostToShimBytes, 8 MiB) stays far above it: it bounds what the socket carries, not what the model is shown.
 */
export const RELAY_RESULT_MAX_BYTES = 300_000;

/**
 * Environment variables of the CLI that RELAY turns set so the CLI itself never silently changes what the plan route offers (names confirmed in the strings of CLI
 * 2.1.314; legacy turns set none of them). Every value is derived from a limit of this file, never a second copy of a number:
 *  - CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: the CLI shortens an MCP tool description (default 4096 characters, with an ellipsis); the host already refuses one over
 *    TOOL_LIMITS.maxDescriptionBytes, so that is the limit here (a character is at most that many bytes);
 *  - MAX_MCP_OUTPUT_TOKENS: the CLI truncates an MCP result above this many tokens (default 25,000, about 100 KB). The largest result the plan route offers is
 *    RELAY_RESULT_MAX_BYTES, counted conservatively at two bytes a token, plus 1,600 tokens (the CLI's own figure) for each image. It is deliberately NOT the 8 MiB
 *    frame cap: raising the CLI's limit that far would remove its protection of the model's context window (a result of that size fails the turn);
 *  - MCP_TOOL_TIMEOUT: the CLI's own limit on one stdio tool call (milliseconds, at least 1000): the turn's remaining deadline, so the host's clock is the one that ends a call.
 * MAX_MCP_OUTPUT_TOKENS alone is NOT enough: the CLI has a SEPARATE per-tool persistence threshold that saves a result above it to a file and shows the model only a ~2 KB
 * preview (measured live: a 150 KB result, with MAX_MCP_OUTPUT_TOKENS = 156,400). The relay shim raises that one per tool with _meta {"anthropic/maxResultSizeChars": N} in
 * tools/list, N = RELAY_RESULT_MAX_BYTES (deploy/aw-relay-shim.js, MAX_RESULT_CHARS; a test keeps the two equal).
 * (MCP_TIMEOUT is the server start-up timeout in the CLI, not a call limit; CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, default 30 minutes for stdio, is reset by the shim's
 * progress notifications.)
 */
export function relayCliEnv(callTimeoutMs: number): Record<string, string> {
  const ms = Math.min(2_147_483_647, Math.max(1000, Math.floor(Number.isFinite(callTimeoutMs) ? callTimeoutMs : 1000)));
  return {
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(TOOL_LIMITS.maxDescriptionBytes),
    MAX_MCP_OUTPUT_TOKENS: String(Math.ceil(RELAY_RESULT_MAX_BYTES / 2) + IMAGE_LIMITS.maxImages * 1600),
    MCP_TOOL_TIMEOUT: String(ms),
  };
}
export const toolImage = z
  .object({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: z
      .string()
      .min(4)
      .max(IMAGE_LIMITS.maxBase64Each)
      .refine((d) => d.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(d), "image_not_base64"),
  })
  .strict();
export type ToolImage = z.infer<typeof toolImage>;

/** Largest body any route accepts, except turn.toolResult (images). */
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
/** turn.toolResult carries up to 6M base64 image characters plus text. */
export const TOOL_RESULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * turn.run: a manifest at its 1 MiB limit plus a prompt of up to ~6.9 MiB as JSON, e.g. 2,000,000 characters of ordinary text (up to 3 bytes each as UTF-8, ~6 MB).
 * NOT every 2,000,000-character prompt: control characters JSON-escape to 6 bytes each (\u0000), so a prompt made mostly of them (~12 MB) is refused with 413.
 */
export const TURN_RUN_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The body limit of each route (finite: the body is buffered whole before parsing). */
export function maxBodyBytes(route: string): number {
  if (route === "turn.toolResult") return TOOL_RESULT_MAX_BODY_BYTES;
  if (route === "turn.run") return TURN_RUN_MAX_BODY_BYTES;
  return DEFAULT_MAX_BODY_BYTES;
}
/** Frames between the shim and the host (newline-delimited JSON). */
export const RELAY_FRAME_LIMITS = { shimToHostBytes: 1024 * 1024, hostToShimBytes: 8 * 1024 * 1024 } as const;

export const turnRunReq = z
  .object({
    connectionId: ID,
    epoch: EPOCH,
    idempotencyKey: ID,
    turnId: ID,
    prompt: PROMPT,
    model: MODEL,
    /** Legacy shape (protocol <= 3): the HTTP tool bridge. Exactly one of `bridgeToken` / `tools` must be present. */
    bridgeToken: BRIDGE_TOKEN.optional(),
    /** Relay shape (protocol 4): the tools the CLI is offered through the host's stdio shim. */
    tools: toolManifest.optional(),
    deadlineMs: z.number().int().min(1_000).max(3_600_000).optional(),
    priority: z.enum(["interactive", "scheduled"]).optional(),
  })
  .strict();
/** The route's schema: the object above plus the rule that exactly one tool transport is named (the plain object stays exported for its `.shape`). */
export const turnRunChecked = turnRunReq.superRefine((r, ctx) => {
  if (r.bridgeToken !== undefined && r.tools !== undefined) ctx.addIssue({ code: "custom", path: ["tools"], message: "bridge_and_tools_mixed" });
  else if (r.bridgeToken === undefined && r.tools === undefined) ctx.addIssue({ code: "custom", path: ["tools"], message: "bridge_or_tools_required" });
});
export const turnRenewReq = z.object({ connectionId: ID, turnId: ID, epoch: EPOCH }).strict();
export const turnInterruptReq = z.object({ connectionId: ID, turnId: ID, epoch: EPOCH }).strict();
/**
 * Answer to a pending operation inside a turn (a `tool-call` event, or a host-relayed Codex request); `operationId` pairs it with the request.
 * `tools` are definitions that become available because of THIS call (a skill install): the shim adds them, announces tools/list_changed and waits for the CLI
 * to re-list before it returns the result. Names already visible are a no-op; anything invalid or over the cumulative caps refuses the whole answer and leaves the
 * operation pending.
 */
export const turnToolResultReq = z
  .object({
    connectionId: ID,
    turnId: ID,
    epoch: EPOCH,
    operationId: ID,
    content: z.string().max(4_000_000),
    isError: z.boolean().optional(),
    images: z
      .array(toolImage)
      .max(IMAGE_LIMITS.maxImages)
      .refine((imgs) => imgs.reduce((n, i) => n + i.data.length, 0) <= IMAGE_LIMITS.maxBase64Total, "images_too_large")
      .optional(),
    tools: newToolsList.optional(),
  })
  .strict();

export const hostInfoReq = z.object({}).strict();
/**
 * Deploy support (UNIX SOCKET ONLY: the mutual-TLS listener refuses it, so a compromised backend cannot starve the host).
 *   off     admit everything again
 *   strict  only if nothing is running, signing in or being promoted/revoked at this instant: refuse ALL new turns and sign-ins from now on
 * The state expires by itself after `ttlSec`: a deploy that dies half-way cannot leave the host refusing work. A restart clears it.
 */
export const hostDrainReq = z.object({ mode: z.enum(["off", "strict"]), ttlSec: z.number().int().min(10).max(3600).optional() }).strict();

export const connectionActionReq = z.object({ connectionId: ID, epoch: EPOCH }).strict();
export const connectionStatusReq = z.object({ connectionId: ID }).strict();

export const ROUTES = {
  "login.start": loginStartReq,
  "login.complete": loginCompleteReq,
  "login.status": loginStatusReq,
  "login.cancel": loginCancelReq,
  "login.promote": loginPromoteReq,
  "turn.run": turnRunChecked,
  "turn.renew": turnRenewReq,
  "turn.interrupt": turnInterruptReq,
  "turn.toolResult": turnToolResultReq,
  "connection.disable": connectionActionReq,
  "connection.enable": connectionActionReq,
  "connection.revoke": connectionActionReq,
  "connection.status": connectionStatusReq,
  "host.info": hostInfoReq,
  "host.drain": hostDrainReq,
} as const;
/** Routes only the local unix socket serves. */
export const LOCAL_ONLY_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>(["host.drain"]);
export type RouteName = keyof typeof ROUTES;
export type RouteInput<R extends RouteName> = z.infer<(typeof ROUTES)[R]>;

/** Error codes the host returns; the backend maps them. No message ever contains a path, a token or a code. */
export type HostErrorCode =
  | "EINVALID" //   schema / validation failure
  | "ENOTFOUND" //  unknown connection / login / turn (also used for "not yours": same answer)
  | "ESTALE" //     epoch older than the host's
  | "ESTATE" //     operation not allowed in the connection's current state
  | "EBUSY" //      caps reached / admission refused (retryable)
  | "EEXISTS" //    idempotency key reused with different input
  | "EUNSUPPORTED" // provider not served by this host
  | "EHAZARD" //    adapter reported a hazard (e.g. delivered org settings)
  | "EINTERNAL";

export class HostError extends Error {
  constructor(readonly code: HostErrorCode, readonly detail?: string) {
    super(code);
    this.name = "HostError";
  }
  /** Safe to send to the caller: a code and an optional short, non-sensitive detail chosen by the host. */
  toBody(): { error: HostErrorCode; detail?: string } {
    return this.detail ? { error: this.code, detail: this.detail } : { error: this.code };
  }
}

export const HTTP_STATUS: Record<HostErrorCode, number> = {
  EINVALID: 400,
  ENOTFOUND: 404,
  ESTALE: 409,
  ESTATE: 409,
  EBUSY: 429,
  EEXISTS: 409,
  EUNSUPPORTED: 400,
  EHAZARD: 409,
  EINTERNAL: 500,
};
