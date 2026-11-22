/**
 * ENG-2109 (B2): the run-scoped credential a `claude -p` session presents to the tool
 * bridge. One live token per run, bound to that run's user and session, dead the
 * moment the run ends.
 *
 * A harness fixes its MCP config, and so this token, when its process is spawned, and
 * the process stays open across a conversation's turns. Expiry is therefore idle-based:
 * each successful verify extends it, and a token unused for the TTL dies.
 *
 * Opaque and server-side on purpose: there is nothing in the token to forge, and
 * revocation is immediate. The record lives in this process, which is correct only
 * while one backend instance serves the bridge; the worker host (ENG-2114) needs a
 * shared store before it can verify tokens minted here.
 */

import { createHash, randomBytes } from "crypto";

export interface RunToolTokenClaims {
  runId: string;
  userId: string;
  sessionId: string;
}

export type RunToolTokenRejection = "missing" | "unknown" | "expired" | "wrong_run";

export type RunToolTokenVerification =
  | { ok: true; claims: RunToolTokenClaims }
  | { ok: false; reason: RunToolTokenRejection };

interface TokenRecord {
  claims: RunToolTokenClaims;
  expiresAtMs: number;
}

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;

export class RunToolTokenStore {
  // Keyed by the token's hash so the raw value never sits in memory after mint().
  private readonly recordsByHash = new Map<string, TokenRecord>();
  private readonly hashByRunId = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Mints the run's token, revoking any earlier one for the same run. */
  mint(claims: RunToolTokenClaims): string {
    this.revokeRun(claims.runId);
    this.pruneExpired();
    const raw = randomBytes(32).toString("base64url");
    const hash = hashToken(raw);
    this.recordsByHash.set(hash, { claims: { ...claims }, expiresAtMs: this.now() + this.ttlMs });
    this.hashByRunId.set(claims.runId, hash);
    return raw;
  }

  /**
   * `expectedRunId` is the run the caller addressed (e.g. the run id in the bridge
   * URL). A valid token for a different run is rejected as `wrong_run`.
   */
  verify(raw: string | undefined | null, expectedRunId?: string): RunToolTokenVerification {
    if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "missing" };
    const hash = hashToken(raw);
    const record = this.recordsByHash.get(hash);
    if (!record) return { ok: false, reason: "unknown" };
    if (this.now() >= record.expiresAtMs) {
      this.deleteByHash(hash);
      return { ok: false, reason: "expired" };
    }
    if (expectedRunId !== undefined && expectedRunId !== record.claims.runId) {
      return { ok: false, reason: "wrong_run" };
    }
    record.expiresAtMs = this.now() + this.ttlMs;
    return { ok: true, claims: { ...record.claims } };
  }

  revokeRun(runId: string): void {
    const hash = this.hashByRunId.get(runId);
    if (hash) this.deleteByHash(hash);
  }

  private deleteByHash(hash: string): void {
    const record = this.recordsByHash.get(hash);
    this.recordsByHash.delete(hash);
    if (record && this.hashByRunId.get(record.claims.runId) === hash) {
      this.hashByRunId.delete(record.claims.runId);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [hash, record] of this.recordsByHash) {
      if (now >= record.expiresAtMs) this.deleteByHash(hash);
    }
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
