/**
 * Ship notification — a Slack ping in the customer's own channel when an item they
 * reported ships (feature-request post marked Completed, bug canonical marked Done).
 *
 * ADDITIVE to the email paths (Resend resolve-bridge for bugs; Featurebase's native
 * upvoter email for feature requests) — email stays the always-on baseline. Every
 * failure mode here degrades to that baseline: `notifyReporterShipped` NEVER throws,
 * so a Slack hiccup can't block an email or a ticket flip (callers rely on that).
 *
 * Channel choice: the user's first mapped channel via getEffectiveAllowedChannels —
 * the ONE platform-wide answer to "which Slack channel belongs to this user" (Emma's
 * Slack tools, the Get Support modal, and lead alerts all resolve through the same
 * mapping). For customers this mapping IS their Slack Connect channel
 * ("{company}-agentweb", verified ext-shared + bot-member on prod 2026-07-02).
 * The message greets the requester by name so it reads as addressed to them inside
 * a shared customer channel.
 *
 * Idempotency: an atomic per-item claim (DynamoDB string-set ADD via
 * settingsService.claimSetMember) taken BEFORE the send, so concurrent or replayed
 * webhook deliveries produce exactly one ping per item × reporter. A failed send
 * releases the claim, so a delivery retry gets another chance; a failed release
 * costs a missed ping, never a duplicate — email still lands either way.
 */
import { getEffectiveAllowedChannels, postSlackMessage } from './slackService';
import { userDb } from './db';
import { settingsService } from './settingsService';

export type ShipNotifyOutcome = 'sent' | 'no_user' | 'opted_out' | 'no_channel' | 'already_sent' | 'failed';

export interface ShipNotifyParams {
  email: string;
  /** Unique id of the shipped item (Featurebase post id / Linear canonical uuid) — scopes the idempotency claim. */
  itemId: string;
  title: string;
  url?: string;
  kind: 'feature_request' | 'bug';
}

const markerKey = (itemId: string) => `ship-notify:${itemId}`;

/**
 * Titles are user-generated (anyone can author a public Featurebase post) — escape
 * Slack's control characters so a title can't smuggle <!channel>/<!here> broadcasts
 * or <url|label> disguised links into a customer's channel.
 */
const escapeSlackText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Only plain http(s) URLs with no Slack control chars make it into the message. */
const safeUrl = (url?: string) => (url && /^https?:\/\/[^\s<>|]+$/.test(url) ? url : undefined);

export async function notifyReporterShipped(p: ShipNotifyParams): Promise<ShipNotifyOutcome> {
  try {
    const user = await userDb.getUserByEmail(p.email);
    if (!user) return 'no_user';
    if (user.slackShipNotifyDisabled) return 'opted_out';

    const channel = (await getEffectiveAllowedChannels(user))[0];
    if (!channel) return 'no_channel';

    // Claim BEFORE the send: exactly one winner per item × reporter, even across
    // concurrent deliveries / replays. Losing the claim means someone else sent it.
    const claimed = await settingsService.claimSetMember(markerKey(p.itemId), p.email);
    if (!claimed) return 'already_sent';

    const title = escapeSlackText(p.title);
    const url = safeUrl(p.url);
    // Greet by first name so the message is addressed to the requester, not the room —
    // customer channels are shared. (A real <@mention> needs the users:read.email bot
    // scope, which the app doesn't have yet.)
    const firstName = (user.displayName || '').trim().split(/\s+/)[0];
    const you = firstName ? `${escapeSlackText(firstName)}, you` : 'You';
    const text =
      p.kind === 'feature_request'
        ? `🎉 *${title}* just shipped!\n${you} asked for this one — it's now live.${url ? `\n${url}` : ''}`
        : `✅ *${title}* is fixed.\n${you} reported this — thanks for flagging it.${url ? `\n${url}` : ''}`;

    try {
      await postSlackMessage(channel, text);
    } catch (e) {
      console.warn(`[ship-notify] Slack post to ${channel} for ${p.email} failed:`, e instanceof Error ? e.message : e);
      // Release the claim so a delivery retry can re-attempt. Release failing too just
      // costs a missed ping (never a duplicate) — the email baseline is unaffected.
      try {
        await settingsService.releaseSetMember(markerKey(p.itemId), p.email);
      } catch (re) {
        console.warn('[ship-notify] claim release failed:', re instanceof Error ? re.message : re);
      }
      return 'failed';
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
 * fetch failure degrades to author-only. Never throws — the webhook handler
 * fire-and-forgets this and must always be able to 200 immediately.
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
