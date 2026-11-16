import { buildInfo } from './buildInfo';
import { ensureWebhookSubscriptionsChecked } from './hubspotWebhookSubscriptions';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from '../services/asyncJobQueue';

export const SUBSCRIPTION_SYNC_SOURCE = 'hubspot_webhook_subscription_sync';

export type BootSyncOutcome = 'ran' | 'failed-will-retry' | 'already-claimed' | 'skipped-no-build' | 'skipped-disabled' | 'skipped-queue-unavailable';

// Throws when any registration failed, so the queue marks the claim for retry instead of completed.
const syncStandardSubscriptions = async (): Promise<void> => {
  if (!(await ensureWebhookSubscriptionsChecked())) {
    throw new Error('one or more HubSpot webhook subscriptions could not be registered');
  }
};

// A claim whose owner crashed mid-run is re-run by the queue's poller; the run is idempotent.
registerProcessor(SUBSCRIPTION_SYNC_SOURCE, syncStandardSubscriptions);

/**
 * Registers the app-wide HubSpot webhook subscriptions once per deployed build, so a new event type
 * (e.g. contact.merge) takes effect at deploy time instead of waiting for someone to save a sync config.
 *
 * Several instances boot together on a deploy and HubSpot's behaviour on a duplicate subscription is
 * undocumented, so the run is claimed with an atomic insert-if-absent keyed on the build's commit:
 * exactly one instance proceeds; the others see 'already-claimed' and stand down. If the queue cannot
 * be reached we DO NOT run unguarded. No build identity (local run, preview, tests) means no run, so a
 * developer machine can never register against the shared HubSpot app.
 *
 * Never throws. A failed registration marks the claim for retry: the queue's poller re-runs the
 * registered processor (capped attempts), and the next config save also retries.
 */
export async function ensureWebhookSubscriptionsOncePerBuild(): Promise<BootSyncOutcome> {
  if (String(process.env.HUBSPOT_BOOT_SUBSCRIPTIONS || '').trim().toLowerCase() === 'off') return 'skipped-disabled';
  const build = buildInfo.commit || buildInfo.versionLabel;
  if (!build) return 'skipped-no-build';

  let claim: Awaited<ReturnType<typeof enqueueJob>>;
  try {
    claim = await enqueueJob(SUBSCRIPTION_SYNC_SOURCE, build, { build }, { claimImmediately: true });
  } catch (err: any) {
    console.warn(`[HubSpotWebhook] boot subscription sync: claim failed (${err?.message || err}) — not running unguarded.`);
    return 'skipped-queue-unavailable';
  }
  if (claim === 'duplicate') {
    console.log(`[HubSpotWebhook] boot subscription sync: build ${build} already claimed by another instance — standing down.`);
    return 'already-claimed';
  }
  if (claim !== 'enqueued') return 'skipped-queue-unavailable';

  const stopHeartbeat = startHeartbeat(SUBSCRIPTION_SYNC_SOURCE, build);
  try {
    await syncStandardSubscriptions();
    await markJobComplete(SUBSCRIPTION_SYNC_SOURCE, build);
    return 'ran';
  } catch (err: any) {
    console.warn(`[HubSpotWebhook] boot subscription sync did not complete (${err?.message || err}) — queued for retry.`);
    await markJobFailed(SUBSCRIPTION_SYNC_SOURCE, build, err).catch(() => undefined);
    return 'failed-will-retry';
  } finally {
    stopHeartbeat();
  }
}
