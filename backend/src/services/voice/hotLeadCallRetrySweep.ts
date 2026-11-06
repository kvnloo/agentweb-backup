import { crmDb, orgDb } from '../db';
import { hotLeadCallConfigOf } from '../hotLeadCallConfig';
import { processHotLeadCallRetry } from '../hotLeadCallService';
import { suppressLeadSideEffects } from '../../utils/sessionList';
import { errorName } from './callFinalisation';
import { isHotLeadCallEnabled } from './hotLeadCallMode';

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

/** `HOT_LEAD_CALL_RETRY`: `off`, `0` or `false` disables the sweep; anything else (or unset) leaves it on. */
export function retrySweepEnabled(): boolean {
  const raw = process.env.HOT_LEAD_CALL_RETRY?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

const MAX_LEADS_READ_PER_LIST = 500;
// A run happens every five minutes, so the whole-run bound is lower than the daily stuck sweep's.
const MAX_LEADS_READ_PER_RUN = 2_000;
/** Retries one run may start (each rings a member): the rest wait for the next run. */
const MAX_RETRIES_PER_RUN = 20;
const MAX_RECORDS_HANDLED_PER_RUN = 100;
const SYSTEM_KEY = 'hot_lead_call';

export interface RetrySweepSummary {
  /** HOT_LEAD_CALL_RETRY is not off. */
  enabled: boolean;
  /** The global kill switch is on; false means the run did nothing. */
  killSwitchOn: boolean;
  orgs: number;
  lists: number;
  leadsRead: number;
  /** A read bound or the per-run cap left records for a later run (also true on any large list: not a signal by itself). */
  truncated: boolean;
  /** Records with a deferral and no claim found by the read. */
  found: number;
  notDue: number;
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
  const found: Candidate[] = [];
  const enabledOrgs: string[] = [];
  for (const orgId of await orgDb.listHotLeadCallOrgIds()) {
    summary.orgs++;
    try {
      const org = await orgDb.getOrgById(orgId);
      if (hotLeadCallConfigOf(org?.hotLeadCall)?.enabled) enabledOrgs.push(orgId);
    } catch (err) {
      summary.failed++;
      console.error(`${TAG} retry sweep could not read org ${orgId}:`, errorName(err));
    }
  }
  const updatedBefore = new Date(now.getTime() + 60_000).toISOString(); // every record, whatever its age
  for (const orgId of enabledOrgs) {
    try {
      const listIds = new Set<string>();
      for (const member of await orgDb.getOrgMembers(orgId)) {
        for (const list of await crmDb.getLeadListsByUserId(member.userId)) {
          if (!suppressLeadSideEffects(list)) listIds.add(list.listId);
        }
      }
      for (const listId of listIds) {
        const budget = Math.min(MAX_LEADS_READ_PER_LIST, MAX_LEADS_READ_PER_RUN - summary.leadsRead);
        if (budget <= 0) { summary.truncated = true; break; }
        summary.lists++;
        const result = await crmDb.findLeadsBySystemRecord(listId, SYSTEM_KEY, {
          states: ['finished'], updatedBefore, maxRead: budget, has: ['deferral'], lacks: ['retryClaimToken'],
        });
        summary.leadsRead += result.read;
        summary.truncated ||= result.truncated;
        found.push(...result.leadIds.map((leadId) => ({ listId, leadId })));
      }
    } catch (err) {
      summary.failed++;
      console.error(`${TAG} retry sweep could not read org ${orgId}:`, errorName(err));
    }
  }
  return found;
}

/** One pass. Never throws for a record's or an org's failure; counts only, no ids and no numbers, in the summary. */
export async function runHotLeadCallRetrySweep(now: Date = new Date()): Promise<RetrySweepSummary> {
  const summary: RetrySweepSummary = {
    enabled: retrySweepEnabled(), killSwitchOn: false, orgs: 0, lists: 0, leadsRead: 0, truncated: false,
    found: 0, notDue: 0, attempted: 0, refused: 0, expired: 0, lost: 0, failed: 0,
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
    handled++;
    try {
      const outcome = await processHotLeadCallRetry(c.listId, c.leadId, now);
      if (outcome === 'not_due') summary.notDue++;
      else if (outcome === 'not_pending' || outcome === 'lost') summary.lost++;
      else summary[outcome]++;
    } catch (err) {
      // After the claim the retry is spent: logged, not retried (one retry per lead, ever).
      summary.failed++;
      console.error(`${TAG} retry lost after claim: list ${c.listId} lead ${c.leadId}:`, errorName(err));
    }
  }
  return summary;
}
