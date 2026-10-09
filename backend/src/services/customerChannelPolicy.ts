/**
 * One messaging platform per customer (ENG-273).
 *
 * A customer is onboarded on Slack OR on WhatsApp — never both. The two are separate
 * features, and running both for one account means every notification and every
 * approval arrives twice, in two places that cannot see each other's answers.
 *
 * This file is the single definition of "which platform is this customer on". Every
 * path that connects a customer to a platform asks it first:
 *
 *   Slack     — admin assigns a channel, the `link this channel` command, Slack Connect
 *               provisioning at onboarding, or membership of an org that has a channel
 *   WhatsApp  — the customer verifies a number
 *
 * Fails toward refusing a second connection, not toward allowing it.
 */
import { normalizeUserChannels, resolveDestination } from './messagingChannelService';

export type CustomerPlatform = 'slack' | 'whatsapp';

const LABEL: Record<CustomerPlatform, string> = { slack: 'Slack', whatsapp: 'WhatsApp' };

export class PlatformConflictError extends Error {
  readonly connected: CustomerPlatform;
  readonly requested: CustomerPlatform;
  constructor(connected: CustomerPlatform, requested: CustomerPlatform) {
    super(
      `This account is already connected to ${LABEL[connected]}. An account can use one ` +
        `messaging platform, so disconnect ${LABEL[connected]} before connecting ${LABEL[requested]}.`,
    );
    this.name = 'PlatformConflictError';
    this.connected = connected;
    this.requested = requested;
  }
}

/** A WhatsApp number counts only once the customer has proven they control it. */
export function hasWhatsApp(user: any): boolean {
  return normalizeUserChannels(user).some(
    (c) => c.channel === 'whatsapp' && c.enabled && !!c.optIn?.verifiedAt,
  );
}

/**
 * Slack counts in every form it takes: an assigned or linked channel, an org's shared
 * channel the account inherits, or a Slack Connect channel provisioned at onboarding
 * (stored separately and not used for sending, but it IS the customer being on Slack).
 */
export async function hasSlack(user: any): Promise<boolean> {
  if (!user) return false;
  if (user.slackConnectChannelId && user.slackConnectStatus === 'created') return true;
  return !!(await resolveDestination(user, 'slack'));
}

/** The platform this customer is on, or null if they have not connected either. */
export async function getConnectedPlatform(user: any): Promise<CustomerPlatform | null> {
  if (!user) return null;
  if (hasWhatsApp(user)) return 'whatsapp';
  if (await hasSlack(user)) return 'slack';
  return null;
}

/**
 * Throws PlatformConflictError if connecting `requested` would put the customer on two
 * platforms. Re-connecting the platform they are already on is always allowed.
 */
export async function assertCanConnect(user: any, requested: CustomerPlatform): Promise<void> {
  const other: CustomerPlatform = requested === 'slack' ? 'whatsapp' : 'slack';
  const onOther = other === 'whatsapp' ? hasWhatsApp(user) : await hasSlack(user);
  if (onOther) throw new PlatformConflictError(other, requested);
}
