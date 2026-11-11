/**
 * ENG-2863: serial-read spiral detection.
 *
 * Session 5bfb9d06 (scheduled "Daily ICP Lead Finder") hit the 40-step cap after 39
 * steps that each carried exactly ONE read-only tool call: get_leads cursor pages,
 * get_lead_details one lead at a time, then linkedin_outreach get-profile / get-company
 * one candidate at a time. Every call was unique, so neither the exact-signature guards
 * nor the ENG-2778 paging detector fired. The dispatcher already runs several tool calls
 * from one response in a single step — the model just never batched.
 *
 * This module counts consecutive steps that each issued a single read-only call and,
 * once per turn, tells the model to batch independent lookups into one response.
 */
import { isWriteToolCall } from '../../../utils/toolWriteClassification';

/** Consecutive single-read steps before the batching nudge fires. */
export const SERIAL_READ_THRESHOLD = 6;

export const SERIAL_READ_BATCH_MESSAGE =
  '[SYSTEM] Your step budget is limited and you have spent several steps in a row issuing ONE read-only lookup per step. ' +
  'When the next lookups do not depend on each other (several profiles, companies, leads, or searches), issue them ALL as ' +
  'multiple tool calls in a SINGLE response — they run together and cost one step. Skip lookups the task does not need ' +
  '(e.g. paging through a whole list when a tool already de-duplicates), and keep enough budget to finish the write and report steps.';

export interface SerialReadState {
  streak: number;
  nudged: boolean;
}

export function createSerialReadState(): SerialReadState {
  return { streak: 0, nudged: false };
}

/**
 * Record one step's tool calls (OpenAI shape: { function: { name, arguments } }).
 * Returns true exactly once per turn, on the step the streak reaches `threshold`.
 * Any step with zero, several, or a write call resets the streak.
 */
export function recordSerialReadStep(
  state: SerialReadState,
  toolCalls: any[] | null | undefined,
  threshold: number = SERIAL_READ_THRESHOLD,
): boolean {
  const calls = toolCalls ?? [];
  const single = calls.length === 1 ? calls[0] : null;
  const isSingleRead =
    !!single &&
    typeof single?.function?.name === 'string' &&
    !isWriteToolCall({ name: single.function.name, arguments: single.function.arguments });
  state.streak = isSingleRead ? state.streak + 1 : 0;
  if (state.nudged || state.streak < threshold) return false;
  state.nudged = true;
  return true;
}
