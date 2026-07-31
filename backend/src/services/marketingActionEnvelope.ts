/**
 * Canonical marketing-action payloads on existing report/run data (ENG-446).
 *
 * ENG-445 defined ONE typed marketing-action contract and ONE deterministic
 * top-3 selector (`marketingActionContract.ts`) and deliberately left transport
 * and persistence to this module. This is that seam — the single place that
 * knows how a canonical action payload rides along on a report or run envelope.
 *
 * Why one seam (ENG-446 complexity ledger): the portal, the long-form report
 * response, and scheduled notifications all read the SAME field through the
 * SAME parser. No surface gets its own storage path, its own parser, or its own
 * ranking. Consumers render what the source already selected; they never
 * re-rank and never regenerate.
 *
 * The carrier field is `marketingActions` on the existing envelope — the run
 * result persisted by `scheduleDb.addRunResult` and the HTML-report file entry
 * returned by the executions-with-assets routes. No new table, no new
 * attribute path, no second envelope.
 *
 * Identity/idempotency: ids come from `marketingActionId(actionType, scopeId)`,
 * a normalized content hash. Re-attaching the same underlying actions on a
 * duplicate scheduled delivery or a retry therefore yields the same ids, and
 * any status already recorded against an id is carried forward rather than
 * reset — a retry must never silently un-approve a move a human approved.
 *
 * This module is PURE: no I/O, no network, no AWS, no Slack. It fails loud —
 * a tampered, drifted, or structurally invalid payload throws
 * MarketingActionContractError rather than flowing downstream half-valid.
 * Absent payloads are the one benign case: legacy report/run data simply has
 * no actions and reads as an empty list.
 */

import {
  MarketingAction,
  MarketingActionCandidate,
  MarketingActionContractError,
  MarketingActionStatus,
  parseMarketingActions,
  selectTopMarketingActions,
  transitionMarketingActionStatus,
} from './marketingActionContract';

/**
 * The one field name every report/run envelope uses to carry canonical actions.
 * Exported so consumers reference the seam instead of re-typing the string.
 */
export const MARKETING_ACTIONS_FIELD = 'marketingActions' as const;

/**
 * Mixed into existing report/run envelope types. Optional because legacy
 * report/run data predates the field and must keep working untouched.
 */
export interface MarketingActionCarrier {
  /** Canonical actions as selected by the source, in the source's order. */
  marketingActions?: MarketingAction[];
}

/** An envelope known to carry an explicit (possibly empty) action list. */
export type WithMarketingActions<T> = T & { marketingActions: MarketingAction[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read the canonical actions carried by a report/run envelope.
 *
 * Legacy envelopes — no field, a null field, or a non-object envelope entirely
 * — read as an empty list so existing reports and runs keep rendering. A field
 * that IS present is validated in full by ENG-445's `parseMarketingActions`,
 * including the check that each transported id still equals the canonical
 * `marketingActionId(actionType, scopeId)` derivation. Stored order is
 * returned verbatim: this function never re-ranks.
 */
export function readMarketingActions(envelope: unknown): MarketingAction[] {
  if (!isObject(envelope)) return [];

  const raw = envelope[MARKETING_ACTIONS_FIELD];
  if (raw === undefined || raw === null) return [];

  // Round-trip through ENG-445's validator so there is exactly ONE parser and
  // ONE identity check in the system, whatever transport delivered the payload.
  return parseMarketingActions(JSON.stringify(raw));
}

/**
 * Attach canonical actions to a report/run envelope.
 *
 * Selection is delegated entirely to ENG-445's `selectTopMarketingActions` —
 * this module holds no ranking logic of its own. Any status already recorded
 * against a canonical id on the incoming envelope is carried onto the freshly
 * selected action with the same id, so a duplicate delivery or a retry is
 * idempotent in both identity and lifecycle state. Actions that are no longer
 * selected simply drop; their status is not transplanted onto anything else.
 *
 * Returns a NEW envelope. The source object — including its long-form text or
 * HTML content — is never mutated.
 */
export function attachMarketingActions<T extends object>(
  envelope: T,
  candidates: MarketingActionCandidate[]
): WithMarketingActions<T> {
  const selected = selectTopMarketingActions(candidates);

  const priorStatusById = new Map<string, MarketingActionStatus>();
  for (const action of readMarketingActions(envelope)) {
    priorStatusById.set(action.id, action.status);
  }

  const actions = selected.map((action) => {
    const priorStatus = priorStatusById.get(action.id);
    return priorStatus === undefined
      ? action
      : transitionMarketingActionStatus(action, priorStatus);
  });

  return { ...envelope, [MARKETING_ACTIONS_FIELD]: actions } as WithMarketingActions<T>;
}

/**
 * Set the lifecycle status of one carried action, addressed by its canonical
 * id (proposed / approved / dismissed / completed). The id never changes, the
 * order never changes, and sibling actions are untouched.
 *
 * Throws when the id is not carried by this envelope or the status is unknown,
 * rather than silently no-opping — a status update that addressed the wrong
 * action must be visible, not lost.
 */
export function setMarketingActionStatus<T extends object>(
  envelope: T,
  actionId: string,
  status: MarketingActionStatus
): WithMarketingActions<T> {
  const actions = readMarketingActions(envelope);
  const index = actions.findIndex((action) => action.id === actionId);

  if (index === -1) {
    throw new MarketingActionContractError(
      `Marketing action "${actionId}" is not carried by this report/run envelope`
    );
  }

  const updated = actions.map((action, i) =>
    i === index ? transitionMarketingActionStatus(action, status) : action
  );

  return { ...envelope, [MARKETING_ACTIONS_FIELD]: updated } as WithMarketingActions<T>;
}

/**
 * Consumer-facing normalization: return a copy of a report/run envelope whose
 * `marketingActions` is guaranteed to be an explicit, validated array in the
 * source's canonical order — empty for legacy data that carries none.
 *
 * This is what read paths hand to the portal and to scheduled notifications,
 * so every consumer sees the same ids in the same order without parsing,
 * re-ranking, or regenerating anything. Idempotent.
 */
export function normalizeMarketingActions<T extends object>(envelope: T): WithMarketingActions<T> {
  return {
    ...envelope,
    [MARKETING_ACTIONS_FIELD]: readMarketingActions(envelope),
  } as WithMarketingActions<T>;
}
