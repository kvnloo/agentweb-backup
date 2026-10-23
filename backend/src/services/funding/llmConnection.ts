/**
 * ENG-1816 F1 — LlmConnection: the shape shared by every connection kind.
 *
 * A1 (ENG-2105) implements the `api_key` kind: `llmConnectionDb.ts` (store),
 * `llmConnectionCrypto.ts` (KMS envelope encryption) and `llmConnectionService.ts`
 * (add, validate, list masked, share, revoke). B3 adds `claude_subscription` on the
 * same store.
 */

export type LlmConnectionKind = "api_key" | "claude_subscription" | "codex_subscription";

/**
 * `revoking` and `disabled` exist only for hosted subscription logins (ENG-2110 1c): `revoking` = the owner disconnected and the
 * login host has not yet confirmed the wipe (the slot is already released); `disabled` = fenced but kept. Everything that routes
 * funding requires `=== "active"`, so both fail closed. "Needs reconnect" is `invalid` plus `subNeedsReconnect`.
 */
export type LlmConnectionStatus = "active" | "invalid" | "revoked" | "expired" | "revoking" | "disabled";

export interface LlmConnectionHealth {
  lastOkAt?: string;
  /** Fixed expiry for subscription kinds — does not extend on refresh (verified). */
  expiresAt?: string;
  lastLimitObservedAt?: string;
}

export interface LlmConnection {
  connectionId: string;
  ownerUserId: string;
  kind: LlmConnectionKind;
  provider?: string;
  /**
   * A reference to KMS-envelope-encrypted material (e.g. a DynamoDB item key), never
   * the secret itself. Must never be logged or returned by any API response.
   */
  secretRef: string;
  status: LlmConnectionStatus;
  health?: LlmConnectionHealth;
  /** Last four characters of the key, for display. */
  keyLast4?: string;
  /** Set while the owner shares this connection with their org. */
  sharedWithOrgId?: string;
  createdAt?: string;
}
