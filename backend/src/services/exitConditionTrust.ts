/**
 * ENG-2573 (ENG-325 slice): tell UI/Emma which sequence exit conditions are
 * trustworthy. Opens and clicks can be fired by link scanners and image proxies
 * (Apple Mail Privacy Protection), so an exit on them may remove a lead who
 * never engaged. Replies, LinkedIn replies, lifecycle changes and unsubscribes
 * are human or first-party signals.
 *
 * Pure: no I/O. Reason codes only — user-facing warning copy is a Harsha-review
 * item and is deliberately not shipped here.
 */
import type { DripSequence, EmailEngagementEvent } from './dripSequenceDb';

export type SequenceExitCondition =
  | EmailEngagementEvent
  | 'linkedin_reply'
  | 'lifecycle_change'
  | 'unsubscribe';

export type ExitTrust = 'reliable' | 'machine_susceptible';

export type ExitTrustReasonCode =
  | 'human_reply'
  | 'first_party_state_change'
  | 'link_scanner_click'
  | 'image_proxy_open';

export interface ExitTrustClassification {
  trust: ExitTrust;
  reasonCode: ExitTrustReasonCode;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled exit condition: ${String(x)}`);
}

export function classifyExitConditionTrust(condition: SequenceExitCondition): ExitTrustClassification {
  switch (condition) {
    case 'replied':
    case 'linkedin_reply':
      return { trust: 'reliable', reasonCode: 'human_reply' };
    case 'lifecycle_change':
    case 'unsubscribe':
      return { trust: 'reliable', reasonCode: 'first_party_state_change' };
    case 'opened':
      return { trust: 'machine_susceptible', reasonCode: 'image_proxy_open' };
    case 'clicked':
      return { trust: 'machine_susceptible', reasonCode: 'link_scanner_click' };
    default:
      return assertNever(condition);
  }
}

export interface MachineSusceptibleExit {
  condition: SequenceExitCondition;
  reasonCode: ExitTrustReasonCode;
}

/** Configured exit conditions on a sequence that a machine could trigger. */
export function machineSusceptibleExits(
  exitConditions: Partial<DripSequence['exitConditions']> | null | undefined,
): MachineSusceptibleExit[] {
  const configured: SequenceExitCondition[] = [];
  const engagement = Array.isArray(exitConditions?.onEmailEngagement) ? exitConditions!.onEmailEngagement : [];
  for (const e of engagement) configured.push(e);
  if (exitConditions?.onLinkedInReply) configured.push('linkedin_reply');
  if (exitConditions?.onLifecycleChange?.length) configured.push('lifecycle_change');
  if (exitConditions?.onUnsubscribe) configured.push('unsubscribe');

  const out: MachineSusceptibleExit[] = [];
  const seen = new Set<string>();
  for (const condition of configured) {
    if (seen.has(condition)) continue;
    seen.add(condition);
    let c: ExitTrustClassification;
    try {
      c = classifyExitConditionTrust(condition);
    } catch {
      continue; // unknown stored value: not ours to judge, never crash a read
    }
    if (c.trust === 'machine_susceptible') out.push({ condition, reasonCode: c.reasonCode });
  }
  return out;
}
