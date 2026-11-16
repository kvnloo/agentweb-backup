/**
 * Human approval for Emma's Smartlead push tools (ENG-673).
 *
 * Adding contacts to a customer's Smartlead campaign leads to cold email being sent to real people, and releasing contacts lets AgentWeb's own
 * senders email people Smartlead is already emailing, so neither runs on a model's say-so. The tool first halts with a one-question approval card
 * (the same deck-of-one mechanism as the hot lead call number tools, see voice/hotLeadCallApprovalGate.ts) and only acts when the person in the
 * chat has clicked "approve" on that exact card. The approval stands in for the two acknowledgements the portal asks for (a lawful basis, and
 * confirming a campaign that is already sending): the card says both, in words built here, never from model text.
 *
 * What an approval is bound to: a digest over the action, user, chat session and everything the card showed (list, campaign, its status, the
 * sequence hash, the number of contacts, the field choices). A change to any of them (the list grew, the customer edited the campaign's emails,
 * the campaign was started) makes an earlier approval stop matching and a new card is issued.
 *
 * An approval is valid only when it was given by the user (never "Let Emma decide", never a delegation), is the newest card for this digest,
 * says "approve", was answered at most APPROVAL_TTL_MS ago, and has not been used (the caller claims it once, just before acting).
 *
 * Pure module: no network, no storage.
 */

import { createHash, randomBytes } from 'crypto';
import type { QuestionDeckQuestionInput } from './agentMode/core/approvalDeck';
import type { AskUserQuestionOption } from './agentMode/core/askUserQuestion';
import { APPROVAL_TTL_MS, APPROVE_OPTION_ID, DECLINE_OPTION_ID, findApproval } from './voice/hotLeadCallApprovalGate';

export { APPROVAL_TTL_MS, APPROVE_OPTION_ID, DECLINE_OPTION_ID, findApproval };

export type SmartleadApprovalAction = 'push' | 'release';

/** Card kinds starting with this are written only by this module; ask_user_question refuses them. */
export const SMARTLEAD_APPROVAL_KIND_PREFIX = 'smartlead_push_approval:';
/** Prefix of the entries written into the session's single-use map. */
export const SMARTLEAD_CONSUMED_KEY_PREFIX = 'smartlead:';

export interface PushDigestInput {
  userId: string;
  sessionId: string;
  listId: string;
  campaignId: number;
  campaignStatus: string;
  /** The hash of the campaign's sequence as previewed. */
  sequenceHash: string;
  /** How many contacts will be added. */
  cohort: number;
  eligible: number;
  includeUnverified: boolean;
  requiresActiveConfirmation: boolean;
  /** The campaign is sending and its emails carry no unsubscribe link: approving accepts that, so a change in it needs a new card. */
  requiresUnsubscribeAcknowledgement: boolean;
  mapping: Record<string, string>;
  acknowledgedTags: string[];
  /** PreviewResult.fingerprint: which contacts go to which Smartlead connection. */
  fingerprint: string;
}

export interface ReleaseDigestInput {
  userId: string;
  sessionId: string;
  listId: string;
  /** The campaign the release is limited to, or null for every campaign. */
  campaignId: number | null;
  /** The distinct lead ids, in any order. */
  leadIds: string[];
}

const sha = (material: unknown): string => createHash('sha256').update(JSON.stringify(material)).digest('hex');
const sortedEntries = (o: Record<string, string>): Array<[string, string]> => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function computePushDigest(input: PushDigestInput): string {
  return sha({
    v: 1,
    action: 'push',
    userId: input.userId,
    sessionId: input.sessionId,
    listId: input.listId,
    campaignId: input.campaignId,
    campaignStatus: input.campaignStatus,
    sequenceHash: input.sequenceHash,
    cohort: input.cohort,
    eligible: input.eligible,
    includeUnverified: input.includeUnverified,
    requiresActiveConfirmation: input.requiresActiveConfirmation,
    requiresUnsubscribeAcknowledgement: input.requiresUnsubscribeAcknowledgement,
    mapping: sortedEntries(input.mapping),
    acknowledgedTags: [...input.acknowledgedTags].sort(),
    fingerprint: input.fingerprint,
  });
}

export function computeReleaseDigest(input: ReleaseDigestInput): string {
  const ids = [...new Set(input.leadIds)].sort();
  return sha({ v: 1, action: 'release', userId: input.userId, sessionId: input.sessionId, listId: input.listId, campaignId: input.campaignId, leadCount: ids.length, leadIdsHash: sha(ids) });
}

export function approvalKindPrefix(action: SmartleadApprovalAction, digest: string): string {
  return `${SMARTLEAD_APPROVAL_KIND_PREFIX}${action}:${digest}:`;
}

export function newApprovalKind(action: SmartleadApprovalAction, digest: string): string {
  return approvalKindPrefix(action, digest) + randomBytes(8).toString('hex');
}

export function consumedKeyOf(kind: string): string {
  return `${SMARTLEAD_CONSUMED_KEY_PREFIX}${kind}`;
}

export type AttendedCheck = { allowed: true; sessionId: string; session: { sessionType?: string; messages: any[]; consumedMetaWriteManifestDigests?: Record<string, unknown> } } | { allowed: false; code: string; reason: string };

/** Who may be asked at all. Fails closed on anything it cannot establish. */
export function checkAttended(facts: { unattended?: boolean; delegated?: boolean; sessionId?: unknown; session?: any }): AttendedCheck {
  if (facts.unattended === true) return { allowed: false, code: 'unattended', reason: 'This needs a person to confirm in an interactive chat. Nothing was done.' };
  if (facts.delegated === true) {
    return { allowed: false, code: 'delegated', reason: "This sends email to the customer's contacts, so it can only be approved by the customer in their own chat, not while acting on their behalf. Nothing was done." };
  }
  if (typeof facts.sessionId !== 'string' || !facts.sessionId) {
    return { allowed: false, code: 'no_session', reason: 'This needs an attended chat session so a person can approve it; none was identified. Nothing was done.' };
  }
  if (!facts.session) return { allowed: false, code: 'session_unknown', reason: 'This session could not be read, so it cannot be confirmed as attended. Nothing was done.' };
  if (facts.session.sessionType === 'scheduled') {
    return { allowed: false, code: 'scheduled', reason: 'This needs a person to confirm in an interactive chat, not a scheduled run. Nothing was done.' };
  }
  return { allowed: true, sessionId: facts.sessionId, session: facts.session };
}

/** A name from the customer's data, made safe to put in a sentence the user reads: no control characters, short. */
export function cardText(value: unknown, max = 80): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export interface PushQuestionInput {
  kind: string;
  listName: string;
  campaignName: string;
  campaignStatus: string;
  cohort: number;
  eligible: number;
  listTotal: number;
  requiresActiveConfirmation: boolean;
  requiresUnsubscribeAcknowledgement: boolean;
  /** Tags the user is told Smartlead fills in itself. */
  smartleadFilledTags: string[];
  includeUnverified: boolean;
  /** The Smartlead account the contacts go into, and whether it is a teammate's shared connection: it sends from THAT account's mailboxes. */
  connection: { name: string; shared: boolean };
  /** The CRM field chosen for each merge field the campaign uses beyond the standard ones: it goes into what recipients read, so the user sees it. */
  mapping: Record<string, string>;
}

/**
 * The push approval card. The wording is built here from live values. "Decline" comes first and is the recommended option, so any answer taken
 * without a person choosing resolves to "do not send".
 */
export function buildPushQuestion(input: PushQuestionInput): QuestionDeckQuestionInput {
  const account = input.connection.shared
    ? `a teammate's shared Smartlead account "${cardText(input.connection.name)}"`
    : `your Smartlead account "${cardText(input.connection.name)}"`;
  const parts = [
    `Add ${plural(input.cohort, 'contact')} from "${cardText(input.listName)}" to the campaign "${cardText(input.campaignName)}" in ${account}?`,
    `Smartlead sends the emails, from that account's own mailboxes and with the campaign's own sequence; AgentWeb only adds the contacts. ${input.eligible.toLocaleString('en-US')} of ${input.listTotal.toLocaleString('en-US')} contacts in the list can be added${input.cohort < input.eligible ? `, and this adds the first ${input.cohort.toLocaleString('en-US')}` : ''}.`,
  ];
  if (input.includeUnverified) parts.push('This includes contacts whose email address is not verified.');
  if (input.smartleadFilledTags.length > 0) parts.push(`You are confirming that Smartlead fills in ${input.smartleadFilledTags.map(t => `{{${cardText(t, 40)}}}`).join(', ')} itself.`);
  const mapped = sortedEntries(input.mapping);
  if (mapped.length > 0) parts.push(`Merge fields filled from your CRM: ${mapped.map(([tag, path]) => `{{${cardText(tag, 40)}}} from "${cardText(path, 60)}"`).join(', ')}. These end up in the emails recipients read.`);
  if (input.requiresActiveConfirmation) parts.push(`This campaign is ALREADY SENDING (${cardText(input.campaignStatus, 20).toLowerCase()}): contacts start receiving email as soon as they are added.`);
  if (input.requiresUnsubscribeAcknowledgement) parts.push('These emails have NO UNSUBSCRIBE LINK, and the campaign is already sending: recipients get them with no way to opt out. Approving accepts that. Declining and setting the unsubscribe text in the campaign in Smartlead first is safer.');
  parts.push('By approving you confirm that you have a lawful basis to email these contacts, and that people who opt out are stopped in Smartlead for good.');
  const options: AskUserQuestionOption[] = [
    { id: DECLINE_OPTION_ID, label: 'Decline', consequence: 'Nothing is added to Smartlead.', recommended: true, why: 'Nothing is sent unless you approve.' },
    { id: APPROVE_OPTION_ID, label: `Add ${plural(input.cohort, 'contact')}`, consequence: `Adds ${plural(input.cohort, 'contact')} to the campaign now.` },
  ];
  return { question: parts.join(' '), options, allowEmmaDecide: false, kind: input.kind, immutable: true };
}

export interface ReleaseQuestionInput {
  kind: string;
  listName: string;
  count: number;
  campaignId: number | null;
  /** A few of the contacts' addresses, so the card says who it is about. */
  sample: string[];
}

export function buildReleaseQuestion(input: ReleaseQuestionInput): QuestionDeckQuestionInput {
  const who = input.sample.length > 0
    ? ` They include ${input.sample.map(e => cardText(e, 60)).join(', ')}${input.count > input.sample.length ? ` and ${plural(input.count - input.sample.length, 'other')}` : ''}.`
    : '';
  const question = `Release ${plural(input.count, 'contact')} in "${cardText(input.listName)}" from Smartlead${input.campaignId ? ` (campaign ${input.campaignId})` : ''}?${who} AgentWeb's own senders may email them again. Your Smartlead campaign is not changed and may keep emailing them, so they could get email from two places. Contacts who opted out stay blocked, and a Smartlead unsubscribe cannot be undone from here.`;
  const options: AskUserQuestionOption[] = [
    { id: DECLINE_OPTION_ID, label: 'Decline', consequence: 'Nothing is changed.', recommended: true, why: 'Nothing changes unless you approve.' },
    { id: APPROVE_OPTION_ID, label: `Release ${plural(input.count, 'contact')}`, consequence: 'Lets AgentWeb email these contacts again.' },
  ];
  return { question, options, allowEmmaDecide: false, kind: input.kind, immutable: true };
}
