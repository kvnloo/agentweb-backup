import { orgDb } from '../db';
import { hotLeadCallConfigOf, HOT_LEAD_CALL_LIMITS, MEMBER_ID, type HotLeadCallConfig, type HotLeadCallMember } from '../hotLeadCallConfig';
import { selectHotLeadCallCandidates } from '../hotLeadCallRoster';
import { isHotLeadCallEnabled } from './hotLeadCallMode';
import { isHotLeadCallEntitled } from './hotLeadCallEntitlement';
import { findOrgIdByCallerNumber } from './inboundNumberIndex';

/**
 * Rules of the inbound callback (ENG-2271): a lead dials the org's caller number back and the team is rung one
 * member at a time. The call is stateless; the members already tried travel in the signed URL of each step, and
 * every step re-evaluates the live config, so a switch-off or a removed member takes effect on the next step.
 */

export interface InboundContext {
  orgId: string;
  /** The org's billing owner, who is billed for the member legs. */
  ownerUserId: string;
  config: HotLeadCallConfig;
}

const E164_SHAPE = /^\+[1-9]\d{6,14}$/;

/**
 * The org that owns the dialled number with everything required to ring its team, else null (the caller hears a
 * polite refusal and nothing is connected): number unknown or ambiguous, kill switch off, config missing,
 * invalid or disabled, the number no longer the org's, or a plan that does not include hot-lead calls.
 * A failure to look any of this up propagates; the route turns it into the same refusal.
 */
export async function resolveInboundContext(dialled: string | undefined): Promise<InboundContext | null> {
  if (!dialled || !E164_SHAPE.test(dialled)) return null;
  if (!(await isHotLeadCallEnabled())) return null;
  const orgId = await findOrgIdByCallerNumber(dialled);
  if (!orgId) return null;
  // The index only locates; the org as stored right now decides.
  const org = await orgDb.getOrgById(orgId, undefined, true);
  // No owner means nobody to bill the member legs to: not served (the plan check would refuse it too).
  if (!org?.ownerUserId || org.orgId !== orgId) return null;
  const config = hotLeadCallConfigOf(org.hotLeadCall);
  if (!config?.enabled || config.twilioNumber !== dialled) return null;
  if (!(await isHotLeadCallEntitled(org))) return null;
  return { orgId, ownerUserId: org.ownerUserId, config };
}

/** A context for a later step of a callback, from the signed orgId and the number the org holds now. */
export async function resolveInboundContextForOrg(orgId: string): Promise<InboundContext | null> {
  if (!(await isHotLeadCallEnabled())) return null;
  const org = await orgDb.getOrgById(orgId, undefined, true);
  // No owner means nobody to bill the member legs to: not served (the plan check would refuse it too).
  if (!org?.ownerUserId || org.orgId !== orgId) return null;
  const config = hotLeadCallConfigOf(org.hotLeadCall);
  if (!config?.enabled || !config.twilioNumber) return null;
  if (!(await isHotLeadCallEntitled(org))) return null;
  return { orgId, ownerUserId: org.ownerUserId, config };
}

/** Parses the `tried` query: member ids, unique, at most the largest maxAttemptsPerLead. Null when it is not that. */
export function triedMembersOf(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  const ids = raw === '' ? [] : raw.split(',');
  if (ids.length > HOT_LEAD_CALL_LIMITS.maxAttemptsPerLead.max || new Set(ids).size !== ids.length) return null;
  return ids.every((id) => MEMBER_ID.test(id)) ? ids : null;
}

/**
 * The next member to ring: first by team priority among those verified, inside their window and inside the
 * calling hours right now, who were not tried yet. None once the org's maxAttemptsPerLead is reached.
 */
export function nextInboundMember(config: HotLeadCallConfig, tried: readonly string[], at: Date): HotLeadCallMember | null {
  if (tried.length >= config.maxAttemptsPerLead) return null;
  return selectHotLeadCallCandidates(config, at, tried)[0] ?? null;
}

/** Whether `memberId` may still take a callback: on the team and verified (the phone it was verified for is the stored one). */
export const isAcceptingMember = (config: HotLeadCallConfig, memberId: string | undefined): boolean =>
  !!memberId && config.team.some((m) => m.id === memberId && m.verifiedAt);
