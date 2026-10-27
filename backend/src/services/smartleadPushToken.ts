import { createHmac, timingSafeEqual } from "crypto";

/**
 * The stateless approval token of a Smartlead push (ENG-673). The preview signs what the user is about to approve (who, which list and
 * campaign, the options, the sequence as it was, how many leads) and the start call must present it back unchanged within 30 minutes, so
 * nothing is stored for an abandoned preview and the start cannot widen what was shown. It is SINGLE USE: the start consumes its `jti` in the run
 * table, because replaying an approval for a 50-lead test cohort would otherwise push 50 more each time (earlier runs' markers do not count
 * toward a new run's ceiling).
 */

export const PUSH_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface PushTokenPayload {
  /** Format version, so a later change can refuse tokens it cannot read. */
  v: 1;
  /** A unique id for this approval. The start consumes it once, so the same approval cannot be replayed to push more than was shown. */
  jti: string;
  userId: string;
  /** The Smartlead connection the preview used; the start must use the same one. */
  accountId: string;
  /** The user ticked "send even though my sequence could not be read" at preview. */
  acknowledgeUnreadable: boolean;
  listId: string;
  campaignId: number;
  includeUnverified: boolean;
  /** Tag name to CRM field, as approved. */
  mapping: Record<string, string>;
  acknowledgedTags: string[];
  /** The campaign's status at preview; a DRAFTED approval stops being valid if the campaign is started. */
  startStatus: string;
  sequenceHash: string;
  /** The approved count: a hard ceiling for the run (the cohort when the user chose a test cohort). */
  eligible: number;
  /** Warnings shown at preview, kept on the run for the audit. */
  warnings: string[];
  /** When the preview was taken (epoch milliseconds). A run started on this list and campaign after this makes the approval stale. */
  iat: number;
  /** Epoch milliseconds. */
  exp: number;
}

const DOMAIN = "smartlead-push-preview:v1:";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(DOMAIN + body).digest("base64url");

/** Keys are written in a fixed order so the same payload always gives the same token. */
function canonical(p: PushTokenPayload): string {
  return JSON.stringify({
    v: p.v, jti: p.jti, userId: p.userId, accountId: p.accountId, acknowledgeUnreadable: p.acknowledgeUnreadable, listId: p.listId, campaignId: p.campaignId, includeUnverified: p.includeUnverified,
    mapping: Object.fromEntries(Object.keys(p.mapping).sort().map(k => [k, p.mapping[k]])),
    acknowledgedTags: [...p.acknowledgedTags].sort(), startStatus: p.startStatus, sequenceHash: p.sequenceHash,
    eligible: p.eligible, warnings: p.warnings, iat: p.iat, exp: p.exp,
  });
}

export function signPushToken(secret: string, payload: PushTokenPayload): string {
  const body = b64(canonical(payload));
  return `${body}.${mac(secret, body)}`;
}

/** The payload, or null when the token is malformed, forged or expired. Never throws. */
export function verifyPushToken(secret: string, token: unknown, nowMs: number): PushTokenPayload | null {
  if (typeof token !== "string" || token.length > 20_000) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(mac(secret, body), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PushTokenPayload;
    if (p?.v !== 1 || typeof p.jti !== "string" || !p.jti || typeof p.accountId !== "string" || typeof p.acknowledgeUnreadable !== "boolean" || typeof p.userId !== "string" || typeof p.listId !== "string" || !Number.isInteger(p.campaignId) || p.campaignId <= 0) return null;
    if (!Number.isInteger(p.eligible) || p.eligible < 0 || typeof p.sequenceHash !== "string" || typeof p.iat !== "number" || typeof p.exp !== "number" || !(p.exp > nowMs)) return null;
    if (typeof p.includeUnverified !== "boolean" || !p.mapping || typeof p.mapping !== "object" || !Array.isArray(p.acknowledgedTags) || !Array.isArray(p.warnings)) return null;
    return p;
  } catch {
    return null;
  }
}
