/**
 * ENG-827 — abandoning a publish because the owner withdrew consent mid-flight is a
 * DELIBERATE stop, not a platform failure, and the difference matters: a failure is
 * something a caller may retry, and retrying this one would publish the thing the
 * owner just said no to.
 *
 * The services that write to a social platform are several layers below the handler
 * that knows how to phrase a refusal, and the last safe moment to check sits inside
 * them — after the token refresh, after the media upload, immediately before the HTTP
 * request. They therefore signal by throwing this, and the handler converts it back
 * into the same refusal shape every other consent check returns.
 *
 * The guard is a flag rather than `instanceof` on purpose: jest can load a module
 * twice through different registries, which gives two distinct classes and an
 * `instanceof` that silently returns false — turning a stop into a reported crash.
 */
export class PublishConsentWithdrawn extends Error {
  readonly isPublishConsentWithdrawn = true;

  constructor(message: string) {
    super(message);
    this.name = 'PublishConsentWithdrawn';
  }
}

export function isPublishConsentWithdrawn(error: unknown): error is PublishConsentWithdrawn {
  return typeof error === 'object'
    && error !== null
    && (error as { isPublishConsentWithdrawn?: unknown }).isPublishConsentWithdrawn === true;
}
