import { getAccountById } from './connectedAccountsDb';

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
  date: string;
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

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyToMessageId?: string; // message ID to reply to (sets thread + headers)
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

/**
 * Resolve a connected account and return its platform + provider.
 * Throws a descriptive error if the account isn't found or isn't an email platform.
 */
export async function resolveEmailAccount(
  userId: string,
  accountId: string
): Promise<{ platform: EmailPlatform; provider: IEmailService }> {
  const account = await getAccountById(accountId, userId);
  if (!account) {
    throw new Error(`Connected account "${accountId}" not found. Use list_connected_accounts to get valid account IDs.`);
  }

  const platform = account.platform as EmailPlatform;
  if (!EMAIL_PLATFORMS.includes(platform)) {
    throw new Error(`Account "${accountId}" is a ${platform} account, not an email account.`);
  }

  const provider = getEmailProvider(platform);
  return { platform, provider };
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
