import { crmDb, orgDb } from '../db';
import { hotLeadCallConfigOf } from '../hotLeadCallConfig';
import { processHotLeadCallRetry } from '../hotLeadCallService';
import { errorName } from './callFinalisation';
import { isHotLeadCallEnabled } from './hotLeadCallMode';
import { hotLeadCallOrgListIds } from './hotLeadCallOrgLists';
import { retrySweepEnabled } from './hotLeadCallRetry';

/**
 * The due-retries sweep (ENG-2783): the delay mechanism of the press-2 retry. The job queue cannot run a job later, so this
 * runs every five minutes (cron/hotLeadCallRetryCron.ts) and places the lead's one retry once its `deferral.dueAt` has
 * passed. It does nothing and reads nothing while the global kill switch is off, and reads no member or list until at least one
 * org with calling enabled exists. Discovery is the stuck sweep's: orgs -> members -> lists -> the newest leads of each list
 * (the deferred records are recent), filtered by the database on the record having a deferral and no claim. The retry itself,
 * and the claim that makes it happen once under any number of overlapping runs or instances, are in
 * hotLeadCallService.processHotLeadCallRetry.
 */

const TAG = '[hotLeadCall]';

export { retrySweepEnabled };

/** Per-list ceiling of leads read, and the run's whole read budget, shared out evenly over the lists (see `perListBudget`). */
const MAX_LEADS_READ_PER_LIST = 500;
const MIN_LEADS_READ_PER_LIST = 50;
const MAX_LEADS_READ_PER_RUN = 2_000;
/** Retries one run may start (each rings a member): the rest wait for the next run. */
const MAX_RETRIES_PER_RUN = 20;
/** Due records one run handles; a record that is not due yet costs one read but does not count. */
const MAX_RECORDS_HANDLED_PER_RUN = 100;
const SYSTEM_KEY = 'hot_lead_call';

/** What one list may read: an even share of the run's budget, never above 500 nor below 50 leads. */
export const perListBudget = (lists: number): number =>
  Math.min(MAX_LEADS_READ_PER_LIST, Math.max(MIN_LEADS_READ_PER_LIST, Math.floor(MAX_LEADS_READ_PER_RUN / Math.max(1, lists))));

// Where the next run starts reading lists, so that when the budget cannot cover every list no list is starved for good.
let rotation = 0;
/** Test-only: restart the rotation. */
export function resetRetrySweepRotationForTests(): void { rotation = 0; }

export interface RetrySweepSummary {
  /** HOT_LEAD_CALL_RETRY is not off. */
  enabled: boolean;
  /** The global kill switch is on; false means the run did nothing. */
  killSwitchOn: boolean;
  orgs: number;
  lists: number;
  /** Lists the run could not read because the run's read budget was spent (the next run starts where this one stopped). */
  skippedLists: number;
  leadsRead: number;
  /** A read bound or the per-run cap left records for a later run (also true on any large list: not a signal by itself). */
  truncated: boolean;
  /** Records with a deferral and no claim found by the read. */
  found: number;
  notDue: number;
  /** Moved to the next open minute because the lead or org window was closed when the run came (not claimed). */
  rescheduled: number;
  /** Retries started (claim won; a gate, cap or cooldown may still have refused, as a call.skipped on the lead). */
  attempted: number;
  refused: number;
  expired: number;
  /** Another run or instance holds the claim, or the record changed since the read. */
  lost: number;
  failed: number;
}

interface Candidate { listId: string; leadId: string }

async function findCandidates(now: Date, summary: RetrySweepSummary): Promise<Candidate[]> {
  const lists: string[] = [];
  for (const orgId of await orgDb.listHotLeadCallOrgIds()) {
    summary.orgs++;
    try {
      const org = await orgDb.getOrgById(orgId);
      if (hotLeadCallConfigOf(org?.hotLeadCall)?.enabled) lists.push(...await hotLeadCallOrgListIds(orgId));
    } catch (err) {
      summary.failed++;
      console.error(`${TAG} retry sweep could not read org ${orgId}:`, errorName(err));
    }
  }
  const found: Candidate[] = [];
  const updatedBefore = new Date(now.getTime() + 60_000).toISOString(); // every record, whatever its age
  const perList = perListBudget(lists.length);
  const start = lists.length ? rotation % lists.length : 0;
  let read = 0;
  for (let i = 0; i < lists.length; i++) {
    const listId = lists[(start + i) % lists.length];
    const budget = Math.min(perList, MAX_LEADS_READ_PER_RUN - summary.leadsRead);
    if (budget <= 0) {
      summary.skippedLists = lists.length - i;
      summary.truncated = true;
      break;
    }
    read++;
    try {
      const result = await crmDb.findLeadsBySystemRecord(listId, SYSTEM_KEY, {
        states: ['finished'], updatedBefore, maxRead: budget, has: ['deferral'], lacks: ['retryClaimToken'],
      });
      summary.leadsRead += result.read;
      summary.truncated ||= result.truncated;
      found.push(...result.leadIds.map((leadId) => ({ listId, leadId })));
    } catch (err) {
      summary.failed++;
      console.error(`${TAG} retry sweep could not read a list:`, errorName(err));
    }
  }
  summary.lists = read;
  rotation += Math.max(1, read);
  if (summary.skippedLists > 0) console.warn(`${TAG} retry sweep skipped lists for budget ${summary.skippedLists}`);
  return found;
}

/** One pass. Never throws for a record's or an org's failure; counts only, no ids and no numbers, in the summary. */
export async function runHotLeadCallRetrySweep(now: Date = new Date()): Promise<RetrySweepSummary> {
  const summary: RetrySweepSummary = {
    enabled: retrySweepEnabled(), killSwitchOn: false, orgs: 0, lists: 0, skippedLists: 0, leadsRead: 0, truncated: false,
    found: 0, notDue: 0, rescheduled: 0, attempted: 0, refused: 0, expired: 0, lost: 0, failed: 0,
  };
  if (!summary.enabled) return summary;
  summary.killSwitchOn = await isHotLeadCallEnabled();
  if (!summary.killSwitchOn) return summary;

  const candidates = await findCandidates(now, summary).catch((err) => {
    summary.failed++;
    console.error(`${TAG} retry sweep could not list the orgs:`, errorName(err));
    return [];
  });
  summary.found = candidates.length;
  let handled = 0;
  for (const c of candidates) {
    if (summary.attempted >= MAX_RETRIES_PER_RUN || handled >= MAX_RECORDS_HANDLED_PER_RUN) {
      summary.truncated = true;
      break;
    }
    try {
      const outcome = await processHotLeadCallRetry(c.listId, c.leadId, now);
      if (outcome === 'not_due') {
        summary.notDue++;
        continue;
      }
      handled++;
      if (outcome === 'not_pending' || outcome === 'lost') summary.lost++;
      else summary[outcome]++;
    } catch (err) {
      // After the claim the retry is spent: logged, not retried (one retry per lead, ever).
      handled++;
      summary.failed++;
      console.error(`${TAG} retry lost after claim: list ${c.listId} lead ${c.leadId}:`, errorName(err));
    }
  }
  return summary;
}
