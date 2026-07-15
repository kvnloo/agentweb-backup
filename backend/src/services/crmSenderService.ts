/**
 * Read, normalize, validate and persist CRM outbound senders.
 *
 * Every reader of the `crm_sender_emails_${userId}` setting must go through
 * loadSenderConfig() so legacy records are normalized in exactly one place.
 * There is deliberately no backfill script: old and new shapes coexist, old
 * records upgrade the next time they are saved, and a rollback needs no data
 * migration.
 */

import { settingsService } from './settingsService';
import {
  CrmSender,
  CrmSenderConfig,
  MAILBOX_PROVIDERS,
  PROVIDER_TO_PLATFORM,
  SenderProvider,
  isMailboxSender,
} from './crmSenderTypes';

const ALL_PROVIDERS: SenderProvider[] = ['resend', 'gmail', 'outlook'];

export const senderSettingName = (userId: string) => `crm_sender_emails_${userId}`;

/**
 * Thrown when a mailbox-backed sender reaches a send path that cannot honour it.
 *
 * As of ENG-266 Part 3, the campaign/sequence/drip paths route mailbox senders
 * through their real provider instead of refusing them — this error is now only
 * reachable from a future or un-migrated send path that still hardcodes Resend.
 */
export class MailboxSenderNotSupportedError extends Error {
  public readonly provider: SenderProvider;
  public readonly senderId: string;

  constructor(sender: Pick<CrmSender, 'senderProvider' | 'id'>) {
    super(
      `This sender uses a connected ${sender.senderProvider} mailbox, which this send path ` +
        `cannot use yet. Pick a custom-domain sender, or send from Emma chat.`,
    );
    this.name = 'MailboxSenderNotSupportedError';
    this.provider = sender.senderProvider;
    this.senderId = sender.id;
  }
}

/** Normalize one persisted sender record (legacy or current) into a CrmSender. */
export function normalizeSender(raw: any): CrmSender {
  const persisted = raw?.senderType;
  const senderProvider: SenderProvider = ALL_PROVIDERS.includes(persisted) ? persisted : 'resend';

  return {
    id: raw?.id,
    email: raw?.email,
    fromName: raw?.fromName,
    notes: raw?.notes,
    senderProvider,
    // `gmailAccountId` is the pre-Outlook key. Prefer the neutral one when both exist.
    connectedAccountId: raw?.connectedAccountId ?? raw?.gmailAccountId,
  };
}

export function normalizeSenderConfig(raw: any): CrmSenderConfig {
  const senders = Array.isArray(raw?.senders) ? raw.senders.map(normalizeSender) : [];
  return {
    senders,
    defaultSenderId: raw?.defaultSenderId ?? null,
    defaultLinkedInAccountId: raw?.defaultLinkedInAccountId ?? null,
  };
}

/**
 * Convert a CrmSender back to its persisted shape.
 *
 * A resend sender omits `senderType` entirely, preserving the legacy
 * "absence means Resend" discriminant so older code can still read it.
 * A gmail sender also dual-writes `gmailAccountId`, so a rollback to the
 * pre-Outlook code still resolves the account.
 */
export function serializeSender(sender: CrmSender): any {
  const base: any = {
    id: sender.id,
    email: sender.email,
    fromName: sender.fromName,
    notes: sender.notes,
  };

  if (!isMailboxSender(sender)) {
    return base;
  }

  base.senderType = sender.senderProvider;
  base.connectedAccountId = sender.connectedAccountId;
  if (sender.senderProvider === 'gmail') {
    base.gmailAccountId = sender.connectedAccountId;
  }
  return base;
}

export interface SenderValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate one sender against the user's connected accounts.
 *
 * The From-identity check matters more than it looks: IEmailService has no
 * `from` field, and gmailService builds its MIME headers without a `From:` line
 * — the provider stamps the authenticated mailbox. So a mismatched sender email
 * is silently ignored on the wire. Rejecting at save time is the only place we
 * can tell the user the truth.
 */
export function validateSender(raw: any, connectedAccounts: any[]): SenderValidationResult {
  const provider = raw?.senderType;

  if (provider !== undefined && !ALL_PROVIDERS.includes(provider)) {
    return { ok: false, error: `Invalid senderType: ${provider}` };
  }

  if (provider === undefined || provider === 'resend') {
    return { ok: true };
  }

  const connectedAccountId = raw?.connectedAccountId ?? raw?.gmailAccountId;
  if (!connectedAccountId) {
    return { ok: false, error: `${provider} senders must include a connectedAccountId` };
  }

  const platform = PROVIDER_TO_PLATFORM[provider];
  const account = (connectedAccounts || []).find(
    (a: any) => a?.account_id === connectedAccountId && a?.platform === platform,
  );
  if (!account) {
    return { ok: false, error: `Connected ${provider} account "${connectedAccountId}" not found` };
  }

  const mailbox = (account?.config?.email || account?.account_id || '').toLowerCase();
  const claimed = String(raw?.email || '').toLowerCase();
  if (mailbox && claimed !== mailbox) {
    return {
      ok: false,
      error:
        `A ${provider} sender's email must match the connected mailbox (${mailbox}). ` +
        `${provider} sends as the authenticated account, so "${raw?.email}" would be ignored.`,
    };
  }

  return { ok: true };
}

/**
 * Guard for a bulk send path that still hardcodes Resend.
 *
 * As of ENG-266 Part 3, the campaign/sequence/drip send sites resolve a sender
 * via resolveSenderForSend() and call sendAsSender() instead of guarding this
 * way — they route by provider now, they don't refuse. This stays exported for
 * any future or un-migrated send path that still only knows how to talk to
 * Resend.
 */
export function assertSenderUsableForBulkSend(sender: CrmSender): void {
  if (isMailboxSender(sender)) {
    throw new MailboxSenderNotSupportedError(sender);
  }
}

/**
 * Guard for bulk send routes that only receive a bare `senderEmail`.
 *
 * The campaign composer discards the sender's provider before posting, so these
 * routes cannot tell a Resend sender from a connected mailbox. Resolve the email
 * back to the configured sender and report whether the send must be refused.
 *
 * Returns an error message to surface to the user, or null if the send may proceed.
 *
 * As of ENG-266 Part 3, the crm.ts/sequences.ts send sites use
 * resolveSenderForSend() + sendAsSender() instead — they route by provider now.
 * This stays exported for any future or un-migrated send path that only
 * receives a bare address and still only knows how to talk to Resend.
 */
export async function bulkSendGuardMessage(
  userId: string,
  senderEmail: string,
  senderId?: string,
): Promise<string | null> {
  const config = await loadSenderConfig(userId);

  // Preferred path: the caller told us WHICH sender. No ambiguity — resolve it exactly.
  if (senderId) {
    const sender = config.senders.find((s) => s.id === senderId);
    if (!sender) {
      return null; // unknown id — the route's own validation owns this case
    }
    try {
      assertSenderUsableForBulkSend(sender);
      return null;
    } catch (error: any) {
      return error.message;
    }
  }

  // Fallback: older clients post only the address. One address can legitimately have BOTH
  // a mailbox sender and a custom-domain sender on it (a Google Workspace address whose
  // domain is also verified in Resend), and from the address alone we cannot tell which the
  // user picked. Refusing would break a configuration that works today, so only refuse when
  // EVERY sender on that address is mailbox-backed — i.e. when there is no way this send
  // could have gone via Resend anyway.
  const needle = String(senderEmail || '').toLowerCase();
  const matches = config.senders.filter((s) => s.email?.toLowerCase() === needle);

  if (matches.length === 0) {
    return null; // not a configured sender (e.g. an ad-hoc address) — leave behaviour alone
  }
  if (matches.some((s) => !isMailboxSender(s))) {
    return null;
  }

  return new MailboxSenderNotSupportedError(matches[0]).message;
}

/**
 * Resolve the exact CrmSender a send should use — the ENG-266 Part 3 counterpart
 * to bulkSendGuardMessage, returning the sender itself instead of a refusal.
 *
 * Preferred path: senderId, resolved exactly. Fallback for older clients that only
 * post an address: match by email (case-insensitively); if that address is
 * ambiguous (a Workspace address that is both a mailbox sender and a verified
 * Resend custom domain), prefer the resend sender — same ambiguity handling
 * bulkSendGuardMessage already uses, now for full resolution.
 */
export async function resolveSenderForSend(
  userId: string,
  senderId: string | undefined,
  senderEmail: string,
): Promise<CrmSender | null> {
  const config = await loadSenderConfig(userId);

  if (senderId) {
    return config.senders.find((s) => s.id === senderId) ?? null;
  }

  const needle = String(senderEmail || '').toLowerCase();
  const matches = config.senders.filter((s) => s.email?.toLowerCase() === needle);
  if (matches.length === 0) {
    return null;
  }

  return matches.find((s) => !isMailboxSender(s)) ?? matches[0];
}

/** The one loader. Every reader of the sender blob goes through this. */
export async function loadSenderConfig(userId: string): Promise<CrmSenderConfig> {
  const setting = await settingsService.getSetting(senderSettingName(userId));
  if (!setting?.settingValue) {
    return { senders: [], defaultSenderId: null, defaultLinkedInAccountId: null };
  }
  try {
    return normalizeSenderConfig(JSON.parse(setting.settingValue));
  } catch (error) {
    console.error('Error parsing CRM sender emails:', error);
    return { senders: [], defaultSenderId: null, defaultLinkedInAccountId: null };
  }
}

export { MAILBOX_PROVIDERS, isMailboxSender };
export type { CrmSender, CrmSenderConfig, SenderProvider };
