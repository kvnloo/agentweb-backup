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
export const loginCompleteReq = z.object({ connectionId: ID, loginRef: ID, code: LOGIN_CODE }).strict();
export const loginStatusReq = z.object({ connectionId: ID, loginRef: ID }).strict();
export const loginCancelReq = z.object({ connectionId: ID, loginRef: ID }).strict();
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
} as const;
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
