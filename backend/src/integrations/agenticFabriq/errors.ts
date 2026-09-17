/**
 * Error taxonomy for the Agentic Fabriq spike adapter.
 *
 * Per the vendor's own RULES: "On an auth error, surface it — never retry
 * under a different identity." These classes exist so callers can distinguish
 * "the request itself is malformed" from "this user genuinely isn't connected
 * yet" from "our app credentials are wrong" — and so central error handling
 * (toolDispatch's existing error-classification path) can react correctly
 * instead of collapsing everything into a generic 500.
 */

/** Base class for every Agentic Fabriq adapter error. Never carries a raw token in its message. */
export class AgenticFabriqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgenticFabriqError';
  }
}

/** A REST call returned a non-2xx response without exposing its body. */
export class AgenticFabriqApiError extends AgenticFabriqError {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`Agentic Fabriq API error ${status} on ${endpoint}`);
    this.name = 'AgenticFabriqApiError';
  }
}

/** A provider request exceeded its bounded deadline. */
export class AgenticFabriqTimeoutError extends AgenticFabriqError {
  constructor(readonly operation: string) {
    super(`Agentic Fabriq request timed out during ${operation}`);
    this.name = 'AgenticFabriqTimeoutError';
  }
}

/** A provider response exceeded the maximum safe buffering size. */
export class AgenticFabriqResponseTooLargeError extends AgenticFabriqError {
  constructor(readonly operation: string) {
    super(`Agentic Fabriq response exceeded the size limit during ${operation}`);
    this.name = 'AgenticFabriqResponseTooLargeError';
  }
}

/** The requested mailbox cannot be bound safely to one Fabriq connection. */
export class AgenticFabriqUnsupportedMailboxError extends AgenticFabriqError {
  constructor() {
    super('This mailbox is not supported by the Agentic Fabriq spike; use the direct email path.');
    this.name = 'AgenticFabriqUnsupportedMailboxError';
  }
}

/**
 * A 900s user-scoped token expired (or was never mintable) and, per the vendor's
 * own documented divergence, CANNOT be refreshed in place — the caller must mint
 * a fresh one. Mirrors af_sdk's own AuthenticationError so the adapter's contract
 * matches the vendor's documented behavior even though we don't import their SDK.
 */
export class AgenticFabriqAuthenticationError extends AgenticFabriqError {
  constructor(message: string) {
    super(message);
    this.name = 'AgenticFabriqAuthenticationError';
  }
}

/** The caller tried to resolve an external-user id in a way the identity contract forbids. */
export class AgenticFabriqIdentityError extends AgenticFabriqError {
  constructor(message: string) {
    super(message);
    this.name = 'AgenticFabriqIdentityError';
  }
}

/** A webhook delivery failed signature/timestamp/dedupe verification. */
export class AgenticFabriqWebhookVerificationError extends AgenticFabriqError {
  constructor(message: string) {
    super(message);
    this.name = 'AgenticFabriqWebhookVerificationError';
  }
}

/** The spike flag/allowlist/credentials are not configured for the attempted operation. */
export class AgenticFabriqNotConfiguredError extends AgenticFabriqError {
  constructor(message: string) {
    super(message);
    this.name = 'AgenticFabriqNotConfiguredError';
  }
}
