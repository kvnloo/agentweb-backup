/**
 * Bridges the unauthenticated OAuth callback (a browser redirect from AF,
 * carrying no bearer token) back to the AgentWeb user who started the connect
 * flow — WITHOUT trusting the callback's own `external_user_id` query param,
 * which the vendor's own docs call out as unsigned and attacker-controllable.
 *
 * Same shape as the existing `mcp/client/mcpOAuthClientProvider.ts`'s
 * `PendingSessionRecord`/`PENDING_SETTING` pattern (settingsService-backed,
 * short TTL) — reused here rather than invented fresh, and durable across an
 * EB process restart mid-flow (an in-memory Map would not survive that).
 *
 * The AF `connection_id` we send at initiate-time IS the opaque pending id:
 * AF documents connection_id as "any label you invent," and it's the one
 * field the vendor's callback reliably echoes back. 16 random bytes — nothing
 * guessable, nothing an attacker could forge to redirect a real user's
 * completed consent onto their own account.
 */

import crypto from 'crypto';
import { settingsService } from '../../services/settingsService';

const SETTING_KEY = 'agentic_fabriq_spike_pending_connects';
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingConnectRecord {
  pendingId: string;
  userId: string;
  provider: string;
  createdAt: number;
}

async function loadAll(): Promise<PendingConnectRecord[]> {
  const setting = await settingsService.getSetting(SETTING_KEY);
  if (!setting) return [];
  try {
    const parsed = JSON.parse(setting.settingValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAll(records: PendingConnectRecord[]): Promise<void> {
  await settingsService.setSetting(
    SETTING_KEY,
    JSON.stringify(records),
    'Agentic Fabriq spike (ENG-1685) pending OAuth connect bridge — safe to clear, regenerated per connect attempt',
    'agentic-fabriq-spike',
  );
}

function isExpired(record: PendingConnectRecord, nowMs: number): boolean {
  return nowMs - record.createdAt > PENDING_TTL_MS;
}

/** Called from /init, while the caller is authenticated. Returns the opaque connection_id to send to AF. */
export async function createPendingConnect(userId: string, provider: string, nowMs: number = Date.now()): Promise<string> {
  const pendingId = crypto.randomBytes(16).toString('hex');
  const records = (await loadAll()).filter((r) => !isExpired(r, nowMs));
  records.push({ pendingId, userId, provider, createdAt: nowMs });
  await saveAll(records);
  return pendingId;
}

/**
 * Called from the unauthenticated /callback route. Consumes (single-use) and
 * returns the userId this connection_id was minted for, or null if unknown/
 * expired/already consumed — the ONLY caller-facing signal, deliberately with
 * no distinction between those cases so a probing attacker learns nothing.
 */
export async function consumePendingConnect(pendingId: string, nowMs: number = Date.now()): Promise<string | null> {
  const records = await loadAll();
  const match = records.find((r) => r.pendingId === pendingId);
  const remaining = records.filter((r) => r.pendingId !== pendingId && !isExpired(r, nowMs));
  await saveAll(remaining); // single-use: consumed (or expired) entries never persist
  if (!match || isExpired(match, nowMs)) return null;
  return match.userId;
}
