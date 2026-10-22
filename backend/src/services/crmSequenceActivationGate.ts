/**
 * ENG-964 — the activation boundary (ENG-587 A1+A2) for `manage_crm_sequence`.
 *
 * Activating a drip sequence starts real email to real leads, so it is gated
 * by two independent barriers:
 *
 *   A1 — attended only. Unattended / scheduled / external-MCP sessions are
 *        refused unconditionally. No argument (e.g. `confirm: true`) can
 *        override this, because every argument is model-authored.
 *   A2 — preview + human approval. The tool first issues a preview whose token
 *        is a hash of the sequence's content, audience and cadence, surfaced to
 *        the user as a deck-of-one approval card. Activation is allowed only
 *        when that exact token (recomputed from the sequence as it is NOW) was
 *        previewed AND a human selected the affirmative option on that card.
 *
 * The human-attribution channel is the EXISTING one, not a new primitive: the
 * approval deck (approvalDeck.ts), which replaced the retired
 * `pendingUserQuestion` slot (ENG-1635/1644 — nothing writes that field any
 * more) and carries the same invariant: `answeredBy` is `'user' | 'delegation'`
 * only, so the model can never author an approval. We require `'user'`
 * specifically — "Let Emma decide" is not offered on this card, and a
 * delegation is not an affirmative human answer to "start sending email".
 *
 * Pure module — no network, no DynamoDB.
 */

import { createHash } from 'crypto';
import type { AskUserQuestionOption } from './agentMode/core/askUserQuestion';
import {
  findAnsweredDeckItemByKind,
  type ApprovalDeckHistoryMessage,
  type QuestionDeckQuestionInput,
} from './agentMode/core/approvalDeck';

export const ACTIVATION_KIND_PREFIX = 'crm_sequence_activation';
export const ACTIVATE_OPTION_ID = 'activate';
export const KEEP_DRAFT_OPTION_ID = 'keep_draft';

/** The subset of a stored DripSequence the preview token binds to. */
export interface ActivationSequenceInput {
  sequenceId?: string;
  name?: string;
  steps?: Array<Record<string, any>>;
  autoEnrollListIds?: unknown;
  enrollmentCondition?: unknown;
  exitConditions?: unknown;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value ?? null;
}

/**
 * Preview token = sha256 over the sequence's content, audience and cadence.
 * Generated ids (stepId) and timestamps are excluded so an unchanged sequence
 * re-hashes to the same token; anything a recipient would experience
 * differently — copy, sender, channel, delays, who is enrolled, when they
 * exit — is included, so any such change invalidates an outstanding preview.
 */
export function computeSequencePreviewToken(sequence: ActivationSequenceInput): string {
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
  const material = {
    sequenceId: sequence?.sequenceId ?? null,
    content: steps.map((s) => ({
      name: s?.name,
      channel: s?.channel ?? 'email',
      subject: s?.subject,
      bodyHtml: s?.bodyHtml,
      messageText: s?.messageText,
      senderId: s?.senderId,
      linkedInAccountId: s?.linkedInAccountId,
    })),
    cadence: steps.map((s) => s?.delayDays ?? null),
    audience: {
      autoEnrollListIds: Array.isArray(sequence?.autoEnrollListIds)
        ? [...(sequence.autoEnrollListIds as unknown[])].map(String).sort()
        : [],
      enrollmentCondition: sequence?.enrollmentCondition ?? null,
      exitConditions: sequence?.exitConditions ?? null,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical(material))).digest('hex');
}

export function activationKind(sequenceId: string, token: string): string {
  return `${ACTIVATION_KIND_PREFIX}:${sequenceId}:${token}`;
}

/** A1: who may activate at all. Fails closed on anything it cannot establish. */
export interface ActivationSessionFacts {
  externalMcp?: boolean;
  unattended?: boolean;
  sessionId?: string;
  /** The session record read fresh from storage; null/undefined = unknown. */
  session?: { sessionType?: string } | null;
}

export type GateOutcome = { allowed: true } | { allowed: false; reason: string; code: string };

export function checkAttendedSession(facts: ActivationSessionFacts): GateOutcome {
  if (facts.externalMcp === true) {
    return {
      allowed: false,
      code: 'external_mcp',
      reason: 'Sequences cannot be activated from an external MCP client. Activate it in the AgentWeb CRM UI.',
    };
  }
  if (facts.unattended === true) {
    return {
      allowed: false,
      code: 'unattended',
      reason: 'Sequences cannot be activated from an unattended run. Leave it as a draft and tell the user it is ready to review.',
    };
  }
  if (typeof facts.sessionId !== 'string' || !facts.sessionId) {
    return {
      allowed: false,
      code: 'no_session',
      reason: 'Activation needs an attended chat session so a person can approve it; none was identified.',
    };
  }
  if (!facts.session) {
    return {
      allowed: false,
      code: 'session_unknown',
      reason: 'This session could not be read, so it cannot be confirmed as attended. Nothing was activated.',
    };
  }
  if (facts.session.sessionType === 'scheduled') {
    return {
      allowed: false,
      code: 'scheduled',
      reason: 'Sequences cannot be activated from a scheduled run. Leave it as a draft and tell the user it is ready to review.',
    };
  }
  return { allowed: true };
}

/** The deck-of-one approval card the preview surfaces. */
export function buildActivationQuestion(
  sequence: ActivationSequenceInput,
  token: string,
  audienceSummary: string,
): QuestionDeckQuestionInput {
  const stepCount = Array.isArray(sequence?.steps) ? sequence.steps.length : 0;
  const options: AskUserQuestionOption[] = [
    {
      id: ACTIVATE_OPTION_ID,
      label: 'Activate',
      consequence: 'Starts sending this sequence to enrolled leads on its schedule.',
      recommended: true,
      why: 'You reviewed the exact steps, audience and timing shown in this preview.',
    },
    {
      id: KEEP_DRAFT_OPTION_ID,
      label: 'Keep as draft',
      consequence: 'Nothing is sent. The sequence stays a draft you can edit.',
    },
  ];
  return {
    question:
      `Activate the email sequence "${sequence?.name ?? sequence?.sequenceId}"? ` +
      `${stepCount} step(s); audience: ${audienceSummary}. Real emails will be sent.`,
    options,
    allowEmmaDecide: false,
    kind: activationKind(String(sequence?.sequenceId), token),
    immutable: true,
  };
}

/**
 * A2: was THIS exact sequence state previewed and approved by a human?
 * `messages` is the session's message history read fresh from storage.
 */
export function checkActivationApproval(
  messages: ApprovalDeckHistoryMessage[],
  sequenceId: string,
  currentToken: string,
): GateOutcome {
  const prefix = `${ACTIVATION_KIND_PREFIX}:${sequenceId}:`;
  const previewKinds = new Set<string>();
  for (const message of messages ?? []) {
    for (const item of message?.metadata?.approvalDeckItems ?? []) {
      if (typeof item?.kind === 'string' && item.kind.startsWith(prefix)) previewKinds.add(item.kind);
    }
  }
  if (previewKinds.size === 0) {
    return {
      allowed: false,
      code: 'no_preview',
      reason: 'No activation preview was shown for this sequence. Call manage_crm_sequence with action "preview_activation" first.',
    };
  }
  const kind = activationKind(sequenceId, currentToken);
  if (!previewKinds.has(kind)) {
    return {
      allowed: false,
      code: 'stale_preview',
      reason: 'The sequence content, audience or cadence changed after the preview. Preview it again so the user approves what will actually be sent.',
    };
  }
  // Newest answer wins: a later 'Keep as draft' must override an earlier
  // 'Activate' for the same (unchanged) preview kind.
  const outcome = findAnsweredDeckItemByKind([...messages].reverse(), kind);
  if (!outcome.found) {
    return {
      allowed: false,
      code: 'awaiting_approval',
      reason: 'The user has not answered the activation preview yet. Wait for them to choose; do not activate on your own.',
    };
  }
  if (outcome.answer.answeredBy !== 'user') {
    return {
      allowed: false,
      code: 'not_human',
      reason: 'The activation approval was not an explicit selection by the user.',
    };
  }
  if (outcome.answer.verdict !== ACTIVATE_OPTION_ID) {
    return {
      allowed: false,
      code: 'not_affirmative',
      reason: 'The user did not approve activation. The sequence stays as it is.',
    };
  }
  return { allowed: true };
}
