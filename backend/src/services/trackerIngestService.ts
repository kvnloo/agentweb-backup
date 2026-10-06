import { upsertSessionLead } from './sessionUpsertService';
import { buildSessionRow, type ParsedIngest } from '../utils/trackingIngest';
import { resolveClientIdentity } from '../utils/clientIdentity';
import { SESSION_JOURNEY_KEYS } from '../utils/sessionList';

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
 * ENG-2315: writes one tracker event into its session list through the shared exactly-once
 * upsert (the same implementation forward-lead uses), so concurrent / duplicate / out-of-order
 * deliveries of one session's events collapse onto one row.
 *
 * Writes the ROW ONLY. Session lists are telemetry: no lead side effects, no alerts, no CAPI
 * (createLead is told suppressSideEffects by the upsert).
 */
export async function ingestTrackerEvent(input: {
  list: Record<string, any>;
  parsed: ParsedIngest;
  userAgent: string;
  /** The visitor's address as the route resolved it (first X-Forwarded-For hop), or ''. */
  visitorIp: string;
}): Promise<{ classification: ReturnType<typeof buildSessionRow>['classification'] }> {
  const { list, parsed, userAgent, visitorIp } = input;
  const nowIso = new Date().toISOString();
  const pageLabel = typeof list.trackingConfig?.pageLabel === 'string' ? list.trackingConfig.pageLabel : undefined;
  const built = buildSessionRow(parsed, { userAgent, pageLabel, nowIso });

  // resolveClientIdentity drops IP and UA together when the caller is not a browser (see its doc comment).
  const identity = resolveClientIdentity(userAgent, visitorIp);

  const customFields = { ...built.customFields, forwardedAt: nowIso };
  await upsertSessionLead({
    listId: list.listId,
    identity: parsed.identity,
    leadData: {
      firstName: '', lastName: '', phone: '', company: '', title: '', notes: '', linkedin: '',
      ...(identity.clientIp ? { clientIp: identity.clientIp } : {}),
      ...(identity.clientUserAgent ? { clientUserAgent: identity.clientUserAgent } : {}),
      customFields,
    },
    customFields,
    callerSuppliedSource: true,
    journeyKeys: INGEST_GUARDED_KEYS,
  });
  return { classification: built.classification };
}
