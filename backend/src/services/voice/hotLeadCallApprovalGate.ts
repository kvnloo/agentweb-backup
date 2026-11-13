/**
 * Human approval for the hot-lead-call tools that spend money or end calling (ENG-2613, ENG-2271).
 *
 * Buying a number starts a monthly charge, releasing one ends calling and turning calling on lets calls be
 * billed per minute, so none of them runs on a model's say-so. The tool first halts with a one-question approval
 * card (the same deck-of-one mechanism the CRM sequence activation gate uses, see crmSequenceActivationGate.ts)
 * and only acts when the person in the chat has clicked "approve" on that exact card.
 *
 * What an approval is bound to: a digest over the action, organization, user, chat session, the parameters (area
 * code, the number being released, or the settings change that turns calling on), the price as it is quoted now
 * (monthly rent, per-minute rate or the flat add-on price), and the revision of the stored hot lead call settings. A change to any of
 * them makes an earlier approval stop matching.
 *
 * An approval is valid only when it
 *   - was given by the user ('user'; "Let Emma decide" is not offered and a delegation never counts),
 *   - is the newest card for this digest,
 *   - says "approve",
 *   - was answered at most APPROVAL_TTL_MS ago, and
 *   - has not been used yet (the caller claims it once, immediately before acting).
 *
 * Pure module: no network, no storage. The caller reads the session and its messages and does the claim.
 */

import { createHash, randomBytes } from 'crypto';
import {
  findAnsweredDeckItemByKind,
  type ApprovalDeckHistoryMessage,
  type QuestionDeckQuestionInput,
} from '../agentMode/core/approvalDeck';
import type { GateOutcome } from '../crmSequenceActivationGate';
import type { AskUserQuestionOption } from '../agentMode/core/askUserQuestion';

export type HotLeadCallApprovalAction = 'provision' | 'release' | 'enable';

/** Card kinds starting with this are written only by this module; ask_user_question refuses them. */
export const APPROVAL_KIND_RESERVED_PREFIX = 'hot_lead_call_approval:';
export const APPROVE_OPTION_ID = 'approve';
export const DECLINE_OPTION_ID = 'decline';
export const APPROVAL_TTL_MS = 15 * 60_000;
/** Prefix of the entries written into the session's single-use map. */
export const CONSUMED_KEY_PREFIX = 'hotlead:';

const CLOCK_SKEW_MS = 60_000;

export interface ApprovalDigestInput {
  action: HotLeadCallApprovalAction;
  orgId: string;
  userId: string;
  sessionId: string;
  /** Area code (provision, may be empty), the sid of the number being released, or the settings change that turns calling on. */
  target: string | null;
  /** The price as quoted to the user now: the monthly rent ("$1.15 per month") or the call rate ("$0.014 per minute"). */
  priceText: string;
  /** hotLeadCallRevisionOf(org.hotLeadCall) */
  revision: string;
}

export function computeApprovalDigest(input: ApprovalDigestInput): string {
  const material = {
    v: 1,
    action: input.action,
    orgId: input.orgId,
    userId: input.userId,
    sessionId: input.sessionId,
    target: input.target,
    priceText: input.priceText,
    revision: input.revision,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function approvalKindPrefix(action: HotLeadCallApprovalAction, digest: string): string {
  return `${APPROVAL_KIND_RESERVED_PREFIX}${action}:${digest}:`;
}

export function newApprovalKind(action: HotLeadCallApprovalAction, digest: string): string {
  return approvalKindPrefix(action, digest) + randomBytes(8).toString('hex');
}

/**
 * The card kind without its nonce, or null for a kind this module did not write. Two cards with the same identity
 * ask the same question about the same change, so a reply that produced both needs to show only one.
 */
export function approvalCardIdentity(kind: unknown): string | null {
  return typeof kind === 'string' && kind.startsWith(APPROVAL_KIND_RESERVED_PREFIX) ? kind.slice(0, kind.lastIndexOf(':') + 1) : null;
}

export function consumedKeyOf(kind: string): string {
  return `${CONSUMED_KEY_PREFIX}${kind}`;
}

export interface AttendedFacts<S extends { sessionType?: string }> {
  unattended?: boolean;
  /** Support or an admin acting as the customer. */
  delegated?: boolean;
  sessionId?: unknown;
  /** The session record read fresh from storage; null/undefined = unknown. */
  session?: S | null;
}

/** Who may be asked at all. Fails closed on anything it cannot establish. */
export function checkAttendedForApproval<S extends { sessionType?: string }>(
  facts: AttendedFacts<S>,
): Extract<GateOutcome, { allowed: false }> | { allowed: true; sessionId: string; session: S } {
  if (facts.unattended === true) {
    return { allowed: false, code: 'unattended', reason: 'This needs a person to confirm in an interactive chat' };
  }
  if (facts.delegated === true) {
    return {
      allowed: false,
      code: 'delegated',
      reason: 'This spends the customer\'s money, so it can only be approved by the customer in their own chat, not while acting on their behalf.',
    };
  }
  if (typeof facts.sessionId !== 'string' || !facts.sessionId) {
    return { allowed: false, code: 'no_session', reason: 'This needs an attended chat session so a person can approve it; none was identified.' };
  }
  if (!facts.session) {
    return { allowed: false, code: 'session_unknown', reason: 'This session could not be read, so it cannot be confirmed as attended. Nothing was done.' };
  }
  if (facts.session.sessionType === 'scheduled') {
    return { allowed: false, code: 'scheduled', reason: 'This needs a person to confirm in an interactive chat, not a scheduled run.' };
  }
  return { allowed: true, sessionId: facts.sessionId, session: facts.session };
}

/** What the enable card tells the person about the limits that bound the spend, from the settings about to be saved. */
export interface EnableLimits {
  maxCallsPerHour: number;
  maxCallsPerDay: number;
  maxCallsPerMonth: number;
  maxAttemptsPerLead: number;
  callingHours?: { start: string; end: string; timezone: string };
}

export type ApprovalQuestionInput = { kind: string; priceText: string } & (
  | {
    action: 'provision';
    areaCode?: string;
    /** The rent is included in the flat hot lead calls add-on, so the card says so (the rent itself is still quoted as a cost fact). */
    coveredByAddon?: boolean;
  }
  | { action: 'release'; number?: string }
  | {
    action: 'enable';
    /** Caller number calls are placed from, as shown to the person. */
    number?: string;
    /** Who will be phoned, for example "Dana Lee (***0100)"; at least one. */
    members: string[];
    limits: EnableLimits;
    /** Calling comes with the paid add-on, bought on approval: the card quotes the flat price (priceText) instead of per-minute rates. */
    addon?: boolean;
  }
);

function questionText(input: ApprovalQuestionInput): string {
  switch (input.action) {
    case 'provision':
      return `Buy a phone number${input.areaCode ? ` in area code ${input.areaCode}` : ''} for hot lead calls? It costs ${input.priceText}, charged now and every month until the number is released.${input.coveredByAddon ? ' The $70 per month hot lead calls add-on includes one calling number, so this rent is part of that price.' : ' Calls placed from it are also billed per minute.'}`;
    case 'release':
      return `Release the hot lead caller number${input.number ? ` ${input.number}` : ''}? Calling is turned off, the number goes back to the phone provider and cannot be recovered, and a new one may be a different number that costs ${input.priceText}.`;
    case 'enable': {
      if (input.members.length === 0) throw new Error('The enable card needs the people who will be phoned');
      const { limits } = input;
      const hours = limits.callingHours ? `, only ${limits.callingHours.start}-${limits.callingHours.end} ${limits.callingHours.timezone}` : '';
      const billing = input.addon
        ? `This costs ${input.priceText}. Calls beyond your monthly limit are not placed.`
        : `Both calls are billed to the organization owner per minute at the current rate of ${input.priceText}, each rounded up to a whole minute.`;
      return `Turn on hot lead calling? When a lead arrives from your landing page, AgentWeb will phone ${input.members.join(', ')} from your number${input.number ? ` ${input.number}` : ''}, and then the lead. ${billing} Limits: ${limits.maxCallsPerHour} leads per hour, ${limits.maxCallsPerDay} per day, ${limits.maxCallsPerMonth} per month, at most ${limits.maxAttemptsPerLead} call attempts per lead${hours}. You can turn it off at any time.`;
    }
  }
}

const APPROVE_OPTIONS: Record<HotLeadCallApprovalAction, { label: string; consequence: (priceText: string, addon?: boolean) => string }> = {
  provision: { label: 'Buy the number', consequence: priceText => `Buys the number now and charges ${priceText} until it is released.` },
  release: { label: 'Release the number', consequence: () => 'Releases the number and turns calling off.' },
  enable: { label: 'Turn calling on', consequence: (priceText, addon) => (addon ? `Adds the add-on to your subscription (${priceText}) and starts calls for new leads now.` : `Calls start for new leads now, billed at ${priceText}.`) },
};

/**
 * The approval card. The wording is built here from live values, never from model text. "Decline" comes first
 * and is the recommended option, so any answer taken without a person choosing resolves to "do not spend".
 */
export function buildApprovalQuestion(input: ApprovalQuestionInput): QuestionDeckQuestionInput {
  const approve = APPROVE_OPTIONS[input.action];
  const options: AskUserQuestionOption[] = [
    {
      id: DECLINE_OPTION_ID,
      label: 'Decline',
      consequence: 'Nothing is bought or changed.',
      recommended: true,
      why: 'Nothing is spent or changed unless you approve.',
    },
    { id: APPROVE_OPTION_ID, label: approve.label, consequence: approve.consequence(input.priceText, input.action === 'enable' && input.addon) },
  ];
  return { question: questionText(input), options, allowEmmaDecide: false, kind: input.kind, immutable: true };
}

export type ApprovalLookup =
  | { status: 'approved'; kind: string }
  | { status: 'none'; reason: 'no_card' | 'unanswered' | 'not_human' | 'declined' | 'expired' | 'consumed' };

/**
 * Looks at the newest card for `prefix` in the session history. Only an unused, unexpired "approve" that the
 * user clicked yields 'approved'; anything else means the caller issues a fresh card.
 */
export function findApproval(
  messages: ApprovalDeckHistoryMessage[],
  prefix: string,
  now: number,
  consumedKinds: ReadonlySet<string>,
): ApprovalLookup {
  let newest: string | undefined;
  // Messages are in conversation order, so the last match is the newest card. (The CRM gate reverses first.)
  for (const message of messages) {
    for (const item of message.metadata?.approvalDeckItems ?? []) {
      if (item.kind.startsWith(prefix)) newest = item.kind;
    }
  }
  if (!newest) return { status: 'none', reason: 'no_card' };
  const outcome = findAnsweredDeckItemByKind(messages, newest);
  if (!outcome.found) return { status: 'none', reason: 'unanswered' };
  if (outcome.answer.answeredBy !== 'user') return { status: 'none', reason: 'not_human' };
  if (outcome.answer.verdict !== APPROVE_OPTION_ID) return { status: 'none', reason: 'declined' };
  const age = now - Date.parse(outcome.answer.at);
  if (!Number.isFinite(age) || age > APPROVAL_TTL_MS || age < -CLOCK_SKEW_MS) return { status: 'none', reason: 'expired' };
  if (consumedKinds.has(newest)) return { status: 'none', reason: 'consumed' };
  return { status: 'approved', kind: newest };
}
