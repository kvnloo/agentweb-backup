/**
 * Admin-only funnelStatus inspect/update capability for Emma (ENG-752).
 *
 * Mirrors the supported `PUT /api/admin/users/:userId/funnel-status` write
 * (same `userDb.updateUser({ funnelStatus })` call) and adds what that route
 * lacks for agent use: email resolution, a closed stage vocabulary, a bounded
 * previewable/idempotent batch, and a per-change audit record. No new store.
 */
import { USER_FUNNEL_STATUS_VALUES } from '../utils/userFunnelStatus';

export const MAX_FUNNEL_STATUS_BATCH = 50;

export interface FunnelStatusUser {
  userId: string;
  email: string;
  funnelStatus?: string | null;
}

export interface FunnelStatusDeps {
  getUserByEmail: (email: string) => Promise<FunnelStatusUser | undefined | null>;
  updateFunnelStatus: (userId: string, funnelStatus: string | null) => Promise<unknown>;
  audit: (event: Record<string, unknown> & { actorUserId: string; action: string }) => void;
  now?: () => Date;
}

export interface FunnelStatusRequestRow {
  email: string;
  funnel_status?: string | null;
}

export interface FunnelStatusResultRow {
  email: string;
  userId?: string;
  before?: string | null;
  after?: string | null;
  outcome: 'read' | 'would_update' | 'updated' | 'skipped_unchanged' | 'unresolved' | 'invalid';
  reason?: string;
}

export interface FunnelStatusActor {
  actorUserId: string;
  actorEmail: string;
  accountableOwner: string;
}

export type FunnelStatusMode = 'read' | 'preview' | 'apply';

function normalizeStatus(value: unknown): { ok: true; value: string | null } | { ok: false; reason: string } {
  // Only an explicit JSON null clears the stage; empty/whitespace strings and
  // undefined are refused so a model sending "" for "none" cannot wipe a stage.
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, reason: 'funnel_status must be a string or null' };
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: `funnel_status must be one of ${USER_FUNNEL_STATUS_VALUES.join(', ')} or null (empty string is not a clear)` };
  }
  if (!USER_FUNNEL_STATUS_VALUES.includes(trimmed)) {
    return { ok: false, reason: `funnel_status must be one of ${USER_FUNNEL_STATUS_VALUES.join(', ')} or null` };
  }
  return { ok: true, value: trimmed };
}

export async function runFunnelStatusOperation(
  mode: FunnelStatusMode,
  rows: FunnelStatusRequestRow[],
  actor: FunnelStatusActor,
  deps: FunnelStatusDeps
): Promise<{ mode: FunnelStatusMode; rows: FunnelStatusResultRow[]; summary: Record<string, number> }> {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be a non-empty array');
  if (rows.length > MAX_FUNNEL_STATUS_BATCH) {
    throw new Error(`At most ${MAX_FUNNEL_STATUS_BATCH} rows per call`);
  }
  const now = deps.now ?? (() => new Date());
  const seen = new Set<string>();
  const results: FunnelStatusResultRow[] = [];

  for (const row of rows) {
    const email = typeof row?.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (!email) {
      results.push({ email: '', outcome: 'invalid', reason: 'email is required' });
      continue;
    }
    if (seen.has(email)) {
      results.push({ email, outcome: 'invalid', reason: 'duplicate email in batch' });
      continue;
    }
    seen.add(email);

    let target: string | null = null;
    if (mode !== 'read') {
      if (!row || !('funnel_status' in row)) {
        results.push({ email, outcome: 'invalid', reason: 'funnel_status is required (use null to clear)' });
        continue;
      }
      const parsed = normalizeStatus(row.funnel_status);
      if (!parsed.ok) {
        results.push({ email, outcome: 'invalid', reason: parsed.reason });
        continue;
      }
      target = parsed.value;
    }

    const user = await deps.getUserByEmail(email);
    if (!user?.userId) {
      results.push({ email, outcome: 'unresolved', reason: 'no user with this email' });
      continue;
    }
    const before = user.funnelStatus ?? null;
    if (mode === 'read') {
      results.push({ email, userId: user.userId, before, outcome: 'read' });
      continue;
    }
    if (before === target) {
      results.push({ email, userId: user.userId, before, after: target, outcome: 'skipped_unchanged' });
      continue;
    }
    if (mode === 'preview') {
      results.push({ email, userId: user.userId, before, after: target, outcome: 'would_update' });
      continue;
    }
    await deps.updateFunnelStatus(user.userId, target);
    deps.audit({
      action: 'user_funnel_status_update',
      actorUserId: actor.actorUserId,
      actorEmail: actor.actorEmail,
      accountableOwner: actor.accountableOwner,
      targetUserId: user.userId,
      targetEmail: email,
      before,
      after: target,
      changedAt: now().toISOString(),
    });
    results.push({ email, userId: user.userId, before, after: target, outcome: 'updated' });
  }

  const summary: Record<string, number> = {};
  for (const r of results) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1;
  return { mode, rows: results, summary };
}
