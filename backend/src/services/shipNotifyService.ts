/**
 * Ship notification — a Slack ping in the customer's own channel when an item they
 * reported ships (feature-request post marked Completed, bug canonical marked Done).
 *
 * ADDITIVE to the email paths (Resend resolve-bridge for bugs; Featurebase's native
 * upvoter email for feature requests) — email stays the always-on baseline. Every
 * failure mode here degrades to that baseline: `notifyReporterShipped` NEVER throws,
 * so a Slack hiccup can't block an email or a ticket flip (callers rely on that).
 *
 * Channel choice: the user's FIRST mapped channel via the same personal → org →
 * org-owner resolution Emma's Slack tools use (getEffectiveAllowedChannels) — the
 * channel the portal's Get Support modal calls "your Slack channel".
 *
 * Idempotency: an AW-Settings marker per item listing already-notified reporter
 * emails, so a re-completed item or a duplicate webhook delivery doesn't re-ping.
 * A concurrent duplicate delivery can race past the marker read; accepted for a
 * notification. A failed send records no marker, so Featurebase's delivery retry
 * gets another chance.
 */
import { getEffectiveAllowedChannels, postSlackMessage } from './slackService';
import { userDb } from './db';
import { settingsService } from './settingsService';

export type ShipNotifyOutcome = 'sent' | 'no_user' | 'opted_out' | 'no_channel' | 'already_sent' | 'failed';

export interface ShipNotifyParams {
  email: string;
  /** Unique id of the shipped item (Featurebase post id / Linear canonical uuid) — scopes the idempotency marker. */
  itemId: string;
  title: string;
  url?: string;
  kind: 'feature_request' | 'bug';
}

const markerKey = (itemId: string) => `ship-notify:${itemId}`;

async function readNotifiedMarker(itemId: string): Promise<string[]> {
  const setting = await settingsService.getSetting(markerKey(itemId));
  if (!setting?.settingValue) return [];
  try {
    const arr = JSON.parse(setting.settingValue);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function notifyReporterShipped(p: ShipNotifyParams): Promise<ShipNotifyOutcome> {
  try {
    const user = await userDb.getUserByEmail(p.email);
    if (!user) return 'no_user';
    if (user.slackShipNotifyDisabled) return 'opted_out';

    const channels = await getEffectiveAllowedChannels(user);
    if (channels.length === 0) return 'no_channel';

    const notified = await readNotifiedMarker(p.itemId);
    if (notified.includes(p.email)) return 'already_sent';

    const text =
      p.kind === 'feature_request'
        ? `🎉 Shipped: *${p.title}*\nA feature you requested is now live.${p.url ? `\n${p.url}` : ''}`
        : `✅ Resolved: *${p.title}*\nAn issue you reported has been fixed — thanks for flagging it.${p.url ? `\n${p.url}` : ''}`;

    await postSlackMessage(channels[0], text);

    // Marker write is best-effort: the message is already out, so a failure here must
    // not turn a delivered notification into a reported error.
    try {
      await settingsService.setSetting(markerKey(p.itemId), JSON.stringify([...notified, p.email]));
    } catch (e) {
      console.warn('[ship-notify] marker write failed:', e instanceof Error ? e.message : e);
    }
    return 'sent';
  } catch (e) {
    console.warn(`[ship-notify] notifying ${p.email} failed:`, e instanceof Error ? e.message : e);
    return 'failed';
  }
}

/**
 * Notify everyone who asked for a feature-request post: the author plus its voters
 * (dedup stacks additional reporters as voters at intake). The webhook payload may
 * omit author.email / postUrl, so gaps are filled from the Featurebase API. Voter
 * fetch failure degrades to author-only. Never throws — the webhook handler must
 * always be able to 200.
 */
export async function notifyPostShippedRecipients(p: {
  postId: string;
  title: string;
  url?: string;
  authorEmail?: string;
}): Promise<{ sent: number; outcomes: Record<string, ShipNotifyOutcome> }> {
  const outcomes: Record<string, ShipNotifyOutcome> = {};
  try {
    const emails = new Set<string>();
    let url = p.url;
    if (p.authorEmail) emails.add(p.authorEmail.toLowerCase());

    const { getPost, listPostVoters } = await import('./featurebaseService');
    if (!p.authorEmail || !url) {
      try {
        const post = await getPost(p.postId);
        if (!url) url = post.url;
        if (post.authorEmail) emails.add(post.authorEmail.toLowerCase());
      } catch (e) {
        console.warn('[ship-notify] getPost fallback failed:', e instanceof Error ? e.message : e);
      }
    }
    try {
      for (const v of await listPostVoters(p.postId)) {
        if (v.email) emails.add(v.email.toLowerCase());
      }
    } catch (e) {
      console.warn('[ship-notify] voter fetch failed (author-only):', e instanceof Error ? e.message : e);
    }

    let sent = 0;
    for (const email of emails) {
      const outcome = await notifyReporterShipped({ email, itemId: p.postId, title: p.title, url, kind: 'feature_request' });
      outcomes[email] = outcome;
      if (outcome === 'sent') sent++;
    }
    return { sent, outcomes };
  } catch (e) {
    console.warn('[ship-notify] post recipients failed:', e instanceof Error ? e.message : e);
    return { sent: 0, outcomes };
  }
}
