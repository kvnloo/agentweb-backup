/**
 * Pure-logic helpers for the Lead attribution backfill script
 * (backend/scripts/backfill-lead-attribution.ts).
 *
 * Extracted so the copy-from-user logic is unit-testable without DynamoDB.
 * The script is thin orchestration: scan leads -> look up matching user by
 * email -> call `deriveAttributionFromUser()` -> write back with an UPDATE.
 *
 * Task: https://www.notion.so/34709247c951813f8874eeee9e4d2cbe
 */

import type { AttributionTouch } from '../types/attribution';

/** Minimal shape the backfill consumes from AW-Leads rows. */
export interface BackfillAttributionLead {
  listId: string;
  leadId: string;
  email?: string | null;
  firstTouch?: AttributionTouch | null;
  lastTouch?: AttributionTouch | null;
  utmSource?: string | null;
  utmMedium?: string | null;
}

/** Minimal shape the backfill consumes from AW-Users rows. */
export interface BackfillAttributionUser {
  userId: string;
  email: string;
  firstTouch?: AttributionTouch | null;
  lastTouch?: AttributionTouch | null;
  utmSource?: string | null;
  utmMedium?: string | null;
}

export interface AttributionUpdate {
  firstTouch?: AttributionTouch;
  lastTouch?: AttributionTouch;
  utmSource?: string;
  utmMedium?: string;
}

/**
 * A lead is considered "already backfilled" when it has any attribution signal
 * on it. Idempotent runs just skip these. Callers that want to force-refresh
 * should pass `{ force: true }`.
 */
export function isLeadAttributionAlreadyPopulated(
  lead: BackfillAttributionLead
): boolean {
  return Boolean(lead.firstTouch || lead.lastTouch || lead.utmSource || lead.utmMedium);
}

/**
 * Given a Lead and the matching User row, return the attribution update that
 * should be applied. Returns null when there is nothing to copy (either no
 * matching user, user has no attribution, or lead is already populated).
 *
 * Contract:
 * - Never overwrites an existing lead.firstTouch. The earliest signal wins.
 * - Copies lastTouch when the user has one. Fallback to firstTouch.
 * - Denormalizes utmSource / utmMedium from firstTouch only when lead is blank.
 *
 * Returns `null` when the update would be a no-op so callers can skip the
 * DynamoDB write entirely.
 */
export function deriveAttributionFromUser(
  lead: BackfillAttributionLead,
  user: BackfillAttributionUser | null,
  opts: { force?: boolean } = {}
): AttributionUpdate | null {
  if (!user) return null;
  if (!opts.force && isLeadAttributionAlreadyPopulated(lead)) return null;

  const update: AttributionUpdate = {};

  // firstTouch — copy only when lead doesn't have one (earliest signal wins).
  if (!lead.firstTouch && user.firstTouch) {
    update.firstTouch = user.firstTouch;
  }
  // lastTouch — copy the user's lastTouch, or fall back to firstTouch.
  if (!lead.lastTouch) {
    const candidate = user.lastTouch || user.firstTouch;
    if (candidate) update.lastTouch = candidate;
  }

  // Denormalized utm* — prefer explicit user fields, fall back to
  // firstTouch.utm (what controllers/auth.ts writes).
  const finalSource =
    (typeof user.utmSource === 'string' && user.utmSource.trim()) ||
    user.firstTouch?.utm?.source?.trim() ||
    '';
  const finalMedium =
    (typeof user.utmMedium === 'string' && user.utmMedium.trim()) ||
    user.firstTouch?.utm?.medium?.trim() ||
    '';

  if (!lead.utmSource && finalSource) update.utmSource = finalSource;
  if (!lead.utmMedium && finalMedium) update.utmMedium = finalMedium;

  // Nothing to copy -> no-op (skip the DynamoDB write entirely).
  if (Object.keys(update).length === 0) return null;
  return update;
}

/**
 * Build the DynamoDB UpdateExpression fragments for an AttributionUpdate.
 * Returns undefined when update is null/empty, matching existing scripts.
 */
export function buildAttributionUpdateExpression(
  update: AttributionUpdate | null
):
  | {
      UpdateExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    }
  | undefined {
  if (!update) return undefined;
  const keys = Object.keys(update) as Array<keyof AttributionUpdate>;
  if (keys.length === 0) return undefined;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  keys.forEach((k, i) => {
    const nameKey = `#attr_${i}`;
    const valKey = `:attr_${i}`;
    names[nameKey] = String(k);
    values[valKey] = update[k];
    sets.push(`${nameKey} = ${valKey}`);
  });

  return {
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}
