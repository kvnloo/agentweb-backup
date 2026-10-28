/**
 * ENG-2113: "continue on AgentWeb credits". When a Claude-plan turn stopped after the user's message was saved, that message sits in the chat followed
 * by one or more plan-stop notes. If the stopped turn is KNOWN to have run no tool (the backend marked the note `resumable`), the same message can be
 * answered again, on any funding, without storing it twice and without repeating an action. Anything else is not continuable and the client falls back to
 * "send it again as a new message".
 *
 * Pure: the caller passes the stored messages. The controller checks this before the turn and the turn checks it again right before it skips the save.
 */

/** The note a plan stop leaves in the chat. `resumable` is written by the controller only when the turn is known to have run no tool. */
export const PLAN_STOP_NOTE_KIND = "claude-plan-stop";

interface StoredMessage {
  role?: string;
  content?: unknown;
  metadata?: { kind?: unknown; resumable?: unknown; attachments?: unknown } | null;
}

export type ResumableMessage = { ok: true; content: string } | { ok: false };

/**
 * The saved user message that can be answered again, or `{ ok: false }`. Requires: the chat ends with one or more plan-stop notes that are ALL marked
 * resumable, directly after a plain user message (not an automatic continuation or any other kind, and with no attachments).
 */
export function findResumableUserMessage(messages: readonly StoredMessage[] | undefined): ResumableMessage {
  if (!Array.isArray(messages) || messages.length < 2) return { ok: false };
  let i = messages.length - 1;
  let notes = 0;
  while (i >= 0) {
    const m = messages[i];
    if (m?.role === "assistant" && m.metadata?.kind === PLAN_STOP_NOTE_KIND) {
      if (m.metadata.resumable !== true) return { ok: false };
      notes++;
      i--;
      continue;
    }
    break;
  }
  if (notes === 0 || i < 0) return { ok: false };
  const user = messages[i];
  if (user?.role !== "user" || typeof user.content !== "string" || user.content.length === 0) return { ok: false };
  if (user.metadata?.kind !== undefined && user.metadata.kind !== null) return { ok: false };
  // Attachments reach the model only through the message being sent again with its files; a continue sends none, so it would answer without them.
  const attachments = user.metadata?.attachments;
  if (Array.isArray(attachments) ? attachments.length > 0 : attachments !== undefined && attachments !== null) return { ok: false };
  return { ok: true, content: user.content };
}
