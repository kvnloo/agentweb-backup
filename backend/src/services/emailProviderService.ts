import { getAccountsWithOwnerIncludingOrgShared } from './connectedAccountsDb';

// ── Shared email result types ──────────────────────────────────────────────
// These live here, not in a provider implementation. They used to be imported
// from gmailService, which made the provider-agnostic module depend on one
// concrete provider — that does not survive a second provider (ENG-302).
// gmailService re-exports them, so existing importers keep working.

export interface EmailSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  /**
   * The sender's own Date header. Display-grade only: it is set by whoever sent
   * the message, so a wrong or deliberately-skewed clock lands here verbatim.
   * Never order or trust a freshness decision on it — use `receivedAt`.
   */
  date: string;
  /**
   * When the PROVIDER received the message (Gmail internalDate, Outlook
   * receivedDateTime), ISO 8601. Server-stamped, so a sender cannot move it.
   * Optional because a provider may not supply one; fall back to `date` only
   * where being wrong is harmless.
   */
  receivedAt?: string;
  snippet: string;
}

export interface EmailDetail extends EmailSummary {
  to: string;
  body: string;
  hasAttachments: boolean;
}

/** Result for each entry in a batch get — either full detail or a per-message error. */
export type EmailBatchResult = EmailDetail | { id: string; error: string };

// ── Provider errors ────────────────────────────────────────────────────────

/**
 * Base class for every email provider's user-facing errors.
 *
 * Callers used to enumerate the Gmail error classes by name, which meant a second
 * provider's errors silently fell through to the generic handler. Catch this
 * instead — new providers are then covered for free.
 */
export class EmailProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

// ── Shared send types ──────────────────────────────────────────────────────

/**
 * Parameters for sending through a customer's connected mailbox (Gmail / Outlook).
 *
 * Note what is NOT here: there is no `from`. The provider sends as the authenticated
 * mailbox, so a caller-supplied From would be silently discarded on the wire — which is
 * why a mailbox sender's address is validated at save time instead (crmSenderService).
 *
 * resendService has its own, deliberately different `ResendSendParams` (ENG-302): Resend
 * relays on our behalf and therefore DOES need an explicit `from`, carries `html` and
 * `text` separately, and means something different by "reply to".
 */
export interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyToMessageId?: string; // provider-native message handle (NOT an RFC Message-ID)
  isHtml?: boolean;          // true = text/html body, false (default) = text/plain
}

export interface SentEmailResult {
  messageId: string;
  threadId: string;
}

// ── Provider interface ─────────────────────────────────────────────────────

export interface IEmailService {
  searchEmails(userId: string, accountId: string, query: string, maxResults: number): Promise<EmailSummary[]>;
  listEmails(userId: string, accountId: string, folder: string, maxResults: number): Promise<EmailSummary[]>;
  getEmails(userId: string, accountId: string, messageIds: string[]): Promise<EmailBatchResult[]>;
  sendEmail(userId: string, accountId: string, params: SendEmailParams): Promise<SentEmailResult>;
}

// ── Supported email platforms ──────────────────────────────────────────────

export type EmailPlatform = 'gmail' | 'outlook';

export const EMAIL_PLATFORMS: EmailPlatform[] = ['gmail', 'outlook'];

// ── Provider registry ──────────────────────────────────────────────────────

const providerRegistry = new Map<EmailPlatform, IEmailService>();

export function registerEmailProvider(platform: EmailPlatform, service: IEmailService): void {
  providerRegistry.set(platform, service);
}

export function getEmailProvider(platform: string): IEmailService {
  const provider = providerRegistry.get(platform as EmailPlatform);
  if (!provider) {
    throw new Error(
      `No email provider registered for platform "${platform}". ` +
      `Supported platforms: ${[...providerRegistry.keys()].join(', ')}`
    );
  }
  return provider;
}

// ── Account resolution ────────────────────────────────────────────────────

export interface ResolvedEmailAccount {
  platform: EmailPlatform;
  provider: IEmailService;
  accountId: string;
  /**
   * The member whose record OWNS this mailbox — the caller for their own
   * account, a teammate for one shared with the org.
   *
   * Every provider call must be made with THIS id, not the caller's: the OAuth
   * tokens live in the owner's record, so the caller's id fails the lookup one
   * level down, and a refreshed token written under the caller would leave the
   * owner's stale forever (see getAccountsWithOwnerIncludingOrgShared).
   */
  ownerUserId: string;
}

/**
 * Every email account the caller can reach — their own plus any an org teammate
 * shared — tagged with its owner.
 *
 * This is the same set list_connected_accounts reports. Resolution used to read
 * the caller's own record only, so an org-shared mailbox was listed as active
 * and then rejected as "not found" by the very tools the list points at, and a
 * scheduled run needing a login code from it had nowhere to go (ENG-943).
 */
/**
 * The lookup itself, with its failures made honest.
 *
 * The lookup this replaced (getAccountById) caught its own DynamoDB errors and
 * returned null, so a transient failure arrived as "not found" — a lie that
 * sends the caller hunting for a bad account id, which is the exact confusion
 * ENG-943 was filed about. This one lets the failure through, but as an
 * EmailProviderError: the tool layer only converts that type (and two message
 * substrings) into a clean tool error, so an unwrapped DynamoDB error would
 * escape as a raw exception instead.
 */
async function listAccessibleAccounts(userId: string) {
  try {
    return (await getAccountsWithOwnerIncludingOrgShared(userId)) || [];
  } catch (error: any) {
    throw new EmailProviderError(
      `Could not read your connected accounts just now (${error?.message || 'unknown error'}). ` +
        `This is a temporary lookup failure, not a missing account — please retry.`
    );
  }
}

async function accessibleEmailAccounts(userId: string) {
  const accounts = await listAccessibleAccounts(userId);
  return accounts.filter(acc => EMAIL_PLATFORMS.includes(acc.platform as EmailPlatform));
}

/**
 * What the caller intends to do with the mailbox.
 *
 * Reading a teammate's org-shared mailbox and SENDING mail as them are different
 * acts, and only the first is in scope here. Org sharing arrived as "share CRM
 * across org members, keep other assets private" and has been extended one
 * platform at a time ever since; mail resolution predates the whole feature, so
 * sending as a teammate was never granted — the exact-same caller-scoped lookup
 * that caused ENG-943 also happened to block it. Restoring reads must not hand
 * over send-as-a-teammate by accident, so writes stay own-mailbox only. ENG-943
 * reports only reads, so the bug is fully fixed either way.
 */
export type EmailOperation = 'read' | 'send';

/**
 * Resolve a connected account and return its platform + provider + owner.
 * Throws a descriptive error if the account isn't found, isn't an email platform,
 * or is a teammate's mailbox being resolved for a send.
 */
export async function resolveEmailAccount(
  userId: string,
  accountId: string,
  operation: EmailOperation = 'read'
): Promise<ResolvedEmailAccount> {
  const accounts = await listAccessibleAccounts(userId);
  const sameId = accounts.filter(acc => acc.account_id === accountId);

  // Prefer an email platform rather than taking the first id match: one Google
  // account connected for both Gmail and Drive carries the same address as
  // account_id on both, and picking Drive would reject a perfectly good mailbox
  // as "not an email account".
  const account = sameId.find(acc => EMAIL_PLATFORMS.includes(acc.platform as EmailPlatform));
  if (!account) {
    if (sameId.length > 0) {
      throw new Error(`Account "${accountId}" is a ${sameId[0].platform} account, not an email account.`);
    }
    throw new Error(`Connected account "${accountId}" not found. Use list_connected_accounts to get valid account IDs.`);
  }

  // Say plainly that the mailbox exists and is reachable but not for this
  // operation. Reusing the "not found" message here would send the caller (and
  // the LLM) hunting for a bad account id, which is the confusion ENG-943 was
  // filed about in the first place.
  // EmailProviderError, not a bare Error: the tool layer converts that type into a
  // clean tool error, while an untyped one falls through its string checks and is
  // rethrown as a raw exception.
  if (operation === 'send' && account.userId !== userId) {
    throw new EmailProviderError(
      `Account "${accountId}" belongs to a teammate and is shared with your organization for reading only. ` +
        `Send from your own connected mailbox, or ask its owner to send.`
    );
  }

  const platform = account.platform as EmailPlatform;
  const provider = getEmailProvider(platform);
  return { platform, provider, accountId, ownerUserId: account.userId };
}

/**
 * Re-verify a resolved mailbox immediately before the provider is called.
 *
 * Sharing is checked when the mailbox is resolved, and the provider is then
 * called with the OWNER's credentials — which stay valid whether or not sharing
 * is still on. This narrows the gap between the two by re-checking at the last
 * point before use.
 *
 * It does not close it, and nothing at this layer can: revoking an org share
 * withdraws our authorization, not the OAuth grant, so any check we make sits in
 * front of a credential that still works. Closing it properly means invalidating
 * or re-scoping the owner's token when sharing is turned off — a change to the
 * sharing feature itself, not to these read paths.
 *
 * The caller's own mailbox cannot be un-shared from under them, so it is never
 * re-checked and pays nothing.
 */
export async function assertStillAccessible(
  callerUserId: string,
  resolved: ResolvedEmailAccount,
  operation: EmailOperation = 'read'
): Promise<void> {
  if (resolved.ownerUserId === callerUserId) return;

  // Throws if the mailbox is no longer reachable at all.
  const recheck = await resolveEmailAccount(callerUserId, resolved.accountId, operation);

  // Still reachable but under a different owner ⇒ not the mailbox we were
  // authorised for.
  if (recheck.ownerUserId !== resolved.ownerUserId) {
    throw new EmailProviderError(
      `Access to mailbox "${resolved.accountId}" changed while this request was in flight. Retry.`
    );
  }
}

/**
 * Pick a mailbox for a caller who didn't name one, in EMAIL_PLATFORMS order and
 * preferring the caller's own account over a teammate's shared one. Null when
 * the caller can reach no mailbox at all.
 *
 * Takes the same operation as resolveEmailAccount, and for the same reason: a
 * teammate's org-shared mailbox is readable but not send-from. Only
 * read_verification_code auto-resolves today, so nothing currently reaches this
 * with 'send' — but leaving the restriction in the named path alone would hand
 * the first future send caller exactly what the named path refuses, silently.
 * A send with no own mailbox returns null rather than throwing, because callers
 * of this path already have to handle "no mailbox" and a shared one is, for a
 * send, no mailbox.
 */
export async function resolveDefaultEmailAccount(
  userId: string,
  operation: EmailOperation = 'read'
): Promise<ResolvedEmailAccount | null> {
  const accessible = await accessibleEmailAccounts(userId);
  const accounts = operation === 'send'
    ? accessible.filter(acc => acc.userId === userId)
    : accessible;

  for (const platform of EMAIL_PLATFORMS) {
    const onPlatform = accounts.filter(acc => acc.platform === platform);
    const account = onPlatform.find(acc => acc.userId === userId) ?? onPlatform[0];
    if (account) {
      return {
        platform,
        provider: getEmailProvider(platform),
        accountId: account.account_id,
        ownerUserId: account.userId,
      };
    }
  }

  return null;
}

// ── Lazy provider bootstrap ───────────────────────────────────────────────
// Register providers on first use (avoids circular imports at module load).
//
// The promise is memoized rather than guarded by a boolean: the previous version
// set `bootstrapped = true` BEFORE awaiting the dynamic import, so a second
// concurrent caller returned immediately and then read an empty registry (ENG-300).

let bootstrapPromise: Promise<void> | null = null;

export async function bootstrapEmailProviders(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const [{ gmailService }, { outlookService }] = await Promise.all([
        import('./gmailService'),
        import('./outlookService'),
      ]);
      registerEmailProvider('gmail', gmailService);
      registerEmailProvider('outlook', outlookService);
    })().catch((error) => {
      // Don't cache a failed bootstrap — let the next caller retry.
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}
