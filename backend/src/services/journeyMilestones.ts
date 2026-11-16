/**
 * ENG-2906 — call-site helpers that combine the AW-Users attribution writes
 * (journeyAttribution) with journey events (journeyTracking). Every helper resolves; a failure
 * is logged and dropped, never surfaced to the request.
 */
import {
  journeyAttribution,
  toUserAttributionConfidence,
  ZOMA_MILESTONE_FIELDS,
  type JourneyProduct,
  type SignupAttribution,
  type SignupAttributionOptions,
  type ZomaMilestone,
  type ZomaStage,
} from './journeyAttribution';
import { identifyJourney, trackJourney, type JourneyEvent } from './journeyTracking';

function warn(op: string, error: unknown) {
  console.warn(`[journey] ${op} failed (ignored):`, error instanceof Error ? error.message : String(error));
}

/** Record that a user used a product: products map (hourly) + person `products` when new. */
export async function noteProductUse(userId: string | undefined, product: JourneyProduct): Promise<void> {
  if (!userId || product === 'unknown') return;
  try {
    const result = await journeyAttribution.touchProduct(userId, product);
    if (result === 'created') await identifyJourney(userId, { products: await productsOf(userId, product) });
  } catch (error) {
    warn('touchProduct', error);
  }
}

async function productsOf(userId: string, added: JourneyProduct): Promise<string[]> {
  try {
    const { userDb } = await import('./db');
    const user: any = await userDb.getUserById(userId);
    const keys = user?.products && typeof user.products === 'object' ? Object.keys(user.products) : [];
    return [...new Set([...keys, added])];
  } catch {
    return [added];
  }
}

const STAGE_FOR_EVENT: Partial<Record<JourneyEvent, ZomaStage>> = {
  signed_up: 'signed_up',
  connected: 'connected',
  meta_connected: 'platform_connected',
  google_connected: 'platform_connected',
  card_saved: 'card_saved',
  first_read: 'first_read',
  first_write: 'first_write',
  // ENG-2902: only from verifyZomaFirstAds, after the provider check proves a Zoma-approved go-live + lifetime impressions >= 1.
  ad_live: 'ad_live',
};

/**
 * Advance the user's forward-only zomaStage for `event`, then emit the journey event.
 *   emit: 'always'        rare, already-deduplicated moments (connected, card_saved, ...)
 *   emit: 'if_advanced'   per-call moments: emitted once. first_read / first_write have their own
 *                         write-once milestone field, so each is emitted exactly once even when
 *                         the stage already moved past it (first_write before first_read); other
 *                         events are emitted when the stage write actually moved forward
 *   emit: 'never'         stage only (the event was already emitted elsewhere, e.g. signed_up)
 *   requireZoma           shared Emma/Zoma surfaces (Meta/Google connect, Stripe): only move the
 *                         stage for users who already use Zoma
 */
export async function zomaMilestone(
  userId: string | undefined,
  event: JourneyEvent,
  opts: { emit: 'always' | 'if_advanced' | 'never'; requireZoma?: boolean; props?: Record<string, unknown> },
): Promise<void> {
  if (!userId) return;
  const stage = STAGE_FOR_EVENT[event];
  let advanced = false;
  try {
    if (stage) {
      advanced = opts.requireZoma
        ? await journeyAttribution.advanceZomaStage(userId, stage, { requireZoma: true })
        : await journeyAttribution.advanceZomaStage(userId, stage);
    }
  } catch (error) {
    warn(`advance ${event}`, error);
  }
  if (advanced && stage) await identifyJourney(userId, { zomaStage: stage });
  let firstTime = advanced;
  if (opts.emit === 'if_advanced' && isMilestone(event)) {
    firstTime = false;
    try {
      firstTime = await journeyAttribution.markZomaMilestone(userId, event);
    } catch (error) {
      warn(`milestone ${event}`, error);
    }
  }
  if (opts.emit === 'always' || (opts.emit === 'if_advanced' && firstTime)) await trackJourney({ userId }, event, opts.props);
}

const isMilestone = (event: JourneyEvent): event is ZomaMilestone => Object.prototype.hasOwnProperty.call(ZOMA_MILESTONE_FIELDS, event);

/**
 * Write-once signup attribution. Emits `signed_up` (and the set-once person properties) only
 * when this call is the one that attributed the signup, so a retry or a returning user never
 * double-counts. A Zoma signup also moves zomaStage to signed_up. Returns whether it wrote.
 */
export async function noteSignup(userId: string | undefined, attribution: SignupAttribution, opts: SignupAttributionOptions = {}): Promise<boolean> {
  if (!userId) return false;
  let wrote = false;
  try {
    wrote = await journeyAttribution.recordSignupAttribution(userId, attribution, opts);
  } catch (error) {
    warn('recordSignupAttribution', error);
  }
  if (!wrote) return false;
  const confidence = toUserAttributionConfidence(attribution.confidence);
  await identifyJourney(userId, {
    signupProduct: attribution.product,
    signupPath: attribution.path,
    signupClient: attribution.client,
    signupRef: attribution.ref,
    attributionConfidence: confidence,
  });
  await trackJourney({ userId }, 'signed_up', {
    product: attribution.product,
    path: attribution.path,
    client: attribution.client,
    ref: attribution.ref,
    confidence,
  });
  if (attribution.product === 'zoma') await zomaMilestone(userId, 'signed_up', { emit: 'never' });
  return true;
}
