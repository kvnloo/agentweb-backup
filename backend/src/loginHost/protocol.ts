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
export const PROTOCOL_VERSION = 3;
// History: 2 = the first shipped protocol. 3 (ENG-2110) adds, all OPTIONAL and additive: login.complete.completionNonce (the host records which complete took
// the code and reports it back, so a loser of a double submit can stand down), login.cancel.onlyIfPending (a user-initiated cancel never discards a login
// that is already ready) and, on the host only, a time limit for a ready attempt that is never promoted. The backend sends the new fields only to a worker
// that reports 3 or more (loginHostProvider.workerProtocol()), so the two can deploy in either order.

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

export const turnRunReq = z
  .object({
    connectionId: ID,
    epoch: EPOCH,
    idempotencyKey: ID,
    turnId: ID,
    prompt: PROMPT,
    model: MODEL,
    bridgeToken: BRIDGE_TOKEN,
    deadlineMs: z.number().int().min(1_000).max(3_600_000).optional(),
    priority: z.enum(["interactive", "scheduled"]).optional(),
  })
  .strict();
export const turnRenewReq = z.object({ connectionId: ID, turnId: ID, epoch: EPOCH }).strict();
export const turnInterruptReq = z.object({ connectionId: ID, turnId: ID, epoch: EPOCH }).strict();
/** Answer to a server-initiated request inside a turn (host-relayed tool call); `operationId` pairs it with the request. */
export const turnToolResultReq = z
  .object({ connectionId: ID, turnId: ID, epoch: EPOCH, operationId: ID, ok: z.boolean(), content: z.string().max(4_000_000) })
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
  "turn.run": turnRunReq,
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
