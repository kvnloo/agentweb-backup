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
// 4 (ENG-2113) adds the tool relay, all additive on the worker side: turn.run takes an optional bounded `tools` manifest INSTEAD of `bridgeToken` (a request
// with `bridgeToken` and no `tools` is the legacy shape and behaves exactly as under 3; both together, or neither, is refused), turn events gain `tool-call`
// (host-generated operationId), and turn.toolResult is reshaped (`isError`, `images`, `unlock`; its body limit is 8 MiB). The backend sends `tools` only to a
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

/** A tool the customer's CLI is offered through the relay shim. The name is also a path-free, shell-free token. */
/**
 * The function-name shape every Emma tool already has to satisfy (OpenAI tool names: [A-Za-z0-9_-], at most 64), so the plan route can offer EXACTLY the
 * tools AgentWeb offers, user-connected MCP tools included. Never a leading "-"; no dot, slash or space (it is a name, not a path, and never reaches argv).
 */
export const TOOL_NAME = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/, "tool name: A-Z a-z 0-9 _ - only, 1-64 chars, no leading -");
/** Names the relay shim keeps for itself (the whole `aw_relay_` prefix): a manifest may not use them. */
export const RELAY_RESERVED_PREFIX = "aw_relay_";
/**
 * DoS guards, NOT a tool budget: the plan route must offer the same tools as AgentWeb, so these sit at about 2x the real registry (measured 2026-10-28 on
 * the Emma registry: 263 registered tools + the agent-mode built-ins and per-user MCP tools, ~271 in a full session; largest description 24,232 bytes
 * (call_meta_marketing_api), largest schema 15,084 bytes (call_google_ads_api), whole manifest ~502 KB). A registry that outgrows them must raise them here
 * (worker first), never be trimmed silently by the backend.
 */
export const TOOL_LIMITS = {
  maxTools: 600,
  /** Serialized size of the whole manifest as the host writes it into the shim's config. */
  maxTotalBytes: 1024 * 1024,
  maxDescriptionBytes: 48 * 1024,
  maxSchemaBytes: 32 * 1024,
} as const;
const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** `locked` tools are in the manifest from the start but not listed to the model until a tool result unlocks them (skills installed mid-turn). */
export const toolDef = z
  .object({
    name: TOOL_NAME,
    description: z.string().max(TOOL_LIMITS.maxDescriptionBytes),
    inputSchema: z.record(z.string(), z.unknown()),
    locked: z.boolean().optional(),
  })
  .strict();
export type ToolDef = z.infer<typeof toolDef>;

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
      if (folded.startsWith(RELAY_RESERVED_PREFIX)) return fail("tool_name_reserved");
      if (t.inputSchema.type !== "object") return fail("tool_schema_not_object");
      if (byteLen(t.inputSchema) > TOOL_LIMITS.maxSchemaBytes) return fail("tool_schema_too_large");
      if (Buffer.byteLength(t.description, "utf8") > TOOL_LIMITS.maxDescriptionBytes) return fail("tool_description_too_large");
    }
    if (tools.every((t) => t.locked)) return fail("tool_all_locked");
    if (byteLen(tools) > TOOL_LIMITS.maxTotalBytes) return fail("tools_too_large");
  });

export const IMAGE_LIMITS = { maxImages: 4, maxBase64Each: 2_500_000, maxBase64Total: 6_000_000 } as const;
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
 * `unlock` names tools of the turn's manifest that were `locked` and become visible now (the shim announces them and waits for the CLI to re-list).
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
    unlock: z.array(TOOL_NAME).min(1).max(TOOL_LIMITS.maxTools).optional(),
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
