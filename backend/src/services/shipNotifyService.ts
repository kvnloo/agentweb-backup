/**
 * Ship notification — a ping in the customer's own channel when an item they
 * reported ships (feature-request post marked Completed, bug canonical marked Done).
 *
 * ADDITIVE to the email paths (Resend resolve-bridge for bugs; Featurebase's native
 * upvoter email for feature requests) — email stays the always-on baseline. Every
 * failure mode here degrades to that baseline: `notifyReporterShipped` NEVER throws,
 * so a channel hiccup can't block an email or a ticket flip (callers rely on that).
 *
 * Channel choice: every channel the user has configured, resolved through
 * messagingChannelService — the ONE platform-wide answer to "which channel belongs to
 * this user" (ENG-273). For a Slack-only customer this is unchanged behavior: their
 * mapping IS the Slack Connect channel ("{company}-agentweb", verified ext-shared +
 * bot-member on prod 2026-07-02). A customer who has also configured WhatsApp gets
 * both, because these are peer channels rather than a fallback chain — the point is
 * to reach people where they actually are.
 *
 * The message greets the requester by name so it reads as addressed to them inside a
 * shared customer channel.
 *
 * Idempotency: an atomic per-item claim (DynamoDB string-set ADD via
 * settingsService.claimSetMember) taken BEFORE the send, so concurrent or replayed
 * webhook deliveries produce exactly one ping per item × reporter. The claim covers
 * the reporter, not one channel — releasing it because WhatsApp failed would
 * re-deliver the Slack message too. It is released only when NO channel succeeded.
 */
import { userDb } from './db';
import { settingsService } from './settingsService';
import {
  bootstrapMessagingChannels,
  formatForChannel,
  getMessagingChannel,
  normalizeUserChannels,
  resolveDestination,
  type MessagingChannel,
} from './messagingChannelService';
import { TEMPLATES } from './whatsappService';

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

/** Only plain http(s) URLs with no Slack control chars make it into the message. */
const safeUrl = (url?: string) => (url && /^https?:\/\/[^\s<>|]+$/.test(url) ? url : undefined);

export async function notifyReporterShipped(p: ShipNotifyParams): Promise<ShipNotifyOutcome> {
  try {
    const user = await userDb.getUserByEmail(p.email);
    if (!user) return 'no_user';
    if (user.slackShipNotifyDisabled) return 'opted_out';

    await bootstrapMessagingChannels();

    // Candidates are the channels this user has configured, PLUS Slack always —
    // Slack resolves through an org/owner fallback, so a user with no personal
    // config can still have an inherited channel. Dropping Slack from the candidate
    // list when the user record carries no slack* field would silently stop
    // notifying every org member who relies on that inheritance.
    const configured = normalizeUserChannels(user)
      .filter((c) => c.enabled)
      .map((c) => c.channel);
    const targets: Array<{ channel: MessagingChannel; destination: string }> = [];
    for (const channel of new Set<MessagingChannel>(['slack', ...configured])) {
      const destination = await resolveDestination(user, channel);
      if (destination) targets.push({ channel, destination });
    }
    if (targets.length === 0) return 'no_channel';

    // Claim BEFORE the send: exactly one winner per item × reporter, even across
    // concurrent deliveries / replays. Losing the claim means someone else sent it.
    const claimed = await settingsService.claimSetMember(markerKey(p.itemId), p.email);
    if (!claimed) return 'already_sent';

    const url = safeUrl(p.url);
    // Greet by first name so the message is addressed to the requester, not the room —
    // customer channels are shared. (A real <@mention> needs the users:read.email bot
    // scope, which the app doesn't have yet.)
    const firstName = (user.displayName || '').trim().split(/\s+/)[0];

    let anySent = false;
    for (const target of targets) {
      // Titles are user-generated — anyone can author a public Featurebase post — so
      // they are escaped per channel. On Slack that stops a title smuggling a
      // <!channel> broadcast or a <url|label> disguised link into a shared customer
      // channel; on WhatsApp the same escaping would render as literal "&lt;".
      const title = formatForChannel(p.title, target.channel);
      const you = firstName ? `${formatForChannel(firstName, target.channel)}, you` : 'You';
      const text =
        p.kind === 'feature_request'
          ? `🎉 *${title}* just shipped!\n${you} asked for this one — it's now live.${url ? `\n${url}` : ''}`
          : `✅ *${title}* is fixed.\n${you} reported this — thanks for flagging it.${url ? `\n${url}` : ''}`;

      try {
        await getMessagingChannel(target.channel).sendMessage({
          destination: target.destination,
          text,
          // Carried for channels that cannot send free-form outside a service window.
          // Slack's adapter ignores it; WhatsApp needs it whenever the customer has
          // not messaged us in the last 24h, which for a ship notification is usual.
          ...(target.channel === 'whatsapp'
            ? { template: { name: TEMPLATES.SHIP_NOTIFY.name, variables: [p.title, url ?? ''] } }
            : {}),
        } as any);
        anySent = true;
      } catch (e) {
        console.warn(
          `[ship-notify] ${target.channel} send to ${target.destination} for ${p.email} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!anySent) {
      // Release the claim so a delivery retry can re-attempt. Released only when NO
      // channel landed — releasing because one of two failed would re-deliver the one
      // that succeeded. Release failing too just costs a missed ping (never a
      // duplicate) — the email baseline is unaffected either way.
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
