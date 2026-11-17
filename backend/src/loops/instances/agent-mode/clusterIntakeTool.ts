/**
 * ClusterIntakeTool (ENG-589) — closes the sensing gap between the 17:30 UTC agent-mode
 * failure-cluster analysis and Linear.
 *
 * The rule set (`failureRuleSet.ts`) already admits only *major* `toolName × failureType`
 * clusters (count AND rate thresholds), so every tool-failure proposal reaching this tool is
 * filed — one canonical per cluster — through the ENG-240 single intake rail (`fileAutoIssue`):
 *   - open canonical with the same `Alert Class` → occurrence comment, no new issue (ENG-240);
 *   - closed canonical with the same class and no open one → reopen it + comment, no new issue;
 *   - otherwise → exactly one new `Auto` issue with cluster stats, sample traces, AC stub.
 *
 * The fix-spec artifact (SpecOutputTool) is preserved unchanged so the gate/digest keep working.
 * Execution route is always `human-triage`: ENG-533 admits no agent-mode class to autofix, and
 * unknown classes fail closed. A filing failure is recorded on the artifact, never thrown.
 */

import type { Mutation, MutationProposal, MutationTools } from '../../core/types';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import type { FileAutoIssueParams, FiledAutoResult } from '../../../services/intakeService';
import type { AgentClaimMismatchProposalPayload, AgentFailureProposalPayload } from './failureRuleSet';
import { AGENT_MODE_LOOP_ID } from './eventTypes';

type Payload = AgentFailureProposalPayload | AgentClaimMismatchProposalPayload;

export interface CanonicalRef {
  identifier: string;
  issueId: string;
  description: string;
  /** ISO creation time, when the port provides it (ENG-3088). */
  createdAt?: string;
}

export interface ClusterIntakePorts {
  fileIssue: (params: FileAutoIssueParams) => Promise<FiledAutoResult>;
  listOpenAuto: () => Promise<CanonicalRef[]>;
  findClosedAuto: (isMatch: (i: CanonicalRef) => boolean) => Promise<CanonicalRef | null>;
  reopen: (issueId: string) => Promise<void>;
  comment: (issueId: string, body: string) => Promise<void>;
  /** ENG-3088: what has already been posted on a canonical, to find the last recurrence post. */
  listComments: (issueId: string) => Promise<{ body: string; createdAt?: string }[]>;
  /** ENG-1099: Linear is only mutated from production; elsewhere the reopen path is suppressed. */
  isProduction: () => boolean;
}

const LINEAR_ISSUE_BASE = 'https://linear.app/emmabyaw/issue';

export function alertClassFor(p: AgentFailureProposalPayload): string {
  return `${AGENT_MODE_LOOP_ID}:${p.toolName}:${p.failureType || 'unclassified'}`;
}

function isToolFailure(payload: Payload): payload is AgentFailureProposalPayload {
  return typeof (payload as AgentFailureProposalPayload).toolName === 'string'
    && typeof (payload as AgentFailureProposalPayload).failures === 'number';
}

function classMatcher(alertClass: string): (i: CanonicalRef) => boolean {
  const esc = `Alert Class: ${alertClass}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}\\s*$`, 'm');
  return (i) => re.test(i.description || '');
}

const defaultPorts = (): ClusterIntakePorts => ({
  fileIssue: async (params) => (await import('../../../services/intakeService')).fileAutoIssue(params),
  listOpenAuto: async () => (await import('../../../services/linearService')).listOpenIssuesByLabel('Auto'),
  findClosedAuto: async (isMatch) =>
    (await import('../../../services/linearService')).findMostRecentClosedIssueByLabel('Auto', isMatch),
  reopen: async (id) => (await import('../../../services/linearService')).reopenIssue(id, 'Todo'),
  comment: async (id, body) => (await import('../../../services/linearService')).addIssueComment(id, body),
  listComments: async (id) => (await import('../../../services/linearService')).getIssueCommentsDetailed(id),
  isProduction: () => process.env.NODE_ENV === 'production',
});

export class ClusterIntakeTool implements MutationTools<Payload> {
  private readonly spec: SpecOutputTool<Payload>;
  private readonly ports: ClusterIntakePorts;
  /** Per-alertClass in-flight reopen, so overlapping runs cannot double-reopen/comment one canonical. */
  private readonly reopenInFlight = new Map<string, Promise<(FiledAutoResult & { reopened?: boolean }) | null>>();

  constructor(ports: Partial<ClusterIntakePorts> = {}, cloudDevTags?: readonly string[]) {
    this.spec = new SpecOutputTool<Payload>(AGENT_MODE_LOOP_ID, cloudDevTags);
    this.ports = { ...defaultPorts(), ...ports };
  }

  async apply(proposal: MutationProposal<Payload>): Promise<Mutation> {
    const mutation = await this.spec.apply(proposal);
    if (!isToolFailure(proposal.payload)) return mutation;
    const payload = proposal.payload;
    const alertClass = alertClassFor(payload);
    const context: Record<string, string> = {
      'Loop ID': AGENT_MODE_LOOP_ID,
      'Rule ID': proposal.sourceRuleId,
      Failures: `${payload.failures}/${payload.invocations || payload.failures} (${Math.round(payload.failureRate * 100)}%)`,
      'Top Error Class': payload.topErrorClass,
      // Last, so the class line is never a prefix of another context line's match.
      'Alert Class': alertClass,
    };
    try {
      // ENG-3088: the 7-day window keeps an old failure over threshold for days. Only a failure
      // newer than the last thing posted on the canonical is a recurrence worth a comment/reopen.
      const fresh = await this.newSinceLastPost(alertClass, payload);
      if (fresh && fresh.newFailures === 0) {
        const intake = {
          pageId: fresh.canonical.identifier,
          url: `${LINEAR_ISSUE_BASE}/${fresh.canonical.identifier}`,
          deduped: true,
          tracker: 'Linear' as const,
          noNewFailures: true,
          alertClass,
        };
        return { ...mutation, artifact: { ...mutation.artifact, intake } };
      }
      if (fresh) {
        // Re-insert the class so it stays the last context line (see above).
        delete context['Alert Class'];
        context['New Since Last Comment'] = `${fresh.newFailures} of ${payload.failures} failures`;
        context['Alert Class'] = alertClass;
      }
      const intake = await this.reopenOnce(alertClass, payload, context)
        ?? (await this.ports.fileIssue({
          title: this.title(payload),
          description: this.body(proposal, payload),
          source: `${AGENT_MODE_LOOP_ID} failure-cluster loop`,
          executionRoute: 'human-triage',
          notionContext: context,
        }));
      return { ...mutation, artifact: { ...mutation.artifact, intake: { ...intake, alertClass } } };
    } catch (err) {
      return {
        ...mutation,
        artifact: { ...mutation.artifact, intake: { alertClass } },
        error: `intake failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * ENG-3088: how many of this cluster's failures are newer than the last filing/recurrence post on
   * its canonical (open, else closed). The baseline is read back from Linear itself (issue creation
   * time and "Recurred on"/"Reopened" comment times), so nothing new is stored. Returns null when
   * there is no canonical (first filing) or the baseline cannot be established: the caller then
   * posts exactly as before (fail open).
   */
  private async newSinceLastPost(
    alertClass: string,
    payload: AgentFailureProposalPayload,
  ): Promise<{ canonical: CanonicalRef; newFailures: number } | null> {
    const times = (payload.failureTimes ?? []).map((t) => Date.parse(t)).filter(Number.isFinite);
    if (times.length === 0 || times.length !== payload.failures) return null;
    try {
      const matches = classMatcher(alertClass);
      const canonical =
        (await this.ports.listOpenAuto()).find(matches) ?? (await this.ports.findClosedAuto(matches));
      if (!canonical) return null;
      const posts = (await this.ports.listComments(canonical.issueId))
        .filter((c) => /^(?:Recurred on|Reopened) /.test((c.body || '').trim()))
        .map((c) => Date.parse(c.createdAt ?? ''));
      const marks = [Date.parse(canonical.createdAt ?? ''), ...posts].filter(Number.isFinite);
      if (marks.length === 0) return null;
      const baseline = Math.max(...marks);
      return { canonical, newFailures: times.filter((t) => t > baseline).length };
    } catch {
      return null;
    }
  }

  private async reopenOnce(
    alertClass: string,
    payload: AgentFailureProposalPayload,
    context: Record<string, string>,
  ): Promise<(FiledAutoResult & { reopened?: boolean }) | null> {
    const pending = this.reopenInFlight.get(alertClass);
    if (pending) {
      const prior = await pending;
      // The concurrent run already reopened (or suppressed) it; report as deduped, never re-comment.
      return prior ? { ...prior, reopened: false } : null;
    }
    const run = this.reopenClosedCanonical(alertClass, payload, context);
    this.reopenInFlight.set(alertClass, run);
    try {
      return await run;
    } finally {
      this.reopenInFlight.delete(alertClass);
    }
  }

  /** AC3: a closed canonical (and no open one) is reopened rather than duplicated. */
  private async reopenClosedCanonical(
    alertClass: string,
    payload: AgentFailureProposalPayload,
    context: Record<string, string>,
  ): Promise<(FiledAutoResult & { reopened?: boolean }) | null> {
    const matches = classMatcher(alertClass);
    let closed: CanonicalRef | null;
    try {
      if ((await this.ports.listOpenAuto()).some(matches)) return null; // ENG-240 path owns it
      closed = await this.ports.findClosedAuto(matches);
    } catch {
      return null; // lookup is best-effort; fall through to the normal intake rail
    }
    if (!closed) return null;
    // ENG-1099: same NODE_ENV guard as createInternalLinearIssue — never reopen/comment outside prod.
    if (!this.ports.isProduction()) return { pageId: '', deduped: false, tracker: 'Linear', suppressed: true };
    await this.ports.reopen(closed.issueId);
    await this.ports.comment(
      closed.issueId,
      [
        `Reopened ${new Date().toISOString().slice(0, 10)}: failure cluster recurred after close.`,
        ...Object.entries(context).map(([k, v]) => `- ${k}: ${v}`),
        ...(payload.sampleTraces?.length ? ['- Sample traces:', ...payload.sampleTraces.map((t) => `  - ${t}`)] : []),
      ].join('\n'),
    );
    return { pageId: closed.identifier, url: `${LINEAR_ISSUE_BASE}/${closed.identifier}`, deduped: true, tracker: 'Linear', reopened: true };
  }

  private title(p: AgentFailureProposalPayload): string {
    return `Agent tool \`${p.toolName}\` failing (${p.failureType || 'unclassified'}, ${p.topErrorClass})`;
  }

  private body(proposal: MutationProposal<Payload>, p: AgentFailureProposalPayload): string {
    return [
      `**Auto-filed by the ${AGENT_MODE_LOOP_ID} failure-cluster analysis (ENG-589).**`,
      '',
      '## Summary',
      proposal.hypothesis,
      '',
      '## Cluster stats',
      '```json',
      JSON.stringify(proposal.triggeringStats, null, 2),
      '```',
      '',
      '## Sample traces',
      ...(p.sampleTraces?.length ? p.sampleTraces.map((t) => `- ${t}`) : ['- (none recorded)']),
      '',
      '## Directive',
      p.directive,
      '',
      '## Acceptance criteria (stub — human to confirm before an executor claims)',
      `1. A regression test reproduces the \`${p.toolName}\` ${p.failureType || 'unclassified'} failure before the fix and passes after.`,
      '2. The next failure-cluster window shows this class below the admission threshold.',
      '3. [human] Confirm or replace these criteria.',
    ].join('\n');
  }
}
