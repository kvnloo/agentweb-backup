/**
 * ENG-2109 (B2): whether a chat session is waiting on the user's confirmation,
 * read from the session itself.
 *
 * The tool bridge holds its halt in memory, and a backend restart loses it along with
 * every `claude -p` process. Emma already records the halt durably: the turn that
 * stops for confirmation ends with an assistant message carrying
 * `metadata.awaitingUserConfirmation`. Whoever opens a run for a session passes this
 * as `halted`, so a run started without a new user message (a scheduled or resumed
 * run) cannot act on an approval nobody gave.
 */

interface SessionMessageLike {
  role?: string;
  metadata?: { awaitingUserConfirmation?: boolean } | null;
}

export function sessionAwaitsConfirmation(messages: readonly SessionMessageLike[] | null | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") return false;
    if (message?.role === "assistant") return message.metadata?.awaitingUserConfirmation === true;
  }
  return false;
}
