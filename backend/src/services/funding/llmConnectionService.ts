/**
 * ENG-2105 (A1): customer LLM provider keys — add, check, list, share, revoke.
 *
 * Rules (decided 2026-10-09):
 *  - A user may hold several keys, for any supported provider, several per provider.
 *    They are tried in the order they were added.
 *  - A user who belongs to no org manages their own keys.
 *  - In an org only an owner may add a key or share one. A shared key is usable by
 *    every member's runs. Members cannot add keys.
 *  - Anyone may revoke a key they own, whatever their role: removing a secret is
 *    always allowed. An owner may also revoke a key another owner shared with the org.
 *  - Revoking deletes the encrypted key in the same write. It cannot be undone.
 *
 * The raw key leaves this module in exactly one place, `getKeyMaterial`, which no
 * HTTP route calls. It is never logged and never part of an error.
 */

import { randomUUID } from "crypto";
import { orgDb, userDb } from "../db";
import { roleOf, type AuthzOrg, type AuthzUser } from "../orgAuthz";
import { isByokEnabledFor } from "./fundingFlags";
import type { LlmConnection } from "./llmConnection";
import { AwsKmsPort, openSecret, sealSecret, type KmsPort } from "./llmConnectionCrypto";
import { LlmConnectionDb, type LlmConnectionRecord } from "./llmConnectionDb";
import {
  isSupportedByokProvider,
  keyCheckAccepted,
  validateProviderKey,
  type ByokProvider,
  type KeyCheckResult,
} from "./llmProviderValidation";

export const MAX_ACTIVE_CONNECTIONS_PER_OWNER = 10;

export type LlmConnectionErrorCode =
  | "byok_disabled"
  | "forbidden"
  | "unsupported_provider"
  | "invalid_key_format"
  | "key_rejected"
  | "provider_unreachable"
  | "limit_reached"
  | "not_found"
  | "not_in_org"
  | "not_usable";

const HTTP_STATUS: Record<LlmConnectionErrorCode, number> = {
  byok_disabled: 403,
  forbidden: 403,
  unsupported_provider: 400,
  invalid_key_format: 400,
  key_rejected: 422,
  provider_unreachable: 503,
  limit_reached: 409,
  not_found: 404,
  not_in_org: 409,
  not_usable: 409,
};

export class LlmConnectionError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: LlmConnectionErrorCode,
    /** Why the provider refused the key, for `key_rejected`. Never the provider's own text. */
    readonly checkResult?: KeyCheckResult,
  ) {
    super(`llm connection: ${code}`);
    this.name = "LlmConnectionError";
    this.httpStatus = HTTP_STATUS[code];
  }
}

export interface Actor {
  userId: string;
  /** The admin acting in a delegated session, recorded for audit. */
  adminId?: string;
}

/** What an API response may carry about a connection. No key material, sealed or not. */
export interface LlmConnectionView extends Omit<LlmConnection, "secretRef"> {
  /** True when the caller owns it; false for a key another owner shared with the org. */
  ownedByCaller: boolean;
  /** Claude-login connections only: non-secret facts about the stored login. */
  subscription?: { plan?: string; needsReconnect: boolean };
}

interface UserLike extends AuthzUser {
  userId: string;
}

export interface LlmConnectionServiceDeps {
  db: LlmConnectionDb;
  kms: KmsPort;
  validateKey: (provider: ByokProvider, apiKey: string) => Promise<KeyCheckResult>;
  isByokEnabledFor: (userId: string) => Promise<boolean>;
  getUser: (userId: string) => Promise<UserLike | null>;
  getOrg: (orgId: string) => Promise<AuthzOrg | null>;
  now: () => string;
  newId: () => string;
  /** Best-effort, called after a connection is revoked. Must not throw into the request. */
  onRevoked?: (connectionId: string) => void;
  /**
   * Disconnects a HOSTED login (ENG-2110 1c): its home lives on the login host and must be wiped there before the record may say
   * revoked, so the plain `db.revoke` write refuses such rows. Absent = hosted rows cannot be revoked through this service.
   */
  revokeHosted?: (actor: Actor, connectionId: string) => Promise<"revoked" | "revoking">;
}

interface Access {
  user: UserLike;
  org: AuthzOrg | null;
  /** May add keys and share them: a user with no org, or an org owner. */
  canManage: boolean;
}

export function toView(record: LlmConnectionRecord, callerId: string): LlmConnectionView {
  return {
    connectionId: record.connectionId,
    ownerUserId: record.ownerUserId,
    kind: record.kind,
    provider: record.provider,
    status: record.status,
    keyLast4: record.keyLast4,
    createdAt: record.createdAt,
    ...(record.orgId ? { sharedWithOrgId: record.orgId } : {}),
    health: {
      ...(record.lastOkAt ? { lastOkAt: record.lastOkAt } : {}),
      // A Claude login's refresh token has a fixed lifetime; this is when the customer must sign in again.
      ...(record.subRefreshExpiresAtMs ? { expiresAt: new Date(record.subRefreshExpiresAtMs).toISOString() } : {}),
    },
    ownedByCaller: record.ownerUserId === callerId,
    ...(record.kind === "claude_subscription"
      ? { subscription: { ...(record.subType ? { plan: record.subType } : {}), needsReconnect: record.subNeedsReconnect === true } }
      : {}),
  };
}

/**
 * Owners only, not admins: a shared key spends the owner's own provider account on
 * every member's runs.
 */
function isOrgOwner(user: AuthzUser, org: AuthzOrg): boolean {
  return roleOf(user, org) === "owner";
}

/** A key as pasted: one line, no spaces, printable ASCII, a plausible length. */
function normalizeApiKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  if (key.length < 20 || key.length > 512) return null;
  return /^[\x21-\x7e]+$/.test(key) ? key : null;
}

export class LlmConnectionService {
  constructor(private readonly deps: LlmConnectionServiceDeps) {}

  private async access(userId: string): Promise<Access> {
    const user = await this.deps.getUser(userId);
    if (!user) throw new LlmConnectionError("forbidden");
    if (!user.orgId) return { user, org: null, canManage: true };
    const org = await this.deps.getOrg(user.orgId);
    // An org that cannot be loaded grants nothing.
    if (!org) return { user, org: null, canManage: false };
    return { user, org, canManage: isOrgOwner(user, org) };
  }

  private async requireEnabled(userId: string): Promise<void> {
    if (!(await this.deps.isByokEnabledFor(userId))) throw new LlmConnectionError("byok_disabled");
  }

  /** The caller's own connections, then keys shared with their org. Revoked ones are left out. */
  async list(userId: string): Promise<{ connections: LlmConnectionView[]; canManage: boolean; inOrg: boolean }> {
    const access = await this.access(userId);
    const own = await this.deps.db.listByOwner(userId);
    // A revoked share, or one whose sharer has since left ownership, is already
    // unusable (`usableBy` would refuse it) — leaving it in would show a "shared" key
    // that silently fails the moment anyone tried to use it.
    const shared: LlmConnectionRecord[] = [];
    if (access.org) {
      for (const record of await this.deps.db.listSharedWithOrg(access.org.orgId)) {
        if (record.status !== "revoked" && (await this.sharerStillOwns(record, access.org))) shared.push(record);
      }
    }
    const seen = new Set(own.map((record) => record.connectionId));
    const all = [...own, ...shared.filter((record) => !seen.has(record.connectionId))];
    return {
      connections: all.filter((record) => record.status !== "revoked").map((record) => toView(record, userId)),
      canManage: access.canManage,
      inOrg: access.org !== null,
    };
  }

  async add(actor: Actor, input: { provider: unknown; apiKey: unknown; shareWithOrg?: boolean }): Promise<LlmConnectionView> {
    await this.requireEnabled(actor.userId);
    const access = await this.access(actor.userId);
    if (!access.canManage) throw new LlmConnectionError("forbidden");
    if (!isSupportedByokProvider(input.provider)) throw new LlmConnectionError("unsupported_provider");
    const apiKey = normalizeApiKey(input.apiKey);
    if (!apiKey) throw new LlmConnectionError("invalid_key_format");
    if (input.shareWithOrg && !access.org) throw new LlmConnectionError("not_in_org");

    const result = await this.deps.validateKey(input.provider, apiKey);
    if (result === "provider_unreachable") throw new LlmConnectionError("provider_unreachable");
    if (!keyCheckAccepted(result)) throw new LlmConnectionError("key_rejected", result);

    const connectionId = this.deps.newId();
    const now = this.deps.now();
    const sealed = await sealSecret(this.deps.kms, apiKey, {
      connectionId,
      ownerUserId: actor.userId,
      provider: input.provider,
    });
    const record: LlmConnectionRecord = {
      connectionId,
      ownerUserId: actor.userId,
      kind: "api_key",
      provider: input.provider,
      status: "active",
      keyLast4: apiKey.slice(-4),
      createdAt: now,
      updatedAt: now,
      sealed,
      lastCheckedAt: now,
      lastCheckResult: result,
      lastOkAt: now,
      ...(input.shareWithOrg && access.org ? { orgId: access.org.orgId } : {}),
      ...(actor.adminId ? { addedByAdminId: actor.adminId } : {}),
    };
    // Checked and created in one transaction: a plain count-then-create has a window
    // where concurrent adds each see a fresh count under the cap and all go through.
    if (!(await this.deps.db.createWithinLimit(record, MAX_ACTIVE_CONNECTIONS_PER_OWNER))) {
      throw new LlmConnectionError("limit_reached");
    }
    return toView(record, actor.userId);
  }

  /** Loads a connection the caller may see: their own, or one shared with their org. */
  private async visible(userId: string, connectionId: string): Promise<{ record: LlmConnectionRecord; access: Access }> {
    const access = await this.access(userId);
    const record = await this.deps.db.get(connectionId);
    const sharedHere = !!record?.orgId && access.org?.orgId === record.orgId;
    // Same answer for "does not exist" and "not yours", so ids cannot be probed.
    if (!record || (record.ownerUserId !== userId && !sharedHere)) throw new LlmConnectionError("not_found");
    return { record, access };
  }

  async revoke(actor: Actor, connectionId: string): Promise<"revoked" | "revoking"> {
    const { record, access } = await this.visible(actor.userId, connectionId);
    const own = record.ownerUserId === actor.userId;
    if (!own && !access.canManage) throw new LlmConnectionError("forbidden");
    if (record.subHosted) {
      // A hosted login is owner-only and is wiped by the login host first; "revoking" is accepted work (the sweeper finishes it).
      if (!own || !this.deps.revokeHosted) throw new LlmConnectionError("forbidden");
      try {
        return await this.deps.revokeHosted(actor, connectionId);
      } catch (err) {
        if ((err as { code?: string })?.code === "not_found") throw new LlmConnectionError("not_found");
        throw err;
      }
    }
    // Already revoked is success: the caller wanted it gone and it is.
    const didRevoke = await this.deps.db.revoke(connectionId, { userId: actor.userId, adminId: actor.adminId }, this.deps.now());
    // Only the call that actually revoked it owned that slot; a second revoke of an
    // already-revoked connection must not release a slot that was already freed.
    if (didRevoke) {
      // Stop a running holder first: the revoke is committed whatever happens to the slot bookkeeping after it.
      try {
        this.deps.onRevoked?.(connectionId);
      } catch {
        /* a holder in another process notices at its next heartbeat */
      }
      await this.deps.db.releaseSlot(record.ownerUserId);
    }
    return "revoked";
  }

  async setShared(actor: Actor, connectionId: string, shared: boolean): Promise<LlmConnectionView> {
    const { record, access } = await this.visible(actor.userId, connectionId);
    if (record.ownerUserId !== actor.userId) throw new LlmConnectionError("forbidden");
    if (record.status === "revoked") throw new LlmConnectionError("not_found");
    // A Claude login is for its owner's ordinary use; sharing it across an org is never allowed.
    if (record.kind !== "api_key") throw new LlmConnectionError("forbidden");
    if (shared) {
      await this.requireEnabled(actor.userId);
      if (!access.org) throw new LlmConnectionError("not_in_org");
      if (!access.canManage) throw new LlmConnectionError("forbidden");
    }
    const orgId = shared && access.org ? access.org.orgId : null;
    const updated = await this.deps.db.setSharedOrg(connectionId, orgId, this.deps.now());
    if (!updated) throw new LlmConnectionError("not_found");
    const { orgId: _previous, ...rest } = record;
    return toView({ ...rest, ...(orgId ? { orgId } : {}) }, actor.userId);
  }

  /** Re-checks the stored key against its provider and records the outcome. */
  async validate(actor: Actor, connectionId: string): Promise<{ result: KeyCheckResult; connection: LlmConnectionView }> {
    await this.requireEnabled(actor.userId);
    const { record, access } = await this.visible(actor.userId, connectionId);
    if (record.ownerUserId !== actor.userId && !access.canManage) throw new LlmConnectionError("forbidden");
    // A Claude login is not a provider key: its sealed blob must never be opened here or sent to a validator.
    if (record.kind !== "api_key" || record.status === "revoked" || !record.sealed || !isSupportedByokProvider(record.provider)) {
      throw new LlmConnectionError("not_found");
    }
    const apiKey = await openSecret(this.deps.kms, record.sealed, {
      connectionId: record.connectionId,
      ownerUserId: record.ownerUserId,
      provider: record.provider,
    });
    const result = await this.deps.validateKey(record.provider, apiKey);

    // The provider round-trip can take seconds; re-read so a revoke that lands during
    // it is never papered over by the record captured before the call started.
    const current = await this.deps.db.get(connectionId);
    if (!current || current.status === "revoked") throw new LlmConnectionError("not_found");

    // An unreachable provider says nothing about the key, so the stored status is left alone.
    if (result === "provider_unreachable" || result === "unknown") return { result, connection: toView(current, actor.userId) };
    const ok = keyCheckAccepted(result);
    // Out of quota is a state of the customer's provider account, not a bad key.
    const status = ok || result === "quota_exhausted" ? "active" : "invalid";
    const now = this.deps.now();
    // A revoke landing in this exact instant is still possible; recordCheck's own
    // conditional write is the final word, not the re-read above.
    if (!(await this.deps.db.recordCheck(connectionId, { result, status, ok }, now))) {
      throw new LlmConnectionError("not_found");
    }
    return {
      result,
      connection: toView({ ...current, status, ...(ok ? { lastOkAt: now } : {}) }, actor.userId),
    };
  }

  /**
   * Whether `userId`'s runs may spend this connection: their own key, or a key shared
   * with their org by someone who is still an owner of it.
   */
  private async usableBy(record: LlmConnectionRecord, access: Access): Promise<boolean> {
    // Only provider API keys are ever used as keys; a Claude login is reachable only through its own service.
    if (record.kind !== "api_key") return false;
    if (record.status !== "active" || !record.sealed) return false;
    if (record.ownerUserId === access.user.userId) return true;
    if (!access.org) return false;
    return this.sharerStillOwns(record, access.org);
  }

  /** Whether the person who shared `record` with an org is still an owner of it. */
  private async sharerStillOwns(record: LlmConnectionRecord, org: AuthzOrg): Promise<boolean> {
    if (!record.orgId || record.orgId !== org.orgId) return false;
    const sharer = await this.deps.getUser(record.ownerUserId);
    return !!sharer && sharer.orgId === org.orgId && isOrgOwner(sharer, org);
  }

  /** Connections this user's runs may spend, in the order to try them: own first, then the org's. */
  async listUsableForUser(userId: string): Promise<LlmConnectionView[]> {
    const access = await this.access(userId);
    const own = await this.deps.db.listByOwner(userId);
    const shared = access.org ? await this.deps.db.listSharedWithOrg(access.org.orgId) : [];
    const seen = new Set(own.map((record) => record.connectionId));
    const usable: LlmConnectionView[] = [];
    const enabledByOwner = new Map<string, boolean>();
    for (const record of [...own, ...shared.filter((r) => !seen.has(r.connectionId))]) {
      if (!(await this.usableBy(record, access))) continue;
      // The switch is checked for whoever's provider account pays.
      let enabled = enabledByOwner.get(record.ownerUserId);
      if (enabled === undefined) {
        enabled = await this.deps.isByokEnabledFor(record.ownerUserId);
        enabledByOwner.set(record.ownerUserId, enabled);
      }
      if (enabled) usable.push(toView(record, userId));
    }
    return usable;
  }

  /**
   * What routing must know about a user's connections for ONE provider, so a customer who
   * has a key never silently becomes AgentWeb-funded because that key is not usable right
   * now (pending, invalid, suspended, anything).
   *
   * `hasConnection`: the user can reach at least one non-revoked connection for the
   * provider (their own, or one shared with their org by someone who is still an owner)
   * whose owner has BYOK switched on. `usable`: the subset that can serve a call now.
   * Revoked connections count as neither: revoking is how a customer says they are done.
   */
  async routingStateFor(userId: string, provider: string): Promise<{ hasConnection: boolean; usable: LlmConnectionView[] }> {
    const access = await this.access(userId);
    const own = await this.deps.db.listByOwner(userId);
    const shared = access.org ? await this.deps.db.listSharedWithOrg(access.org.orgId) : [];
    const seen = new Set(own.map((record) => record.connectionId));
    const enabledByOwner = new Map<string, boolean>();
    let hasConnection = false;
    const usable: LlmConnectionView[] = [];
    for (const record of [...own, ...shared.filter((r) => !seen.has(r.connectionId))]) {
      if (record.kind !== "api_key" || record.provider !== provider || record.status === "revoked") continue;
      const mine = record.ownerUserId === userId;
      if (!mine && !(access.org && (await this.sharerStillOwns(record, access.org)))) continue;
      let enabled = enabledByOwner.get(record.ownerUserId);
      if (enabled === undefined) {
        enabled = await this.deps.isByokEnabledFor(record.ownerUserId);
        enabledByOwner.set(record.ownerUserId, enabled);
      }
      if (!enabled) continue;
      hasConnection = true;
      if (await this.usableBy(record, access)) usable.push(toView(record, userId));
    }
    return { hasConnection, usable };
  }

  /**
   * The raw provider key, for a transport about to make a call on `forUserId`'s behalf.
   * Reads the connection fresh every time, so a revoke takes effect on the next call.
   * Callers must not cache the result beyond the run and must never log it.
   */
  async getKeyMaterial(connectionId: string, forUserId: string): Promise<{ provider: string; apiKey: string }> {
    const access = await this.access(forUserId);
    const record = await this.deps.db.get(connectionId);
    if (!record || !(await this.usableBy(record, access)) || !record.sealed) throw new LlmConnectionError("not_usable");
    if (!(await this.deps.isByokEnabledFor(record.ownerUserId))) throw new LlmConnectionError("byok_disabled");
    const apiKey = await openSecret(this.deps.kms, record.sealed, {
      connectionId: record.connectionId,
      ownerUserId: record.ownerUserId,
      provider: record.provider,
    });
    return { provider: record.provider, apiKey };
  }
}

let defaultService: LlmConnectionService | null = null;

export function getLlmConnectionService(): LlmConnectionService {
  if (!defaultService) {
    defaultService = new LlmConnectionService({
      db: new LlmConnectionDb(),
      kms: new AwsKmsPort(),
      validateKey: validateProviderKey,
      isByokEnabledFor,
      getUser: async (userId) => (await userDb.getUserById(userId)) as UserLike | null,
      getOrg: async (orgId) => (await orgDb.getOrgById(orgId)) as AuthzOrg | null,
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      // A hosted login is wiped by the login host before its record may say revoked (ENG-2110 1c).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      revokeHosted: (actor, id) => (require("./hostedSubscriptionService") as typeof import("./hostedSubscriptionService")).getHostedSubscriptionService().revokeRecord(actor, id),
      // A running turn on a revoked Claude login must stop now, not at its next heartbeat (ENG-2110).
      onRevoked: (id) => (require("./claudeSubscriptionService") as typeof import("./claudeSubscriptionService")).abortClaudeSubscriptionConnection(id),
    });
  }
  return defaultService;
}
