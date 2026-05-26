/**
 * captureGate — collects "approval requests" in memory so the smoke runner
 * can later make the real Slack call with all of them inline in a single DM.
 *
 * The real production gate is the slackReactionGate (Phase 2 — posts a DM
 * per request and polls reactions). The capture gate exists for the smoke
 * test path where we want the orchestrator to call requestApproval but we
 * don't want each rule to fire its own Slack message — instead we batch
 * them all into one digest DM the smoke runner sends afterwards.
 */

import type { ApprovalGate, ApprovalRecord, Decision, Mutation } from '../types';
import { asMutationId } from '../types';

let counter = 0;

export class CaptureGate implements ApprovalGate {
  readonly captured: Mutation[] = [];

  async requestApproval(mutation: Mutation): Promise<ApprovalRecord> {
    this.captured.push(mutation);
    counter++;
    return {
      mutationId: mutation.mutationId,
      handle: { capturedAs: `capture-${counter}` },
      requestedAt: new Date(),
    };
  }

  async pollDecision(_record: ApprovalRecord): Promise<Decision> {
    // The capture gate never resolves decisions on its own. The smoke runner
    // (or the real Slack gate in production) is what produces decisions.
    return { status: 'pending', decidedAt: new Date() };
  }

  /** Used by the smoke runner / cron after the loop returns to drain
   * captured mutations into a real Slack DM payload. */
  drain(): readonly Mutation[] {
    const out = [...this.captured];
    this.captured.length = 0;
    return out;
  }

  /** Suppress unused-name warnings on `asMutationId` for files that only
   * use it as a type-flow helper. */
  static _typeFlow(): unknown {
    return asMutationId;
  }
}
