import { userDb } from './db';
import { emailService } from './emailService';
import { META_ADS_RECONSENT_MESSAGE } from '../utils/metaAdsScope';

/**
 * Tell the owner, once, that a Meta ad connection has lost its Ads permission.
 *
 * WHY THIS EXISTS (ENG-1158)
 * --------------------------
 * The moment we learn an ad account can no longer read ads data is inside an
 * unattended run — a scheduled report, at 07:00, with nobody watching. Before
 * this, nothing reached the owner: account 922903076601160 produced zero-data
 * reports for four days and its owner only found out by reading the run output.
 * The reconnect is owner-only work, so the detection is worthless unless it
 * travels to a human.
 *
 * Fired from both the detection path and the pre-flight gate, deduped by the
 * caller on the `ads_scope_alerted_at` marker, so one outage produces one email
 * however it is noticed. Notably NOT keyed off the detection transition: the
 * account this was written for was already latched when the alert shipped, and
 * the gate means its detection path will never run again — a transition-only
 * alert would leave exactly the reported outage silent. A successful reconnect
 * replaces the config, clearing the marker, so a later outage alerts afresh.
 *
 * Best-effort by construction: this never throws and never rejects. It rides
 * alongside a user-facing error that must reach the caller intact, so a mail
 * outage or a missing user record must not become the thing the customer sees.
 */
/**
 * Singleflight: owner+account -> the send currently in flight for it.
 *
 * Concurrent callers join the same attempt and receive the same answer, which
 * is what closes the race on `ads_scope_alerted_at` — that marker is written by
 * a read-modify-write with no condition, so two runs can both read "not yet
 * alerted" and both send.
 *
 * Entries live only for the duration of the send, so the map cannot grow.
 * Covers one process, like the token-refresh singleflight it mirrors.
 */
const inFlightAlerts = new Map<string, Promise<boolean>>();

/** How long after a CONFIRMED send the same notice is not worth repeating. */
const RESEND_GUARD_MS = 15 * 60 * 1000;

/**
 * owner+account -> when we last actually delivered this notice.
 *
 * Recorded ONLY after a successful send, which is the whole difference from the
 * first version of this guard: that one recorded the attempt up front, so a
 * failed send reported success to everyone arriving later and the owner was
 * silenced permanently (Greptile P1). Recording success is a true statement, so
 * reporting it as "already told" is safe.
 *
 * Needed because the durable marker is now only written after delivery: without
 * this, a run whose marker write failed would re-send on every subsequent
 * blocked agent call, not just once per sweep.
 */
const sentRecently = new Map<string, number>();

const pruneSentRecently = (now: number): void => {
  for (const [key, at] of sentRecently) {
    if (now - at >= RESEND_GUARD_MS) sentRecently.delete(key);
  }
};

/** Test seam: forget every in-flight and recently-delivered send. */
export const __resetMetaAdsScopeAlertGuard = (): void => {
  inFlightAlerts.clear();
  sentRecently.clear();
};

export const notifyMetaAdsScopeLost = async (params: {
  ownerUserId: string;
  accountId?: string;
  accountName?: string;
}): Promise<boolean> => {
  const { ownerUserId, accountId, accountName } = params;

  // Production only. The dev and preview databases are clones of production, so
  // they carry real customer addresses, and this alert now fires from a cron
  // that runs on boot — meaning any preview environment would mail real people
  // about an account they cannot see. `sendOncallAlert` guards itself the same
  // way for the same reason. Callers still record the marker, so a real
  // production sweep is unaffected by whatever a preview did.
  //
  // Logged at WARN naming the environment it actually saw, because the failure
  // this guard can cause is silence: if production's NODE_ENV were ever not
  // exactly 'production', the alert half of ENG-1158 would be inert and look
  // identical to "nobody needed telling" — which is the very bug this ticket is
  // about. One grep for this line answers it.
  const env = process.env.NODE_ENV || '(unset)';
  if (env !== 'production') {
    console.warn(
      `[MetaAdsScopeAlert] Suppressed ads-scope alert to owner ${ownerUserId} for account ${accountId ?? 'unknown'} — NODE_ENV is "${env}", alerts send only from production`
    );
    return false;
  }

  // Join an in-flight send for this exact owner+account rather than starting a
  // second one. Every joiner gets the real outcome, so a failure is never
  // reported to anyone as a success.
  const key = `${ownerUserId}:${accountId ?? 'unknown'}`;

  const lastDelivered = sentRecently.get(key);
  if (lastDelivered !== undefined && Date.now() - lastDelivered < RESEND_GUARD_MS) {
    // True because it IS true: this process delivered it moments ago.
    console.warn(
      `[MetaAdsScopeAlert] Not repeating the ads-scope alert for ${key} — delivered ${Math.round((Date.now() - lastDelivered) / 1000)}s ago`
    );
    return true;
  }

  let inFlight = inFlightAlerts.get(key);
  if (!inFlight) {
    inFlight = deliverMetaAdsScopeAlert({ ownerUserId, accountId, accountName }, key);
    inFlightAlerts.set(key, inFlight);
    void inFlight.finally(() => inFlightAlerts.delete(key));
  } else {
    console.warn(`[MetaAdsScopeAlert] Joined an in-flight ads-scope alert for ${key}`);
  }
  return inFlight;
};

/**
 * Actually build and send the notice. Never throws and never rejects — it rides
 * alongside a user-facing error that must reach the caller intact, so a mail
 * outage or a missing user record must not become the thing the customer sees.
 *
 * Returns false for every outcome in which the owner was NOT told, so callers
 * can retract their notice marker and let a later run retry.
 */
const deliverMetaAdsScopeAlert = async (params: {
  ownerUserId: string;
  accountId?: string;
  accountName?: string;
}, key: string): Promise<boolean> => {
  const { ownerUserId, accountId, accountName } = params;

  try {
    const owner = await userDb.getUserById(ownerUserId);
    const email = owner?.email;
    if (!email) {
      console.warn(
        `[MetaAdsScopeAlert] No email on file for owner ${ownerUserId}; skipping ads-scope alert`
      );
      return false;
    }

    const label = accountId ? `act_${String(accountId).replace('act_', '')}` : 'your Meta ad account';
    const named = accountName ? `${accountName} (${label})` : label;
    const settingsUrl = `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/settings/accounts`;

    const subject = 'Action needed: reconnect Meta Ads to resume reporting';

    const text = [
      `Meta Ads reporting is blocked for ${named}.`,
      '',
      META_ADS_RECONSENT_MESSAGE,
      '',
      'Until this is reconnected, scheduled Meta Ads reports cannot read campaigns,',
      'insights or spend for this account — they will report no data. This is an',
      'authorization problem, not a period with no campaign activity.',
      '',
      `Reconnect here: ${settingsUrl}`,
    ].join('\n');

    const esc = (value: string) => emailService.escapeHtml(value);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 640px;">
        <h2 style="margin-bottom: 12px;">Reconnect Meta Ads to resume reporting</h2>
        <p>Meta Ads reporting is blocked for <strong>${esc(named)}</strong>.</p>
        <p>${esc(META_ADS_RECONSENT_MESSAGE)}</p>
        <p>
          Until this is reconnected, scheduled Meta Ads reports cannot read campaigns,
          insights or spend for this account — they will report no data. This is an
          authorization problem, not a period with no campaign activity.
        </p>
        <p><a href="${esc(settingsUrl)}">${esc(settingsUrl)}</a></p>
      </div>
    `;

    await emailService.sendEmail(email, subject, text, html);

    // Only now, with the send confirmed, is it true that the owner was told.
    const now = Date.now();
    sentRecently.set(key, now);
    pruneSentRecently(now);
    return true;
  } catch (error: any) {
    console.warn(
      `[MetaAdsScopeAlert] Could not notify owner ${ownerUserId} of the missing Meta Ads scope: ${error?.message ?? error}`
    );
    return false;
  }
};
