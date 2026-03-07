import { getAccountById } from './connectedAccountsDb';
import { EmailSummary, EmailDetail, EmailBatchResult } from './gmailService';

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

export type EmailPlatform = 'gmail'; // extend as new providers are added

export const EMAIL_PLATFORMS: EmailPlatform[] = ['gmail'];

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
// Import and register Gmail provider on first use (avoids circular imports at module load)

let bootstrapped = false;

export async function bootstrapEmailProviders(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  const { gmailService } = await import('./gmailService');
  registerEmailProvider('gmail', gmailService);
}
