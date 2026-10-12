/**
 * Provider-neutral messaging channel seam (ENG-273).
 *
 * AgentWeb grew up Slack-first and hardcoded: `slackService` is imported directly by
 * seven services across ~30 call sites, and "which channel belongs to this user" was
 * answered by a Slack-specific helper. Adding WhatsApp — and later Teams (ENG-272) —
 * on top of that would mean a second and third copy of the same branching.
 *
 * This module is the registry those call sites route through instead. It is shaped
 * deliberately on `emailProviderService` (ENG-266/302), which solved the identical
 * problem for Gmail/Outlook: a neutral interface, a registry, a base error class
 * callers catch instead of enumerating per-provider errors, and a memoized-promise
 * bootstrap (the boolean-flag version of that had a real concurrency bug — ENG-300).
 *
 * ── Why capabilities, not feature detection by name ──────────────────────────
 * WhatsApp genuinely cannot do several things Slack does: no message editing, no
 * threads, no modals, no history read, no user directory. Callers must branch on a
 * declared capability rather than on `channel === 'slack'`, so that a third channel
 * inherits the right behavior without touching every call site.
 */

// ── Channels ───────────────────────────────────────────────────────────────

export type MessagingChannel = 'slack' | 'whatsapp';

export const MESSAGING_CHANNELS: MessagingChannel[] = ['slack', 'whatsapp'];

const isMessagingChannel = (value: unknown): value is MessagingChannel =>
  typeof value === 'string' && (MESSAGING_CHANNELS as string[]).includes(value);

// ── Capabilities ───────────────────────────────────────────────────────────

/**
 * What a channel can actually do. Every field is required: a new channel must make a
 * deliberate statement about each one rather than inheriting a default that happens
 * to describe Slack.
 */
export interface ChannelCapabilities {
  /** Can an already-sent message be edited in place? (WhatsApp: no.) */
  canEdit: boolean;
  /** Can an already-sent message be deleted? (WhatsApp: no.) */
  canDelete: boolean;
  /** Threaded replies, as opposed to a flat conversation. (WhatsApp: quoted replies only.) */
  hasThreads: boolean;
  /** Interactive modals/dialogs. (WhatsApp: no — deep-link to the portal instead.) */
  hasModals: boolean;
  /** Can prior conversation history be read back from the vendor? (WhatsApp: no API.) */
  canReadHistory: boolean;
  /** Is there a user directory to resolve names/emails/mentions? (WhatsApp: no.) */
  hasDirectory: boolean;
  /** How a destination is addressed: a channel id, or an E.164 phone number. */
  addressing: 'channel' | 'phone';
  /** Buttons / quick replies attached to a message. */
  supportsInteractive: boolean;
  /**
   * True when free-form sends are only legal inside a service window and anything
   * outside it must use a pre-approved template. WhatsApp's 24-hour rule; Slack has
   * no equivalent.
   */
  requiresTemplateOutsideWindow: boolean;
  /** True when the platform requires recorded opt-in before the first outbound message. */
  requiresOptIn: boolean;
}

// ── Message shapes ─────────────────────────────────────────────────────────

export interface SendMessageParams {
  /** Channel id (Slack) or E.164 phone (WhatsApp). */
  destination: string;
  text: string;
  /** Provider-native handle of the message being replied to (Slack thread_ts, WhatsApp message id). */
  replyToMessageId?: string;
}

export interface SentMessage {
  /** Provider-native handle for the sent message, when the provider returns one. */
  messageId: string | null;
}

export interface IMessagingChannel {
  readonly channel: MessagingChannel;
  readonly capabilities: ChannelCapabilities;
  sendMessage(params: SendMessageParams): Promise<SentMessage>;
  /** Only meaningful when `capabilities.canEdit`. */
  updateMessage?(destination: string, messageId: string, text: string): Promise<void>;
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Base class for every channel's user-facing errors.
 *
 * Callers catch this, never a concrete subclass — the mistake `emma/tools.ts` made
 * with the five `Gmail*Error` classes, where a second provider's errors silently
 * fell through to the generic handler (ENG-302).
 */
export class MessagingChannelError extends Error {
  readonly channel?: MessagingChannel;

  constructor(message: string, channel?: MessagingChannel) {
    super(message);
    this.name = new.target.name;
    this.channel = channel;
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

const registry = new Map<MessagingChannel, IMessagingChannel>();

export function registerMessagingChannel(
  channel: MessagingChannel,
  impl: IMessagingChannel,
): void {
  registry.set(channel, impl);
}

export function getMessagingChannel(channel: MessagingChannel): IMessagingChannel {
  const impl = registry.get(channel);
  if (!impl) {
    throw new MessagingChannelError(
      `No messaging channel registered for "${channel}". ` +
        `Supported channels: ${[...registry.keys()].join(', ') || '(none — bootstrap not run)'}`,
      channel,
    );
  }
  return impl;
}

/**
 * Register channel implementations on first use.
 *
 * Memoized as a promise, not guarded by a boolean: setting a flag before awaiting the
 * dynamic import lets a second concurrent caller return early and read an empty
 * registry. That exact bug shipped once already (ENG-300).
 */
let bootstrapPromise: Promise<void> | null = null;

export async function bootstrapMessagingChannels(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const [{ slackChannelAdapter }, { whatsappChannelAdapter }] = await Promise.all([
        import('./slackChannelAdapter'),
        import('./whatsappChannelAdapter'),
      ]);
      registerMessagingChannel('slack', slackChannelAdapter);
      registerMessagingChannel('whatsapp', whatsappChannelAdapter);
    })().catch((error) => {
      // Don't cache a failed bootstrap — let the next caller retry.
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Slack treats `<`, `>` and `&` as control characters. Text that reaches a customer
 * channel is frequently user-authored — anyone can file a public Featurebase post —
 * so an unescaped title can smuggle a `<!channel>` broadcast or a `<url|label>`
 * disguised link into a SHARED customer channel. This is `shipNotifyService`'s
 * `escapeSlackText`, hoisted so every channel-routed caller gets it.
 */
const escapeSlackText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * WhatsApp renders plain text, so Slack's entity escaping would show the customer a
 * literal "&lt;". What it does need stripping is invisible characters: zero-width
 * spaces and bidi overrides can hide or visually reverse text in a message the
 * recipient is being asked to act on.
 */
const sanitizeWhatsAppText = (s: string): string =>
  // U+200B-U+200F zero-width/directional marks, U+2028/2029 line separators,
  // U+202A-U+202E bidi embedding/override, U+2066-U+2069 isolates, U+FEFF BOM.
  s.replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');

/** Apply the escaping/sanitizing a given channel needs to untrusted text. */
export function formatForChannel(text: string, channel: MessagingChannel): string {
  return channel === 'slack' ? escapeSlackText(text) : sanitizeWhatsAppText(text);
}

// ── Per-user channel configuration ─────────────────────────────────────────

export interface UserMessagingChannelConfig {
  channel: MessagingChannel;
  /** Channel id (Slack) or E.164 phone (WhatsApp). */
  destination: string;
  enabled: boolean;
  /**
   * Required before the first outbound message on channels where `requiresOptIn`.
   * `at` is when the person acknowledged consent; `verifiedAt` is when they proved
   * they control the number (WhatsApp: by messaging us a one-time code). A channel in
   * `VERIFIED_OPT_IN_CHANNELS` is not messaged without `verifiedAt`.
   */
  optIn?: { at: string; source: string; verifiedAt?: string };
}

/** The slice of the user record this module reads. */
export interface ChannelUser {
  slackChannel?: string;
  slackChannels?: string[];
  messagingChannels?: UserMessagingChannelConfig[];
  orgId?: string;
}

/**
 * Read-time normalization of a user's channel configuration.
 *
 * Deliberately no migration and no backfill: `messagingChannels` is additive, and the
 * legacy `slackChannel` / `slackChannels` fields are folded in on read. This is what
 * ENG-266 did for `senderProvider`, and it keeps the change outside CLAUDE.md's
 * database/data-plane approval gate while leaving every existing reader working.
 *
 * Precedence: an explicit `messagingChannels` entry wins over the legacy fields for
 * the SAME channel. Legacy Slack still surfaces alongside an explicit WhatsApp entry,
 * so configuring WhatsApp never silently drops a user's existing Slack routing.
 */
export function normalizeUserChannels(
  user: ChannelUser | null | undefined,
): UserMessagingChannelConfig[] {
  if (!user) return [];

  const explicit = (Array.isArray(user.messagingChannels) ? user.messagingChannels : [])
    .filter(
      (c): c is UserMessagingChannelConfig =>
        !!c && isMessagingChannel(c.channel) && typeof c.destination === 'string' && !!c.destination,
    )
    .map((c) => ({ ...c, enabled: c.enabled !== false }));

  if (explicit.some((c) => c.channel === 'slack')) return explicit;

  // `slackChannels` supersedes the deprecated singular `slackChannel`.
  const legacySlack = (user.slackChannels?.length ? user.slackChannels : [user.slackChannel])
    .filter((d): d is string => typeof d === 'string' && !!d)
    .map((destination) => ({ channel: 'slack' as const, destination, enabled: true }));

  return [...explicit, ...legacySlack];
}

/**
 * The channels a user has EXPLICITLY configured, with nothing inferred.
 *
 * Every WRITE path must start from this, never from `normalizeUserChannels`, which
 * folds the legacy slackChannel / slackChannels fields in. Persisting that would copy
 * the user's current Slack destination into an explicit entry, and an explicit entry
 * outranks the legacy field — freezing their Slack routing at whatever it happened to
 * be the day they configured a second channel.
 */
export function explicitChannels(user: ChannelUser | null | undefined): UserMessagingChannelConfig[] {
  return (Array.isArray(user?.messagingChannels) ? user!.messagingChannels! : []).filter(
    (c) => !!c && typeof c.channel === 'string' && typeof c.destination === 'string' && !!c.destination,
  );
}

/**
 * Channels where a stored destination is not enough: the person must also have proven
 * they control it. WhatsApp is messaged from one shared business number, so a number
 * someone merely typed in — a typo, or a stranger's — would put that number's quality
 * rating at risk. Mirrors `requiresOptIn` on the channel's capability record, kept here
 * because destination resolution must not depend on the adapter registry being bootstrapped.
 */
const VERIFIED_OPT_IN_CHANNELS: ReadonlySet<MessagingChannel> = new Set(['whatsapp']);

/** True once this account has a WhatsApp number it has proven it controls. */
export function hasVerifiedWhatsApp(user: ChannelUser | null | undefined): boolean {
  return normalizeUserChannels(user).some(
    (c) => c.channel === 'whatsapp' && c.enabled && !!c.optIn?.verifiedAt,
  );
}

/**
 * The one platform-wide answer to "where does this user receive messages on channel X".
 *
 * Channel-neutral successor to `slackService.getEffectiveAllowedChannels`, preserving
 * its resolution order for Slack: personal config → the org record → the org owner's
 * config (channels are typically stored on the owner's user record, not the org's).
 *
 * Returns null rather than throwing. Every caller is a notification path where a
 * missing destination must degrade to the email baseline, never take down the send.
 */
export async function resolveDestination(
  user: (ChannelUser & Record<string, unknown>) | null | undefined,
  channel: MessagingChannel,
): Promise<string | null> {
  try {
    // One platform per customer (ENG-273). An account with a verified WhatsApp number IS on
    // WhatsApp, and is not delivered to on Slack — neither through a channel of its own nor
    // one inherited from its organisation. Connecting a second platform is refused up front
    // wherever it can be asked for, but two can still come to coexist after the fact (an
    // organisation gains a channel, its owner is assigned one, a WhatsApp user joins it, or
    // an account predates the rule). Settling it here, in the one place every send resolves
    // through, means none of those can produce a double delivery, and the account is on the
    // same platform everywhere — including the admin screens, which report WhatsApp first.
    if (channel === 'slack' && hasVerifiedWhatsApp(user)) return null;

    const personal = normalizeUserChannels(user).find(
      (c) =>
        c.channel === channel &&
        c.enabled &&
        // An unverified entry resolves to nothing rather than to a number we are not
        // yet sure belongs to this person.
        (!VERIFIED_OPT_IN_CHANNELS.has(channel) || !!c.optIn?.verifiedAt),
    );
    if (personal) return personal.destination;

    // Org fallback is Slack-only: an org-wide Slack channel is a shared room, whereas a
    // phone number belongs to one person and must never be inherited from the org.
    if (channel !== 'slack' || !user?.orgId) return null;

    const { userDb, orgDb } = await import('./db');
    const org = await orgDb.getOrgById(user.orgId);
    if (org?.slackChannel) return org.slackChannel;

    if (org?.ownerUserId) {
      const owner = await userDb.getUserById(org.ownerUserId);
      const ownerChannel = normalizeUserChannels(owner).find(
        (c) => c.channel === channel && c.enabled,
      );
      if (ownerChannel) return ownerChannel.destination;
    }
    return null;
  } catch (e) {
    console.warn(
      `[messagingChannel] resolving ${channel} destination failed:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
