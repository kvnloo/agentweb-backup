/**
 * ENG-1816 F1 — LlmConnection: type and store interface only.
 *
 * A1 builds the real DynamoDB-backed CRUD for the `api_key` kind (KMS envelope
 * encryption, live-validate, list masked, revoke). B3 adds the `claude_subscription`
 * kind on the same store. Nothing in F1 constructs or reads a real `LlmConnection` —
 * this file exists so A1/A2/B3 build against one agreed shape instead of three.
 */

export type LlmConnectionKind = "api_key" | "claude_subscription" | "codex_subscription";

export type LlmConnectionStatus = "active" | "invalid" | "revoked" | "expired";

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
}

/** Real implementation lands in A1 (api_key) and B3 (claude_subscription). */
export interface LlmConnectionStore {
  get(connectionId: string): Promise<LlmConnection | null>;
  listForUser(ownerUserId: string): Promise<LlmConnection[]>;
  revoke(connectionId: string): Promise<void>;
}
