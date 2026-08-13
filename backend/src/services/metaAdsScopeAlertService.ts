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
 * How long one owner+account pair is considered "just told". Long enough to
 * cover two runs overlapping, short enough that it can never swallow a genuine
 * alert for a later, separate outage — the durable marker handles that.
 */
const RESEND_GUARD_MS = 15 * 60 * 1000;

/** owner+account -> epoch ms of the last send attempt from this process. */
const recentlySent = new Map<string, number>();

/** Keep the guard map from growing without bound on a long-lived process. */
const pruneRecentlySent = (now: number = Date.now()): void => {
  for (const [key, at] of recentlySent) {
    if (now - at >= RESEND_GUARD_MS) recentlySent.delete(key);
  }
};

/** Test seam: forget every in-process send record. */
export const __resetMetaAdsScopeAlertGuard = (): void => {
  recentlySent.clear();
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

  // In-process guard against two runs racing on the same account. The durable
  // `ads_scope_alerted_at` marker is the real dedup, but it is written by a
  // read-modify-write with no condition, so two concurrent callers can both read
  // "not yet alerted" and both send. Mirrors the singleflight already used for
  // token refresh, and like it covers one process — which is the whole of prod
  // today (see metaTokenRefresh's note on the single instance).
  const key = `${ownerUserId}:${accountId ?? 'unknown'}`;
  const lastSent = recentlySent.get(key);
  if (lastSent !== undefined && Date.now() - lastSent < RESEND_GUARD_MS) {
    console.warn(
      `[MetaAdsScopeAlert] Skipped a duplicate ads-scope alert for ${key} — one was sent ${Math.round((Date.now() - lastSent) / 1000)}s ago`
    );
    return false;
  }
  recentlySent.set(key, Date.now());
  pruneRecentlySent();

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
    return true;
  } catch (error: any) {
    console.warn(
      `[MetaAdsScopeAlert] Could not notify owner ${ownerUserId} of the missing Meta Ads scope: ${error?.message ?? error}`
    );
    return false;
  }
};
