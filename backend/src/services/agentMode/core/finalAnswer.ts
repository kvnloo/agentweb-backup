/**
 * PURE "did this run actually answer?" predicate (ENG-946).
 *
 * A scheduled run's zero-output guard used to ask "does the persisted transcript
 * contain ANY assistant message?". That is satisfied by a tool-call turn, and the
 * agent routinely narrates one line alongside its tool calls ("I'll pull both
 * datasets in parallel."). So a run that gathered data for minutes and then died
 * before synthesising anything still looked like output existed: the run was
 * recorded `success`, the schedule never requeued it, and the user got a session
 * that ends on tool results with no report.
 *
 * The real invariant is narrower: somewhere in the transcript there must be an
 * assistant message that carries text and is NOT a tool-call turn — a turn whose
 * whole purpose was to speak to the user.
 */

import { isUnusableSynthesis } from './synthesisResidue';

/** Flatten OpenAI/Claude-shaped message content into plain text. */
function messageText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (typeof block === 'string' ? block : block?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return (content as any).text || '';
  return '';
}

/**
 * Is this single message a real assistant answer?
 *
 * Excludes: non-assistant roles, tool-call turns (their text is narration about
 * work still in flight), blank text, and a turn that emitted characters but no
 * answer — serialization residue, a repetition collapse, or a transcription of our
 * own degraded tool history (see ENG-1054's isUnusableSynthesis, which the loop
 * already uses to blank such a turn before it is persisted; this is the read-side
 * check for transcripts written before that guard, or with it disabled).
 */
export function isFinalAssistantAnswer(message: any): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  const text = messageText(message.content).trim();
  if (!text) return false;
  return !isUnusableSynthesis(text);
}

/** Does this persisted transcript contain a real assistant answer? */
export function transcriptHasFinalAssistantAnswer(messages: any[]): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(isFinalAssistantAnswer);
}
