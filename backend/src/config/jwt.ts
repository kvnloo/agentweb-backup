/**
 * Central accessor for the JWT signing/verification secret.
 *
 * Historically the secret was read inline with a hardcoded fallback string at a dozen
 * sites covering both signing and verification. If JWT_SECRET ever became unset (new
 * environment, config drift, local misconfig), every one of those fell back to a
 * publicly-known value, making tokens forgeable and enabling a full auth bypass —
 * including admin. This accessor removes the fallback: it reads the env var and throws
 * if it is missing or empty, so the failure is loud instead of silently insecure.
 *
 * Read at call time (not module load) so it never depends on dotenv/import ordering.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to sign or verify tokens with a fallback secret. ' +
        'Set JWT_SECRET in the environment before starting the server.'
    );
  }
  return secret;
}

/**
 * Boot-time assertion. Call once at startup (before binding the port) so a missing
 * JWT_SECRET exits the process with a clear message instead of surfacing as a runtime
 * error on the first authenticated request.
 */
export function assertJwtSecretAtBoot(): void {
  try {
    getJwtSecret();
  } catch (err) {
    console.error(`[FATAL] ${(err as Error).message}`);
    process.exit(1);
  }
}
