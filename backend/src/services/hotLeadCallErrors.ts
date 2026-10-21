import { HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE } from './voice/hotLeadCallEntitlement';

/**
 * Typed failures of the hot-lead-call settings and verification flows. The REST route maps each class to an
 * HTTP status; the Emma tools surface the message. Messages are written for the person reading them.
 */

export class ValidationError extends Error {
  constructor(message: string, readonly fieldErrors?: Record<string, string>) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotEntitledError extends Error {
  constructor(message = HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE) {
    super(message);
    this.name = 'NotEntitledError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The caller's copy is out of date, or a concurrent writer won the conditional write. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class RevisionRequiredError extends Error {
  constructor() {
    super('A settings revision is required: reload the settings and try again.');
    this.name = 'RevisionRequiredError';
  }
}

export class RateLimitedError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** A wrong, expired or unusable verification code; `attemptsLeft` is 0 when a new verification must be started. */
export class VerificationCodeError extends Error {
  constructor(message: string, readonly attemptsLeft: number) {
    super(message);
    this.name = 'VerificationCodeError';
  }
}

/** The phone provider did not place the verification call. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** A stored settings or verification record that no longer validates; callers fail closed. */
export class StoredStateInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoredStateInvalidError';
  }
}

export class UnattendedRunError extends Error {
  constructor(message = 'This needs a person to confirm in an interactive chat') {
    super(message);
    this.name = 'UnattendedRunError';
  }
}
