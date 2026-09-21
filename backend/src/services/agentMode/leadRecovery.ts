/**
 * Cross-list lead recovery for `get_lead_details` (ENG-969 follow-up).
 *
 * Extracted out of `getLeadDetails()` in agentModeService.ts per this repo's
 * subtraction-biased AgentMode-restructure policy: new pure(ish) business
 * logic belongs in `services/agentMode/*.ts`, not inline in the monolith
 * (CodeRabbit finding on PR #2611).
 *
 * Why this exists: production session 6082779b-f9f1-4e38-a8eb-34abbc3da419
 * showed an agent pair a valid lead_id with a stale list_id from an earlier
 * step in the same run. leadId is minted once, globally (Date.now() + a
 * random suffix — see createLead), never re-derived per list, so it never
 * legitimately belongs to two lists at once — a not-found on the requested
 * list is as likely to mean "wrong list_id" as "no such lead".
 *
 * Tiered on purpose: try the caller's OWN lists first — one cheap query, no
 * fan-out — since the production case this fixes was always a same-user list
 * mixup. Only fall back to the full org-wide `getLeadListsForUser` (which
 * queries once per org member) when the lead isn't among the caller's own
 * lists.
 *
 * AW-LeadLists runs on fixed provisioned capacity in production, so this
 * best-effort recovery must never make a caller worse off than before it
 * existed. The AWS SDK already retries an individual throttled DynamoDB call
 * a few times internally — a throw reaching here means that already failed,
 * so blindly retrying again immediately would just pile more load onto an
 * already-contended table. Instead: wait past a likely short burst, retry the
 * WHOLE recovery exactly once, and if that also fails, give up — the caller
 * falls through to its ordinary not-found response, unchanged from pre-fix
 * behavior, never a new or amplified failure mode.
 */

const RETRY_DELAY_MS = 300;

export interface LeadRecoveryDb {
  getLeadListsByUserId(userId: string): Promise<Array<{ listId: string }>>;
  getLeadListsForUser(userId: string): Promise<Array<{ listId: string }>>;
  getLeadByIdAcrossLists(candidateListIds: string[], leadId: string): Promise<any | null>;
}

async function attemptLeadRecovery(
  db: LeadRecoveryDb,
  userId: string,
  requestedListId: string,
  leadId: string,
): Promise<any | null> {
  const ownLists = await db.getLeadListsByUserId(userId);
  const ownListIds = ownLists
    .map((ownList) => ownList.listId)
    .filter((ownListId) => ownListId && ownListId !== requestedListId);
  const foundInOwnLists = await db.getLeadByIdAcrossLists(ownListIds, leadId);
  if (foundInOwnLists) return foundInOwnLists;

  // Set for O(1) membership instead of .includes() inside .filter() (O(n) per
  // check) — matters once an org has enough lists for this to add up.
  const ownListIdSet = new Set(ownListIds);
  const accessibleLists = await db.getLeadListsForUser(userId);
  const otherListIds = accessibleLists
    .map((otherList) => otherList.listId)
    .filter((otherListId) => otherListId && otherListId !== requestedListId && !ownListIdSet.has(otherListId));
  return db.getLeadByIdAcrossLists(otherListIds, leadId);
}

/**
 * Recovers a lead when the caller paired a valid lead_id with a stale/wrong
 * list_id. Only searches lists this user already has access to (via
 * `getLeadListsByUserId`/`getLeadListsForUser`), so this can't leak a lead
 * the caller couldn't otherwise see. Returns the recovered lead record, or
 * `null` if it genuinely isn't in any accessible list (or the recovery
 * lookup itself fails twice).
 */
export async function recoverLeadFromWrongList(
  db: LeadRecoveryDb,
  userId: string,
  requestedListId: string,
  leadId: string,
): Promise<any | null> {
  try {
    try {
      return await attemptLeadRecovery(db, userId, requestedListId, leadId);
    } catch (firstError) {
      console.warn(
        `ENG-969 lead recovery: first attempt failed for lead_id="${leadId}" requested list_id="${requestedListId}", retrying once`,
        firstError,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return await attemptLeadRecovery(db, userId, requestedListId, leadId);
    }
  } catch (secondError) {
    console.warn(
      `ENG-969 lead recovery: gave up for lead_id="${leadId}" requested list_id="${requestedListId}" after retry`,
      secondError,
    );
    return null;
  }
}
