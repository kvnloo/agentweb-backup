/**
 * loopDigest — shared template-driven builder for the per-loop Slack digest DM.
 *
 * Every loop instance posts the same skeleton after a tick: bold header with
 * the date, the Run ID line, a counts line, an empty/quiet/findings body
 * branch, optional extra sections, and the shared React ✅ footer.
 *
 * CRITICAL: the rendered text is a wire format. The Slack approval dispatcher
 * (services/loopSlackApprovalDispatcher.ts) regex-parses the Run ID line, the
 * numbered items, and the footer. Characterization tests in
 * __tests__/loops.digestCharacterization.test.ts pin every loop's exact
 * output — change wording only with the dispatcher in view.
 */

import type { LoopRunResult } from '../types';

/** Minimal slice of SlackPort the digest poster actually uses. */
export type SlackPosterLike = {
  postMessage: (channelOrUserId: string, markdown: string) => Promise<unknown>;
};

/** Shared footer — the approval dispatcher keys off this exact string. */
export const LOOP_DIGEST_FOOTER =
  'React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop';

/**
 * Per-loop digest template. `TExtra` carries whatever loop-specific context
 * the sections need (mutation count, funnel shape, mutations, …).
 */
export interface LoopDigestTemplate<TExtra = void> {
  /** Console-log prefix, e.g. '[agent-mode-loop]'. */
  logTag: string;
  /** Full bolded header line, given today's YYYY-MM-DD. */
  header: (date: string) => string;
  /** The counts line directly under the Run ID line. */
  counts: (result: LoopRunResult, extra: TExtra) => string;
  /** Optional lines between counts and the blank separator (funnel shape). */
  preBody?: (result: LoopRunResult, extra: TExtra) => string[];
  /** Body when the sensor saw zero events. */
  emptyBody: (result: LoopRunResult, extra: TExtra) => string[];
  /** Body when events were seen but no proposals fired. */
  quietBody: (result: LoopRunResult, extra: TExtra) => string[];
  /** Body when proposals fired. Includes its own section header. */
  findingsBody: (result: LoopRunResult, extra: TExtra) => string[];
  /** Optional sections after the body; preceded by a blank line when non-empty. */
  extraSections?: (result: LoopRunResult, extra: TExtra) => string[];
  /** Lines appended after the shared footer. */
  footerExtra?: readonly string[];
  /** Footer for actionable findings. Return null to suppress the footer. */
  footer?: (result: LoopRunResult, extra: TExtra) => string | null;
  /** Override for the missing-slackUserId warning suffix. */
  missingUserWarning?: string;
}

export type LoopDigestClaim = (
  digestDate: string,
  slackUserId: string,
  runId: string,
) => Promise<boolean>;

export interface PostLoopDigestOptions {
  claimDailyDigest?: LoopDigestClaim;
}

/** Render the digest lines for one run. Pure (no I/O) so each loop's exact
 * output can be unit-tested without a Slack stub. */
export function buildLoopDigestLines<TExtra>(
  result: LoopRunResult,
  template: LoopDigestTemplate<TExtra>,
  extra: TExtra,
): string[] {
  const lines: string[] = [];
  lines.push(template.header(new Date().toISOString().slice(0, 10)));
  lines.push(`Run ID: \`${result.runId}\``);
  lines.push(template.counts(result, extra));
  if (template.preBody) lines.push(...template.preBody(result, extra));
  lines.push('');

  if (result.eventsScanned === 0) {
    lines.push(...template.emptyBody(result, extra));
  } else if (result.proposals.length === 0) {
    lines.push(...template.quietBody(result, extra));
  } else {
    lines.push(...template.findingsBody(result, extra));
  }

  const extraSections = template.extraSections ? template.extraSections(result, extra) : [];
  if (extraSections.length > 0) {
    lines.push('');
    lines.push(...extraSections);
  }

  const footer = template.footer
    ? template.footer(result, extra)
    : result.proposals.length > 0
      ? LOOP_DIGEST_FOOTER
      : null;
  if (footer) {
    lines.push('');
    lines.push(footer);
    if (template.footerExtra) lines.push(...template.footerExtra);
  }
  return lines;
}

/** Standard findings renderer for analyst-policy loops (onboarding,
 * ai-readiness): numbered hypothesis lines, each followed by a Kind line with
 * an optional `Fix:` directive pulled from the proposal payload. */
export function analystFindingsBody(result: LoopRunResult): string[] {
  const lines: string[] = [`*What I found*`];
  for (let i = 0; i < result.proposals.length; i++) {
    const p = result.proposals[i];
    const directive = (p.payload as { directive?: string } | undefined)?.directive ?? '';
    lines.push(`${i + 1}. ${p.hypothesis}`);
    lines.push(
      `   Proposal ID: \`${p.proposalId}\`  |  Kind: \`${p.kind}\`${directive ? `  |  Fix: ${directive}` : ''}`,
    );
  }
  return lines;
}

/**
 * Build + DM the digest. Never throws — a missing slackUserId logs a warning
 * and a Slack failure logs an error, exactly like the per-loop posters this
 * replaces.
 */
export async function postLoopDigest<TExtra>(
  result: LoopRunResult,
  slack: SlackPosterLike,
  slackUserId: string | undefined,
  template: LoopDigestTemplate<TExtra>,
  extra: TExtra,
  options: PostLoopDigestOptions = {},
): Promise<void> {
  if (!slackUserId) {
    console.warn(
      `${template.logTag} ${template.missingUserWarning ?? 'no approval.slackUserId — skipping DM'}`,
    );
    return;
  }

  if (options.claimDailyDigest) {
    try {
      const digestDate = new Date().toISOString().slice(0, 10);
      const claimed = await options.claimDailyDigest(digestDate, slackUserId, result.runId);
      if (!claimed) {
        console.log(`${template.logTag} daily digest already posted for ${digestDate}; skipping duplicate DM`);
        return;
      }
    } catch (err) {
      console.error(`${template.logTag} daily digest claim failed; skipping Slack DM:`, err);
      return;
    }
  }

  try {
    await slack.postMessage(slackUserId, buildLoopDigestLines(result, template, extra).join('\n'));
  } catch (err) {
    console.error(`${template.logTag} Slack DM post failed:`, err);
  }
}
