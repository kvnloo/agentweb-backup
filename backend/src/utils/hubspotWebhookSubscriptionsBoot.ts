import { buildInfo } from './buildInfo';
import { ensureWebhookSubscriptions } from './hubspotWebhookSubscriptions';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from '../services/asyncJobQueue';

export const SUBSCRIPTION_SYNC_SOURCE = 'hubspot_webhook_subscription_sync';

export type BootSyncOutcome = 'ran' | 'already-claimed' | 'skipped-no-build' | 'skipped-disabled' | 'skipped-queue-unavailable';

const syncStandardSubscriptions = async (): Promise<void> => {
  await ensureWebhookSubscriptions([], []);
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
 * Never throws. A failed registration is logged by ensureWebhookSubscriptions and retried on the next
 * config save or the next build.
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
  } catch (err: any) {
    await markJobFailed(SUBSCRIPTION_SYNC_SOURCE, build, err).catch(() => undefined);
  } finally {
    stopHeartbeat();
  }
  return 'ran';
}
