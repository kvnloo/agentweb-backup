/**
 * Single source of truth for CRM outbound sender types.
 *
 * Historically a sender was "Gmail or not": `senderType` was either the literal
 * 'gmail' or absent, and absence meant "send via Resend from a verified custom
 * domain". Adding Outlook makes that discriminant untenable, so the provider is
 * now an explicit three-valued enum.
 *
 * The field is named `senderProvider`, not `senderType`, because `senderType`
 * already means something else in this codebase: 'SMTP' | 'resend' on
 * task-subscriber email history (see services/emailService.ts). The *persisted*
 * key stays `senderType` for backward compatibility — see crmSenderService.
 */

export type SenderProvider = 'resend' | 'gmail' | 'outlook';

/** Providers that send through a customer's own connected mailbox. */
export const MAILBOX_PROVIDERS: SenderProvider[] = ['gmail', 'outlook'];

/** Maps a mailbox sender provider onto its connected-account platform. */
export const PROVIDER_TO_PLATFORM: Record<string, string> = {
  gmail: 'gmail',
  outlook: 'outlook',
};

/** Human-readable provider names, for messages shown to users (and to the LLM). */
export const PROVIDER_LABELS: Record<string, string> = {
  resend: 'Custom domain',
  gmail: 'Gmail',
  outlook: 'Outlook',
};

export const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

export interface CrmSender {
  id: string;
  email: string;
  fromName: string;
  notes?: string;
  senderProvider: SenderProvider;
  /** Required iff senderProvider is a mailbox provider. */
  connectedAccountId?: string;
}

export interface CrmSenderConfig {
  senders: CrmSender[];
  defaultSenderId: string | null;
  defaultLinkedInAccountId: string | null;
}

export const isMailboxSender = (sender: Pick<CrmSender, 'senderProvider'>): boolean =>
  MAILBOX_PROVIDERS.includes(sender.senderProvider);
