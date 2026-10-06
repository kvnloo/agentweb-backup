/**
 * H-LEARN-2a: derive review-only lesson proposals from bounded ReliabilityEvents.
 *
 * This module has NO persistence and NO runtime authority. A proposal cannot alter
 * prompts, skills, tools, schedules, policy, or external state. Durable promotion
 * and owner review are a separate H-LEARN-2b slice.
 */

import { createHash } from 'crypto';
import type { ReliabilityEvent, ReliabilityOutcome } from './reliabilityEvent';

export const RELIABILITY_LEARNING_PREFIX = 'reliability-learning#';
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_DISTINCT_SESSIONS = 3;
const MIN_SIGNAL_RATE = 0.5;
const MAX_INPUT_EVENTS = 512;

export type ReliabilityLessonSignal = 'repeated_failure';

export interface ReliabilityLessonProposal {
  lessonId: string;
  userId: string;
  tool: string;
  signal: ReliabilityLessonSignal;
  content: string;
  reviewState: 'proposed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  evidence: {
    sampleSize: number;
    totalObserved: number;
    distinctSessions: number;
    signalRate: number;
    firstAt: string;
    lastAt: string;
    outcomes: ReliabilityOutcome[];
  };
}

function stableLessonId(userId: string, tool: string, signal: ReliabilityLessonSignal): string {
  const digest = createHash('sha256').update(`${userId}\0${tool}\0${signal}`).digest('hex');
  return RELIABILITY_LEARNING_PREFIX + digest;
}

function isCandidateOutcome(outcome: ReliabilityOutcome): boolean {
  return outcome === 'success' || outcome === 'error' || outcome === 'timeout';
}

function distinctSessionCount(events: ReliabilityEvent[]): number {
  return new Set(events.map((event) => event.sessionId).filter((id): id is string => Boolean(id))).size;
}

function makeProposal(params: {
  userId: string;
  tool: string;
  signal: ReliabilityLessonSignal;
  signalEvents: ReliabilityEvent[];
  totalObserved: number;
}): ReliabilityLessonProposal {
  const ordered = [...params.signalEvents].sort((a, b) => a.at.localeCompare(b.at));
  const outcomes = [...new Set(ordered.map((event) => event.outcome))].sort() as ReliabilityOutcome[];
  const sampleSize = ordered.length;
  const signalRate = params.totalObserved === 0 ? 0 : sampleSize / params.totalObserved;
  const lastEvidenceAt = ordered[ordered.length - 1].at;
  const content =
    `Tool ${params.tool} has repeatedly failed or timed out across distinct sessions. `
    + 'Treat immediate identical retries as suspect and surface the failure before retrying.';

  return {
    lessonId: stableLessonId(params.userId, params.tool, params.signal),
    userId: params.userId,
    tool: params.tool,
    signal: params.signal,
    content,
    reviewState: 'proposed',
    // Lifecycle is anchored to evidence, not to read time. Re-reading the same
    // event set must never extend a proposal's review lifetime.
    createdAt: lastEvidenceAt,
    updatedAt: lastEvidenceAt,
    expiresAt: new Date(Date.parse(lastEvidenceAt) + PROPOSAL_TTL_MS).toISOString(),
    evidence: {
      sampleSize,
      totalObserved: params.totalObserved,
      distinctSessions: distinctSessionCount(ordered),
      signalRate,
      firstAt: ordered[0].at,
      lastAt: ordered[ordered.length - 1].at,
      outcomes,
    },
  };
}

/**
 * Derive bounded, deterministic review candidates for one user.
 *
 * Expected-policy outcomes are intentionally excluded: blocked/skipped/confirmation
 * states describe authority/workflow, not tool unreliability. Raw errorSummary is
 * never copied into a proposal. userEdit is deliberately NOT a lesson signal here:
 * the current producer only carries a voice-capture hint, not verified edit evidence.
 */
export function proposeReliabilityLessons(
  events: ReliabilityEvent[],
  userId: string,
  now: Date = new Date(),
): ReliabilityLessonProposal[] {
  if (!userId) return [];
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid reliability learning clock');
  const floor = nowMs - LOOKBACK_MS;

  const scoped = events
    .slice(-MAX_INPUT_EVENTS)
    .filter((event) =>
      event.userId === userId &&
      typeof event.tool === 'string' &&
      Boolean(event.sessionId) &&
      Number.isFinite(Date.parse(event.at)) &&
      Date.parse(event.at) >= floor &&
      Date.parse(event.at) <= nowMs &&
      isCandidateOutcome(event.outcome)
    );

  const byTool = new Map<string, ReliabilityEvent[]>();
  for (const event of scoped) {
    const list = byTool.get(event.tool) ?? [];
    list.push(event);
    byTool.set(event.tool, list);
  }

  const proposals: ReliabilityLessonProposal[] = [];
  for (const [tool, toolEvents] of [...byTool.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const failures = toolEvents.filter((event) => event.outcome === 'error' || event.outcome === 'timeout');
    if (
      failures.length >= MIN_DISTINCT_SESSIONS &&
      distinctSessionCount(failures) >= MIN_DISTINCT_SESSIONS &&
      failures.length / toolEvents.length >= MIN_SIGNAL_RATE
    ) {
      proposals.push(makeProposal({
        userId,
        tool,
        signal: 'repeated_failure',
        signalEvents: failures,
        totalObserved: toolEvents.length,
      }));
    }
  }

  return proposals;
}
