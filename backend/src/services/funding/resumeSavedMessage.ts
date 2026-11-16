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

/**
 * Written when a continue starts, before anything runs. It sits after the notes it consumed, so a continue whose own stop note could not be saved (or that has
 * not finished) leaves the chat NOT continuable: the tail must be a resumable plan-stop note written after the marker, i.e. by a turn that ran no tool.
 */
export const CONTINUE_MARKER_KIND = "claude-plan-continue";

/** The chat changed, or could not be read, between the request check and the turn: the continue is refused (409), never turned into an AgentWeb error. */
export class ResumeNotAvailableError extends Error {
  constructor() {
    super("RESUME_SAVED_MESSAGE_NOT_AVAILABLE");
    this.name = "ResumeNotAvailableError";
  }
}

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
  const last = messages[messages.length - 1];
  // The very last message must be a resumable stop note: a continue marker last means a continue started and has not left a verdict.
  if (!(last?.role === "assistant" && last.metadata?.kind === PLAN_STOP_NOTE_KIND && last.metadata.resumable === true)) return { ok: false };
  let i = messages.length - 1;
  while (i >= 0) {
    const m = messages[i];
    if (m?.role === "assistant" && m.metadata?.kind === PLAN_STOP_NOTE_KIND) {
      if (m.metadata.resumable !== true) return { ok: false };
      i--;
      continue;
    }
    if (m?.role === "assistant" && m.metadata?.kind === CONTINUE_MARKER_KIND) {
      i--;
      continue;
    }
    break;
  }
  if (i < 0) return { ok: false };
  const user = messages[i];
  if (user?.role !== "user" || typeof user.content !== "string" || user.content.length === 0) return { ok: false };
  if (user.metadata?.kind !== undefined && user.metadata.kind !== null) return { ok: false };
  // Attachments reach the model only through the message being sent again with its files; a continue sends none, so it would answer without them.
  const attachments = user.metadata?.attachments;
  if (Array.isArray(attachments) ? attachments.length > 0 : attachments !== undefined && attachments !== null) return { ok: false };
  return { ok: true, content: user.content };
}
