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
export type PlatformSource = 'account' | 'organisation' | 'slack_connect';

export interface PlatformSummary {
  platform: CustomerPlatform | null;
  source: PlatformSource | null;
  /** WhatsApp number with all but the last four digits masked. Never the full number. */
  whatsappNumberMasked: string | null;
}

const NONE: PlatformSummary = { platform: null, source: null, whatsappNumberMasked: null };

/** A WhatsApp number counts only once the customer has proven they control it. */
export function hasWhatsApp(user: any): boolean {
  return hasVerifiedWhatsApp(user);
}

function maskNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * The single answer to "which platform is this customer on, and why".
 *
 * Enforcement (assertCanConnect) and display (the admin list, the customer's Settings)
 * both read this, so what a screen shows can never disagree with what the rule allows.
 * Derived from the connection records every time rather than stored as its own field:
 * a stored "platform" would be a second copy of the truth, free to drift the first time
 * a channel was assigned or removed by a path that forgot to update it.
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

  if (normalizeUserChannels(user).some((c) => c.channel === 'slack' && c.enabled)) {
    return { platform: 'slack', source: 'account', whatsappNumberMasked: null };
  }
  if (user.slackConnectChannelId && user.slackConnectStatus === 'created') {
    return { platform: 'slack', source: 'slack_connect', whatsappNumberMasked: null };
  }

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

/** Slack in any form: assigned or linked, inherited from the org, or Slack Connect. */
export async function hasSlack(user: any): Promise<boolean> {
  if (!user) return false;
  // Judged as if the WhatsApp entry were absent: this is asked precisely when deciding
  // whether WhatsApp may be connected, and a number already on the record must not hide
  // the Slack connection it would conflict with.
  const withoutWhatsApp = {
    ...user,
    messagingChannels: (Array.isArray(user.messagingChannels) ? user.messagingChannels : []).filter(
      (c: any) => c?.channel !== 'whatsapp',
    ),
  };
  return (await getPlatformSummary(withoutWhatsApp)).platform === 'slack';
}

/** The platform this customer is on, or null if they have not connected either. */
export async function getConnectedPlatform(user: any): Promise<CustomerPlatform | null> {
  return (await getPlatformSummary(user)).platform;
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
