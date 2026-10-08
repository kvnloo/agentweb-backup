import { upsertSessionLead } from './sessionUpsertService';
import { buildSessionRow, type ParsedIngest } from '../utils/trackingIngest';
import { resolveClientIdentity } from '../utils/clientIdentity';
import { SESSION_JOURNEY_KEYS, isSessionList, sessionLeadId } from '../utils/sessionList';
import { matchRoutingRules } from '../utils/trackingConfig';
import { crmDb } from './db';
import { ingestListCache } from '../utils/ingestListCache';

/**
 * "Latest state" fields written by one event, guarded by the same eventCount as the journey: with
 * concurrent beacons an older event must not make lastEvent / furthestStage / the last click go backwards.
 * (Engagement scalars — dwellSec etc. — stay last-write-wins; they only come from page_exit, which is
 * cumulative, so a stale one is overwritten by the next.)
 */
export const INGEST_GUARDED_KEYS: readonly string[] = [
  ...SESSION_JOURNEY_KEYS, 'lastEvent', 'furthestStage', 'lastCustomName', 'lastCustomProps', 'lastClickLabel', 'lastClickSection', 'lastClickUrl',
];

/**
 * ENG-2325: the list row the ingest evaluates its gates against, from the short-lived in-process cache
 * (utils/ingestListCache: staleness, invalidation and bounds are documented there). The ONLY ingest
 * reader of a list row; loads with a consistent read so a read after this process's own write is fresh.
 */
export const getIngestList = (listId: string) => ingestListCache.get(listId, (id) => crmDb.getLeadListById(id, { consistentRead: true }));

/**
 * ENG-2315 / ENG-2316: writes one tracker event into its session list and, when the list has
 * routing rules, into every matching child session list.
 *
 * PARENT: always upserted and authoritative — it keeps every session, so its totals never change
 * because of routing, and a parent failure fails the request. The upsert is the same exactly-once
 * implementation forward-lead uses, so concurrent / duplicate / out-of-order deliveries of one
 * session's events collapse onto one row.
 *
 * CHILDREN: the SAME sessionId/sessionStartMs, so each child has its own deterministic leadId
 * (the hash includes the list id) and the same exactly-once guarantees. They run concurrently with
 * the parent and are isolated: a child failure is logged and NEVER fails the request or the parent.
 * Self-healing: the journey is cumulative and every event upserts again, so a child that missed one
 * event converges on the next. The limit: scalar fields only an earlier event carried (e.g. a
 * `lp_view_at` the child missed) stay missing on that child.
 *
 * Children are re-read and re-checked here (still a session list, same owner as the parent) rather
 * than trusting the stored rule: the config was valid when saved, but this is the write path.
 *
 * Writes ROWS ONLY. Session lists are telemetry: no lead side effects, no alerts, no CAPI
 * (createLead is told suppressSideEffects by the upsert).
 */
export async function ingestTrackerEvent(input: {
  list: Record<string, any>;
  parsed: ParsedIngest;
  userAgent: string;
  /** The visitor's address as the route resolved it (first X-Forwarded-For hop), or ''. */
  visitorIp: string;
}): Promise<{
  classification: ReturnType<typeof buildSessionRow>['classification'];
  childListIds: string[];
  childFailures: string[];
}> {
  const { list, parsed, userAgent, visitorIp } = input;
  const nowIso = new Date().toISOString();
  const pageLabel = typeof list.trackingConfig?.pageLabel === 'string' ? list.trackingConfig.pageLabel : undefined;
  const built = buildSessionRow(parsed, { userAgent, pageLabel, nowIso });
  const { classification } = built;

  // resolveClientIdentity drops IP and UA together when the caller is not a browser (see its doc comment).
  const identity = resolveClientIdentity(userAgent, visitorIp);

  // `ownerUserId` is handed to createLead so it does not re-read the list row just to learn its owner: that read
  // happens BEFORE the conditional put, i.e. on EVERY event (the put then fails for all but a session's first),
  // and would put the per-event list read straight back. The owner comes from the same cached row the gates used.
  const write = async (listId: string, ownerUserId: unknown): Promise<unknown> => {
    // ENG-2324: a substituted start (device clock unusable) advances once a day, at the session's own phase,
    // and a session that outlived the device start's window lives under the old one. If the session already
    // has a row under one of the candidate starts, keep writing THERE: exact-key consistent reads, only for
    // substituted sessions, so a normal event pays nothing extra.
    let sessionIdentity = parsed.identity;
    for (const startMs of parsed.identity.probeStartsMs ?? []) {
      const candidate = { sessionId: sessionIdentity.sessionId, sessionStartMs: startMs };
      if (await crmDb.getLeadById(listId, sessionLeadId(listId, candidate), { consistentRead: true })) { sessionIdentity = candidate; break; }
    }
    // One object per target: the upsert normalises the counter in place.
    const customFields = { ...built.customFields, sessionStartMs: sessionIdentity.sessionStartMs, forwardedAt: nowIso };
    return upsertSessionLead({
      listId,
      identity: sessionIdentity,
      leadData: {
        firstName: '', lastName: '', phone: '', company: '', title: '', notes: '', linkedin: '',
        ...(typeof ownerUserId === 'string' && ownerUserId ? { userId: ownerUserId } : {}),
        ...(identity.clientIp ? { clientIp: identity.clientIp } : {}),
        ...(identity.clientUserAgent ? { clientUserAgent: identity.clientUserAgent } : {}),
        customFields,
      },
      customFields,
      callerSuppliedSource: true,
      journeyKeys: INGEST_GUARDED_KEYS,
    });
  };

  const childListIds = matchRoutingRules(list.trackingConfig?.routing, classification).filter((id) => id !== list.listId);
  const childFailures: string[] = [];
  const writeChild = async (childId: string): Promise<void> => {
    try {
      const child = await getIngestList(childId);
      if (!child || !isSessionList(child) || child.userId !== list.userId) {
        throw new Error('child list missing, not a session list, or owned by someone else');
      }
      await write(childId, child.userId);
    } catch (err: any) {
      childFailures.push(childId);
      console.warn(`[trackerIngest] child write failed list=${list.listId} child=${childId}: ${err?.message ?? err}`);
    }
  };

  await Promise.all([write(list.listId, list.userId), ...childListIds.map(writeChild)]);
  return { classification, childListIds, childFailures };
}
