/**
 * Human approval for the paid hot-lead-call number tools (ENG-2613).
 *
 * Buying a number starts a monthly charge and releasing one ends calling, so neither runs on a model's say-so.
 * The tool first halts with a one-question approval card (the same deck-of-one mechanism the CRM sequence
 * activation gate uses, see crmSequenceActivationGate.ts) and only acts when the person in the chat has
 * clicked "approve" on that exact card.
 *
 * What an approval is bound to: a digest over the action, organization, user, chat session, the parameters
 * (area code, or the number being released), the monthly rent as it is quoted now, and the revision of the
 * stored hot lead call settings. A change to any of them makes an earlier approval stop matching.
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

export type HotLeadCallApprovalAction = 'provision' | 'release';

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
  /** Area code (provision, may be empty) or the sid of the number being released. */
  target: string | null;
  /** The monthly rent as quoted to the user now, for example "$1.15 per month". */
  rentText: string;
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
    rentText: input.rentText,
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

export function consumedKeyOf(kind: string): string {
  return `${CONSUMED_KEY_PREFIX}${kind}`;
}

export interface AttendedFacts {
  unattended?: boolean;
  /** Support or an admin acting as the customer. */
  delegated?: boolean;
  sessionId?: unknown;
  /** The session record read fresh from storage; null/undefined = unknown. */
  session?: { sessionType?: string } | null;
}

/** Who may be asked at all. Fails closed on anything it cannot establish. */
export function checkAttendedForApproval(facts: AttendedFacts): GateOutcome {
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
  return { allowed: true };
}

export interface ApprovalQuestionInput {
  action: HotLeadCallApprovalAction;
  kind: string;
  rentText: string;
  areaCode?: string;
  /** Number being released, for the card text. */
  number?: string;
}

/**
 * The approval card. The wording is built here from live values, never from model text. "Decline" comes first
 * and is the recommended option, so any answer taken without a person choosing resolves to "do not spend".
 */
export function buildApprovalQuestion(input: ApprovalQuestionInput): QuestionDeckQuestionInput {
  const provision = input.action === 'provision';
  const question = provision
    ? `Buy a phone number${input.areaCode ? ` in area code ${input.areaCode}` : ''} for hot lead calls? It costs ${input.rentText}, charged now and every month until the number is released. Calls placed from it are also billed per minute.`
    : `Release the hot lead caller number${input.number ? ` ${input.number}` : ''}? Calling is turned off, the number goes back to the phone provider and cannot be recovered, and a new one may be a different number that costs ${input.rentText}.`;
  const options: AskUserQuestionOption[] = [
    {
      id: DECLINE_OPTION_ID,
      label: 'Decline',
      consequence: 'Nothing is bought or changed.',
      recommended: true,
      why: 'Nothing is spent or changed unless you approve.',
    },
    {
      id: APPROVE_OPTION_ID,
      label: provision ? 'Buy the number' : 'Release the number',
      consequence: provision ? `Buys the number now and charges ${input.rentText} until it is released.` : 'Releases the number and turns calling off.',
    },
  ];
  return { question, options, allowEmmaDecide: false, kind: input.kind, immutable: true };
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
  for (const message of messages ?? []) {
    for (const item of message?.metadata?.approvalDeckItems ?? []) {
      if (typeof item?.kind === 'string' && item.kind.startsWith(prefix)) newest = item.kind;
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
