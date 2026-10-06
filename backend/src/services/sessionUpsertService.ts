import { crmDb } from './db';
import { buildSessionMergePlan } from '../utils/sessionMergePlan';
import { sessionLeadId, SESSION_JOURNEY_COUNTER_KEY, type SessionIdentity } from '../utils/sessionList';

/**
 * ENG-2312 / ENG-2315: the ONE exactly-once upsert of a landing-page visitor session into a
 * session list. Extracted unchanged from forward-lead's session branch so that forward-lead and
 * the public tracker ingest (POST /api/track/event) cannot drift: both create the same
 * deterministic row and merge into it the same way.
 *
 * CREATE: a conditional put on a deterministic leadId (`attribute_not_exists(leadId)`, via
 * failIfExists). N concurrent events for one session all target the same primary key, so
 * DynamoDB — not a GSI read — picks exactly one creator. Only the creator runs createLead's
 * create-time work (leadCount ADD, fieldNames); a loser throws leadAlreadyExists BEFORE any of
 * it, so the count cannot double. skipEmailDuplicateCheck drops createLead's own email-index
 * pre-check: it is the eventually-consistent read this path exists to avoid, and it throws a
 * plain Error that would turn a lost race into a 500.
 *
 * MERGE (loser, or any later event): per-key atomic SETs, no read-modify-write — see
 * crmDb.mergeSessionLeadEvent for the guarantees.
 *
 * The caller has already decided that `listId` is a session list (read from the DB, never from
 * a body) and owns every side effect AFTER the row is written; this function writes the row only.
 */
export async function upsertSessionLead(input: {
  listId: string;
  identity: SessionIdentity;
  /** The lead as createLead takes it; `leadData.customFields` must be `customFields` below. */
  leadData: Record<string, any>;
  /** The merged custom fields (same object as leadData.customFields). */
  customFields: Record<string, any>;
  callerSuppliedSource: boolean;
  touch?: any;
}): Promise<{ lead: any; isNew: boolean; isUpdated: boolean; leadId: string }> {
  const { listId, identity, leadData, customFields, callerSuppliedSource, touch } = input;

  // The monotonic journey guard compares numerically (a string never compares <= a number in
  // DynamoDB), so a counter an LP sent as "5" is stored as 5. Mutates in place on purpose:
  // leadData.customFields is this same object, so the created row carries the number too.
  const ctr = customFields[SESSION_JOURNEY_COUNTER_KEY];
  if (typeof ctr === 'string' && /^\d{1,15}$/.test(ctr)) customFields[SESSION_JOURNEY_COUNTER_KEY] = Number(ctr);

  let lead: any;
  let isNew = false;
  let isUpdated = false;
  const leadId = sessionLeadId(listId, identity);
  for (let attempt = 0; attempt < 2 && !lead; attempt++) {
    try {
      lead = await crmDb.createLead(listId, {
        ...leadData,
        leadId,
        failIfExists: true,
        skipEmailDuplicateCheck: true,
        suppressSideEffects: true,
      });
      isNew = true;
    } catch (createErr: any) {
      if (!createErr?.leadAlreadyExists) throw createErr;

      const plan = buildSessionMergePlan({
        leadData, incomingCustomFields: customFields, callerSuppliedSource, touch,
      });
      const merged = await crmDb.mergeSessionLeadEvent(listId, leadId, plan);
      // Row vanished between the failed create and the merge (owner deleted it): loop once
      // and the conditional create now succeeds. Without the retry that event is dropped.
      if (!merged.exists) continue;
      isUpdated = merged.changed;
      lead = { ...leadData, leadId, listId };
    }
  }
  if (!lead) throw new Error(`Failed to upsert session lead ${leadId}`);
  return { lead, isNew, isUpdated, leadId };
}
