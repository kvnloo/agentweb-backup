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
import { scheduleDb, EXPECT_UNSET } from "./db";
import { contentAuthorityOver } from "./orgContentAuthority";
import { getEffectiveLlmUsagePolicy } from "./llmUsagePolicyResolverService";
import { agentModeService } from "./agentModeService";
import {
  recordModelChange,
  listModelChanges,
  markModelChangeUndone,
  type ModelChangeScope,
} from "./llmModelChangeAuditDb";
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";
import { modelAccess, systemModelCheck } from "./agentMode/modelAccessInstance";

export class ModelChangeNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "ModelChangeNotFoundError";
  }
}

/**
 * The scope exists and the caller may not change it (ENG-1528).
 *
 * Separate from `ModelChangeNotFoundError` because they need different words
 * and different statuses. "Not found" told an org owner, looking at a row on
 * their own billing page, that the thing in front of them did not exist —
 * unactionable and untrue. This says what actually happened.
 */
export class ModelChangeForbiddenError extends Error {
  constructor(message = "You cannot change that scheduled chat") {
    super(message);
    this.name = "ModelChangeForbiddenError";
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
  /** ENG-669: the origin the change replaced ('system' = an admin-template pin); restored with the model. */
  modelSourceBefore: 'system' | undefined,
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
  if (modelSourceBefore === 'system') {
    // The apply recorded the switch as the owner's ('user'); put the admin-template origin back with the model.
    return modelBefore === null
      ? [scheduleId, {}, expect, undefined, ['llmModel', 'llmModelSource']]
      : [scheduleId, { llmModel: modelBefore, llmModelSource: 'system' }, expect, undefined, undefined];
  }
  return modelBefore === null
    ? [scheduleId, {}, expect, undefined, ['llmModel']]
    : [scheduleId, { llmModel: modelBefore }, expect, undefined, undefined];
}

/**
 * Load a schedule the caller is allowed to switch, or throw.
 *
 * ENG-1528. This was a bare `schedule.userId !== userId`, described as
 * "owner-only, no org bypass: an org member does not get to retune a
 * colleague's schedule because they share a bill."
 *
 * That reasoning is right about a MEMBER and wrong about an owner or admin,
 * and `orgAuthz` already draws exactly that line:
 *
 *   `org:content:manage` — "Edit or delete another member's items as an
 *                           org-level override."  (owner + admin; not member)
 *
 * The list this write serves is billing-scoped: `usage-drivers` pools schedules
 * across every org member (`resolvePooledLedgerUserIds`), so an org owner is
 * shown colleagues' spend, told it is theirs to reduce, and was then refused
 * with a 404 on every one of those rows — an authority the org model already
 * granted them. Measured on production: 8 of 10 schedules offered to the
 * `AgentWeb` org owner were a colleague's, and all 8 failed.
 *
 * So the check now asks the authority model instead of comparing ids. Nothing
 * is widened for a plain member: `ROLE_PERMISSIONS.member` is empty, so they
 * are refused exactly as before.
 */
async function loadSwitchableSchedule(userId: string, scheduleId: string) {
  const schedule = await scheduleDb.getScheduleById(scheduleId);
  if (!schedule) {
    throw new ModelChangeNotFoundError("Scheduled chat not found");
  }

  // ENG-1533: the same predicate the drivers resolver uses to decide whether to
  // OFFER this switch. Shared rather than reimplemented — a UI that offers a
  // button exactly when the write will refuse it is the defect, and two copies
  // of this rule would drift apart on the first change to the role model.
  const { permitted, sameOrg } = await contentAuthorityOver(userId, schedule.userId);
  if (permitted) return schedule;

  // Only a SAME-ORG caller is told the truth. The original 404 was deliberate
  // anti-enumeration — "reports 'not found' rather than 'forbidden' so the
  // endpoint cannot be used to discover which schedule ids exist" — and that
  // protection must survive this change. A blanket 403 would turn the endpoint
  // into an existence oracle for any UUID, across tenants.
  //
  // Inside the caller's own org it discloses nothing new: the schedule is
  // already listed on their billing page, id and all. Outside it, they learn
  // nothing they did not already have.
  if (sameOrg) {
    throw new ModelChangeForbiddenError(
      "That scheduled chat belongs to another member, and only they can change its model",
    );
  }

  throw new ModelChangeNotFoundError("Scheduled chat not found");
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

  const schedule = await loadSwitchableSchedule(userId, input.scopeId);
  const { billingUserId, catalog } = await resolveSwitchableModels(userId);

  if (!catalog.has(input.toModel)) {
    throw new ModelNotAvailableError("That model is not available for this change");
  }
  // ENG-669: the schedule runs under its OWNER's plan, so a recommendation outside that plan
  // would only make the next run fail. Throws the standard ModelUnavailableError (`not_in_plan`),
  // which the route answers with the shared 422 body. Switch off => no read, unchanged.
  await modelAccess.assertModelAllowed({
    ownerUserId: schedule.userId,
    requestedModel: input.toModel,
    canonicalModel: input.toModel,
    isSystemModel: systemModelCheck(null),
  });

  // NULL means the schedule inherited the platform default rather than pinning a
  // model. That is the common case — 66 of 91 active production schedules carry
  // no `llmModel` at all — and it is a different state from "pinned to X", not a
  // missing value. Switching such a schedule PINS one for the first time, and the
  // undo has to restore inheritance rather than write back whatever the default
  // happened to be, because the default can move afterwards and inheritance
  // follows it while a pinned copy does not.
  const modelBefore: string | null = schedule.llmModel || null;
  // ENG-669: an admin-template pin's origin; the switch below records the owner's choice, so an undo must restore it.
  const modelSourceBefore: 'system' | undefined = schedule.llmModelSource === 'system' ? 'system' : undefined;
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
      // ENG-669: the confirmed switch is the owner's choice, so an inherited admin-template origin no longer applies.
      { llmModel: input.toModel, ...(schedule.llmModelSource === 'system' && { llmModelSource: 'user' as const }) },
      // ENG-1363: `EXPECT_UNSET`, not `undefined`. Inheriting is stored two ways —
      // the attribute absent, or holding `""` — and `undefined` asserts only the
      // first. The 48 active schedules spelling it the second way failed this
      // condition on every attempt, which the catch below could only read as a
      // conflict, so the switch 409'd permanently on the majority of schedules.
      { llmModel: modelBefore ?? EXPECT_UNSET },
    );
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error;
    // It moved. WHY decides the answer, so re-read rather than assume: another
    // confirm of the SAME model is the idempotent double-click, and anything else
    // is a genuine conflict.
    const current = await loadSwitchableSchedule(userId, input.scopeId);
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
      ...(modelSourceBefore && { modelSourceBefore }),
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
      .updateSchedule(...restoreModelArgs(input.scopeId, modelBefore, modelSourceBefore, input.toModel))
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
  await loadSwitchableSchedule(userId, change.scopeId);

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
      ...restoreModelArgs(change.scopeId, change.modelBefore, change.modelSourceBefore, change.modelAfter),
    );
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error;
    // The schedule is not on the model this change installed. Either a previous
    // attempt already restored it -- finish the stamp -- or the customer has moved
    // on since, in which case reinstating `modelBefore` would revert a choice they
    // made deliberately.
    const current = await loadSwitchableSchedule(userId, change.scopeId);
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
