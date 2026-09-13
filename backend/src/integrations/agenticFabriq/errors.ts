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

/** A REST call to Fabriq returned a non-2xx. Carries the status + a redacted body for diagnosis. */
export class AgenticFabriqApiError extends AgenticFabriqError {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly body: unknown,
  ) {
    super(`Agentic Fabriq API error ${status} on ${endpoint}: ${AgenticFabriqApiError.summarize(body)}`);
    this.name = 'AgenticFabriqApiError';
  }

  private static summarize(body: unknown): string {
    if (body === null || body === undefined) return '(no body)';
    if (typeof body === 'string') return body.slice(0, 500);
    try {
      return JSON.stringify(body).slice(0, 500);
    } catch {
      return '(unserializable body)';
    }
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
