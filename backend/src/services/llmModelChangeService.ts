/**
 * ENG-1217 AC6/AC9 — apply and undo a customer-confirmed model switch.
 *
 * This is the ONLY path in the runway feature that writes a model, so it carries
 * the weight of ENG-1200. We removed automatic switching because customers were
 * silently downgraded and their work got worse; everything here exists to stop
 * that returning through a different door.
 *
 * Four rules, each earning its place:
 *
 * **Owner-only, reported as not-found.** Mirrors the existing schedule update
 * check exactly. "Forbidden" would confirm the id exists, turning this into an
 * enumeration oracle for other tenants' schedule ids.
 *
 * **Only a recommended model.** The target must be in the admin-configured
 * recommendation catalog AND invocable by this account. This endpoint applies a
 * recommendation; accepting any supported model would quietly make it a general
 * model-setter that happens to write an audit row — a different, riskier API
 * than the one anyone reviewed.
 *
 * **No change without an audit record.** If the audit write fails, the model is
 * put back. AC9 says a confirmed change is auditable, and a change we cannot
 * explain or undo is worse than one that never happened.
 *
 * **Idempotent.** A double-click must not write two audit rows claiming two
 * switches, nor leave an undo target whose "before" is already the "after".
 */

import { randomUUID } from "crypto";
import { scheduleDb } from "./db";
import { getEffectiveLlmUsagePolicy } from "./llmUsagePolicyResolverService";
import { agentModeService } from "./agentModeService";
import {
  recordModelChange,
  listModelChanges,
  markModelChangeUndone,
  type ModelChangeScope,
} from "./llmModelChangeAuditDb";
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";

export class ModelChangeNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "ModelChangeNotFoundError";
  }
}

export class ModelNotAvailableError extends Error {
  constructor(message = "That model is not available for this change") {
    super(message);
    this.name = "ModelNotAvailableError";
  }
}

/**
 * The schedule moved between reading its model and writing the new one, and it
 * did NOT move to the model being confirmed.
 *
 * Distinct from a double-click, which resolves to a plain no-op: this is two
 * different intentions racing, and the loser's choice must not be written over
 * the winner's. Silently proceeding would leave the customer on a model nobody
 * selected last, with an audit row asserting otherwise.
 */
export class ModelChangeConflictError extends Error {
  constructor(message = "That schedule was changed a moment ago. Reload and try again.") {
    super(message);
    this.name = "ModelChangeConflictError";
  }
}

/** Both spellings: the v2 SDK sets `code`, wrapped/rethrown errors keep `name`. */
function isConditionalCheckFailure(error: unknown): boolean {
  const err = error as { code?: string; name?: string } | null | undefined;
  return (
    err?.code === "ConditionalCheckFailedException" ||
    err?.name === "ConditionalCheckFailedException"
  );
}

export interface ApplyModelChangeInput {
  scope: ModelChangeScope;
  scopeId: string;
  toModel: string;
  /** What the customer was shown when they agreed — recorded, never recomputed. */
  estimatedDaysRecovered?: number | null;
  confidence?: string | null;
}

export interface ApplyModelChangeResult {
  applied: boolean;
  /** The handle to undo with. Null when nothing was applied. */
  changeId: string | null;
  /** Null when the work INHERITED the platform default rather than pinning one. */
  modelBefore: string | null;
  modelAfter: string;
  /** True when this pinned a model onto work that had been inheriting. */
  pinnedFromInherited: boolean;
}

/**
 * The models this account may switch TO.
 *
 * Intersection, not union: `optimizedModelIds` is the admin-configured
 * recommendation catalog, and `getSupportedModels` is what this account can
 * actually invoke. A catalog entry the account cannot call would break the
 * schedule outright — a worse outcome than the overspending we are trying to
 * fix — and a supported model outside the catalog is one nobody approved for
 * recommendation.
 */
async function resolveSwitchableModels(userId: string): Promise<{
  billingUserId: string;
  catalog: Set<string>;
}> {
  const usage = await getEffectiveLlmUsagePolicy(userId);
  const supported = new Set<string>(
    typeof agentModeService.getSupportedModels === "function"
      ? await agentModeService.getSupportedModels(false)
      : [],
  );
  const catalog = new Set(
    (usage.policy?.optimizedModelIds || []).filter((m: string) => supported.has(m)),
  );
  return { billingUserId: usage.billingUserId, catalog };
}

/**
 * Arguments that put a schedule's model back to exactly what it was.
 *
 * NULL means the schedule INHERITED the platform default rather than pinning a
 * model, and restoring that means REMOVING the attribute — not writing a blank
 * and not writing today's resolved default. The distinction is load-bearing: an
 * absent `llmModel` follows the default as it moves, while any stored value stops
 * following it, so writing one would leave the account in a third state nobody
 * asked for.
 *
 * Removal is requested explicitly. Passing `{ llmModel: undefined }` looks like it
 * ought to work and does not: `Object.entries` still yields the key, so it emitted
 * `SET #llmModel = :llmModel` while the marshaller dropped the value, and DynamoDB
 * rejected the whole write. That failed for the majority of real schedules — 66 of
 * 91 active ones inherit — and it failed AFTER the audit row was stamped undone,
 * leaving the trail claiming a revert that had not happened.
 */
function restoreModelArgs(
  scheduleId: string,
  modelBefore: string | null,
  /**
   * The model the schedule must STILL be on for this restore to be safe — the one
   * the change being reverted installed. Without it a restore reinstates a stale
   * value over whatever the customer picked since, reverting a deliberate choice
   * while the audit trail records only an undo.
   */
  expectedCurrentModel?: string,
): [
  string,
  Record<string, unknown>,
  Record<string, unknown> | undefined,
  undefined,
  string[] | undefined,
] {
  const expect = expectedCurrentModel ? { llmModel: expectedCurrentModel } : undefined;
  return modelBefore === null
    ? [scheduleId, {}, expect, undefined, ['llmModel']]
    : [scheduleId, { llmModel: modelBefore }, expect, undefined, undefined];
}

/** Load a scope the caller owns, or throw not-found. */
async function loadOwnedSchedule(userId: string, scheduleId: string) {
  const schedule = await scheduleDb.getScheduleById(scheduleId);
  // Owner-only, exactly as `updateScheduledChat` does. No org bypass: an org
  // member does not get to retune a colleague's schedule because they share a
  // bill.
  if (!schedule || schedule.userId !== userId) {
    throw new ModelChangeNotFoundError("Scheduled chat not found");
  }
  return schedule;
}

export async function applyModelChange(
  userId: string,
  input: ApplyModelChangeInput,
): Promise<ApplyModelChangeResult> {
  if (input.scope !== "schedule") {
    // Session scope is deliberately not wired yet: a session's model is chosen
    // per turn, so "changing" one has no persistent meaning to undo.
    throw new ModelNotAvailableError("Only scheduled work can be switched right now");
  }

  const schedule = await loadOwnedSchedule(userId, input.scopeId);
  const { billingUserId, catalog } = await resolveSwitchableModels(userId);

  if (!catalog.has(input.toModel)) {
    throw new ModelNotAvailableError("That model is not available for this change");
  }

  // NULL means the schedule inherited the platform default rather than pinning a
  // model. That is the common case — 66 of 91 active production schedules carry
  // no `llmModel` at all — and it is a different state from "pinned to X", not a
  // missing value. Switching such a schedule PINS one for the first time, and the
  // undo has to restore inheritance rather than write back whatever the default
  // happened to be, because the default can move afterwards and inheritance
  // follows it while a pinned copy does not.
  const modelBefore: string | null = schedule.llmModel || null;
  if (modelBefore === input.toModel) {
    // Already there. Reporting success without writing keeps a double-click from
    // manufacturing history that says the model changed when it did not.
    return {
      applied: false,
      changeId: null,
      modelBefore,
      modelAfter: input.toModel,
      pinnedFromInherited: false,
    };
  }

  // Bind the write to the state the decision was read from. The guard above is
  // otherwise a read-then-write across three awaits: two confirms arriving before
  // either write lands BOTH see the old model, both pass the guard, and both
  // record an audit row claiming a switch. The schedule survives that (the writes
  // agree) but the trail does not, and the customer's Undo can only stamp the one
  // change id the UI holds — leaving the duplicate permanently un-undone,
  // asserting a switch that was already reverted.
  //
  // `undefined` here means "still absent", which is the condition for a schedule
  // that was INHERITING — a different assertion from "still equals X", and the
  // majority case.
  try {
    await scheduleDb.updateSchedule(
      input.scopeId,
      { llmModel: input.toModel },
      { llmModel: modelBefore ?? undefined },
    );
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error;
    // It moved. WHY decides the answer, so re-read rather than assume: another
    // confirm of the SAME model is the idempotent double-click, and anything else
    // is a genuine conflict.
    const current = await loadOwnedSchedule(userId, input.scopeId);
    if ((current.llmModel || null) === input.toModel) {
      return {
        applied: false,
        changeId: null,
        modelBefore,
        modelAfter: input.toModel,
        pinnedFromInherited: false,
      };
    }
    throw new ModelChangeConflictError();
  }

  const changedAt = new Date().toISOString();
  let changeId: string;
  try {
    changeId = await recordModelChange({
      billingUserId,
      changeId: randomUUID(),
      changedAt,
      scope: "schedule",
      scopeId: input.scopeId,
      scopeLabel: schedule.scheduleName ?? null,
      modelBefore,
      modelAfter: input.toModel,
      estimatedDaysRecoveredAtDecision: input.estimatedDaysRecovered ?? null,
      confidenceAtDecision: input.confidence ?? null,
      confirmedByUserId: userId,
      undoneAt: null,
    });
  } catch (error) {
    // Compensate. An unaudited change cannot be explained or undone through the
    // UI, so the customer is better served by the switch simply not happening.
    await scheduleDb
      .updateSchedule(...restoreModelArgs(input.scopeId, modelBefore, input.toModel))
      .catch((revertError: unknown) => {
        // A failed CONDITION is not a failed revert: it means our unaudited write
        // was already replaced by someone else's deliberate one, which is the
        // outcome the compensation wanted. Overwriting that with `modelBefore`
        // would clobber a real choice to undo a write that no longer exists.
        if (isConditionalCheckFailure(revertError)) return;
        // Both writes failed. Say so loudly — the schedule is now on a model the
        // customer chose but we have no record of, and only a human can
        // reconcile that.
        console.error(
          `[modelChange] UNAUDITED CHANGE on schedule ${input.scopeId}: audit write failed and revert failed`,
          revertError,
        );
      });
    throw error;
  }

  await recordUsageTelemetry(billingUserId, USAGE_TELEMETRY_EVENTS.changeApplied, {
    scope: "schedule",
    scopeId: input.scopeId,
    fromModel: modelBefore,
    toModel: input.toModel,
    estimatedDaysRecoveredAtDecision: input.estimatedDaysRecovered ?? null,
    confidenceAtDecision: input.confidence ?? null,
  });

  return {
    applied: true,
    changeId,
    modelBefore,
    modelAfter: input.toModel,
    pinnedFromInherited: modelBefore === null,
  };
}

export interface UndoModelChangeResult {
  undone: boolean;
  restoredModel: string | null;
}

/**
 * Put a change back.
 *
 * The audit stamp is the lock, and it is taken BEFORE the model is rewritten. If
 * it reports the change was already undone, the model is left alone: the
 * customer may have chosen something newer since, and a second restore would
 * silently overwrite that choice with a stale value.
 */
export async function undoModelChange(
  userId: string,
  changeId: string,
): Promise<UndoModelChangeResult> {
  const usage = await getEffectiveLlmUsagePolicy(userId);
  const billingUserId = usage.billingUserId;

  // The sort key leads with the timestamp, so the day it happened bounds the
  // lookup without needing an index.
  const day = changeId.slice(0, 10);
  const changes = await listModelChanges(billingUserId, day, day);
  const change = changes.find(
    (c) => `${c.changedAt}#${c.changeId}` === changeId || c.changeId === changeId,
  );
  if (!change) throw new ModelChangeNotFoundError("Change not found");

  if (change.scope !== "schedule") {
    throw new ModelChangeNotFoundError("Change not found");
  }
  // Re-check ownership at undo time rather than trusting the record: the scope
  // may have changed hands, and the audit row is evidence of the past, not a
  // capability for the present.
  await loadOwnedSchedule(userId, change.scopeId);

  // Already undone: answer from the record and touch nothing. With the restore
  // moved first, omitting this would send an already-undone change into the
  // conditional write, where a schedule since moved elsewhere reads as a conflict
  // -- turning the benign "you already did this" into an error the customer has to
  // interpret. The stamp below remains the authority against a genuine race; this
  // is the cheap, correct answer for the settled case.
  if (change.undoneAt) return { undone: false, restoredModel: null };

  // RESTORE FIRST, STAMP SECOND. The stamp is still the lock against a double
  // undo, but taking it first meant a failed restore left the audit asserting a
  // revert that never happened -- and unrepairable, because the retry hits
  // `attribute_not_exists(undoneAt)`, reports "already undone", and declines to
  // touch the schedule. The customer is then told the switch is reverted while it
  // is not, with no path back.
  //
  // Inverted, both failure directions stay safe. A failed restore stamps nothing,
  // so the undo is still offered and still true. A restore that lands before a
  // failed stamp leaves the schedule already correct, and the retry below detects
  // that and finishes the stamp.
  try {
    await scheduleDb.updateSchedule(
      ...restoreModelArgs(change.scopeId, change.modelBefore, change.modelAfter),
    );
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error;
    // The schedule is not on the model this change installed. Either a previous
    // attempt already restored it -- finish the stamp -- or the customer has moved
    // on since, in which case reinstating `modelBefore` would revert a choice they
    // made deliberately.
    const current = await loadOwnedSchedule(userId, change.scopeId);
    if ((current.llmModel || null) !== change.modelBefore) {
      throw new ModelChangeConflictError(
        "That schedule has changed since, so this switch can no longer be undone.",
      );
    }
  }

  const stamped = await markModelChangeUndone(billingUserId, changeId, userId);
  if (!stamped) return { undone: false, restoredModel: null };

  await recordUsageTelemetry(billingUserId, USAGE_TELEMETRY_EVENTS.changeUndone, {
    scope: change.scope,
    scopeId: change.scopeId,
    fromModel: change.modelAfter,
    toModel: change.modelBefore,
  });

  return { undone: true, restoredModel: change.modelBefore };
}
