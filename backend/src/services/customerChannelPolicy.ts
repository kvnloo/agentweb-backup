/**
 * One messaging platform per customer (ENG-273).
 *
 * A customer is onboarded on Slack OR on WhatsApp — never both. The two are separate
 * features, and running both for one account means every notification and every approval
 * arrives twice, in two places that cannot see each other's answers.
 *
 * This file is the single definition of "which platform is this customer on". Every path
 * that connects a customer to a platform asks it first, and the screens that display the
 * platform read the same answer, so what is shown can never disagree with what is allowed:
 *
 *   Slack     — an admin assigns a channel, or the `link this channel` command
 *   WhatsApp  — the customer verifies a number
 *
 * What counts, and what deliberately does not:
 *  - A WhatsApp number counts only once the customer has proven they control it.
 *  - Slack counts when the account has a channel OF ITS OWN (assigned, linked, or the
 *    deprecated single field).
 *  - An organisation's shared Slack channel is a default the account inherits, not a
 *    choice it made. It is reported as Slack, but it does NOT stop the account connecting
 *    WhatsApp: a verified number wins over an inherited channel in `resolveDestination`,
 *    so refusing would only trap someone in a platform they never picked — with no
 *    control anywhere to disconnect an organisation's channel from one member.
 *  - A Slack Connect channel provisioned at onboarding is a support room for talking to
 *    the team. Nothing delivers notifications to it, so it is not a platform at all.
 */
import {
  hasVerifiedWhatsApp,
  normalizeUserChannels,
  resolveDestination,
} from './messagingChannelService';

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

/** How the customer came to be on their platform — shown to admins. */
export type PlatformSource = 'account' | 'organisation';

export interface PlatformSummary {
  platform: CustomerPlatform | null;
  source: PlatformSource | null;
  /** WhatsApp number with all but the last four digits masked. Never the full number. */
  whatsappNumberMasked: string | null;
}

const NONE: PlatformSummary = { platform: null, source: null, whatsappNumberMasked: null };

/** A WhatsApp number counts only once the customer has proven they control it. */
export const hasWhatsApp = hasVerifiedWhatsApp;

/** A Slack channel the account has of its own — assigned, linked, or the deprecated field. */
export function hasOwnSlack(user: any): boolean {
  return normalizeUserChannels(user).some((c) => c.channel === 'slack' && c.enabled);
}

function maskNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * The single answer to "which platform is this customer on, and why".
 *
 * Derived from the connection records every time rather than stored as its own field: a
 * stored "platform" would be a second copy of the truth, free to drift the first time a
 * channel was assigned or removed by a path that forgot to update it.
 *
 * WhatsApp is checked first because it is the platform that wins when two are present —
 * the same order `resolveDestination` applies when it decides where to deliver.
 *
 * `orgSlackCache` lets a caller listing many accounts resolve each organisation once.
 */
export async function getPlatformSummary(
  user: any,
  orgSlackCache?: Map<string, Promise<boolean>>,
): Promise<PlatformSummary> {
  if (!user) return NONE;

  const whatsapp = normalizeUserChannels(user).find(
    (c) => c.channel === 'whatsapp' && c.enabled && !!c.optIn?.verifiedAt,
  );
  if (whatsapp) {
    return {
      platform: 'whatsapp',
      source: 'account',
      whatsappNumberMasked: maskNumber(whatsapp.destination),
    };
  }

  if (hasOwnSlack(user)) return { platform: 'slack', source: 'account', whatsappNumberMasked: null };

  if (user.orgId) {
    // Ask the real resolver, with only the org on the record, whether membership alone
    // yields a Slack channel — the same code path a send would take.
    let inherited = orgSlackCache?.get(user.orgId);
    if (!inherited) {
      inherited = resolveDestination({ orgId: user.orgId }, 'slack').then((d) => !!d);
      orgSlackCache?.set(user.orgId, inherited);
    }
    if (await inherited) {
      return { platform: 'slack', source: 'organisation', whatsappNumberMasked: null };
    }
  }
  return NONE;
}

/**
 * Throws PlatformConflictError if connecting `requested` would put the customer on two
 * platforms. Re-connecting the platform they are already on is always allowed.
 */
export async function assertCanConnect(user: any, requested: CustomerPlatform): Promise<void> {
  if (requested === 'whatsapp' && hasOwnSlack(user)) {
    throw new PlatformConflictError('slack', 'whatsapp');
  }
  if (requested === 'slack' && hasWhatsApp(user)) {
    throw new PlatformConflictError('whatsapp', 'slack');
  }
}
