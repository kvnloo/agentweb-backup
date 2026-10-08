/**
 * Per-charge itemization events for months the spend ledger fully covers (ENG-1250 AC7).
 *
 * `/usage/itemized` used to take its exact per-charge lines from `AW-LlmChargeEvents`, an audit table
 * written alongside the legacy `AW-Users.tokenUsage` counter. That counter is being retired, and the
 * charge events stop with it, so for months the ledger covers the same lines come from the ledger's
 * settled LLM spend events instead, adapted into the shape `reconcileItemizedUsage` already consumes.
 * The reconciler is deliberately untouched: it nets these events against the per-day aggregate rows,
 * and that logic carries a long history of billing-accuracy fixes.
 *
 * The adapter was checked against production data for Sept 14-30 (both stores exist then): for the
 * events present in both, cost, tokens and call count agree per (acting user, day, model, feature).
 * The only gaps were the pre-#3218 org-member events stamped with the member rather than the owner.
 */
import type { LlmChargeAuditEvent } from "./llmChargeAuditDb";
import { listLlmChargeEvents } from "./llmChargeAuditDb";
import { listSpendEventsBounded, type SpendEvent } from "./spendEventDb";
import { isLlmSpendEvent, LLM_GENERATION_UNIT, LLM_SPEND_LEDGER_STARTED_ON } from "./spendLedgerDualWrite";

/** A month strictly after the one the LLM ledger started in is fully covered by it. */
export function isLedgerCoveredMonth(month: string): boolean {
  return month > LLM_SPEND_LEDGER_STARTED_ON.slice(0, 7);
}

const LEDGER_ITEMIZATION_MAX_EVENTS = 50_000;

export function spendEventsToChargeEvents(events: readonly SpendEvent[]): LlmChargeAuditEvent[] {
  return events
    .filter((e) => e.lifecycle === "settled" && isLlmSpendEvent(e))
    .map((e) => {
      const perGeneration = e.unit === LLM_GENERATION_UNIT;
      return {
        billingUserId: e.billingUserId,
        eventId: e.eventId,
        occurredAt: e.occurredAt,
        actingUserId: e.actingUserId,
        // A per-generation event has no token count; its quantity is how many generations it covers.
        tokens: perGeneration ? 0 : Math.max(0, e.quantity || 0),
        costMicroUsd: Math.max(0, e.costMicroUsd || 0),
        model: e.operation,
        provider: e.provider,
        feature: e.feature,
        sessionId: e.references?.sessionId,
        counterAppliedAt: e.occurredAt,
        calls: perGeneration ? Math.max(1, e.quantity || 1) : 1,
      };
    });
}

/**
 * The per-charge events for one billing subject and month, from the right store. A ledger month whose
 * event count exceeds the read budget degrades to NO per-charge events (the reconciler then reports the
 * daily aggregate, which is honest about its precision) rather than failing the request or truncating.
 */
export async function readItemizationChargeEvents(billingUserId: string, month: string): Promise<LlmChargeAuditEvent[]> {
  const start = `${month}-01`;
  const end = `${month}-31`;
  if (!isLedgerCoveredMonth(month)) return listLlmChargeEvents(billingUserId, start, end);

  const read = await listSpendEventsBounded(billingUserId, start, end, LEDGER_ITEMIZATION_MAX_EVENTS);
  if (read.exceeded) {
    console.warn(
      `[itemized] ledger for ${billingUserId} ${month} exceeds ${LEDGER_ITEMIZATION_MAX_EVENTS} events; ` +
        `reporting the daily aggregate only`,
    );
    return [];
  }
  return spendEventsToChargeEvents(read.events);
}
