/**
 * ENG-2113 approval cards on the Claude plan route: the shapes shared by the plan backend and Emma's service, kept in a types-only file so neither imports
 * the other at run time.
 *
 * What the plan route does when a tool asked for the user's confirmation (a "halt") is exactly what Emma's own chat loop does at the end of an iteration:
 * the halts of one model message become ONE approval deck (the same builders), the deck is written to the session with the same conditional write, and the
 * turn's visible answer is the deck prompt. The model's own text after the halt is not shown (Emma's loop breaks there and never asks the model again).
 */
import type { PendingApprovalDeck } from "../agentMode/core/approvalDeck";

/** What `stageApprovalDeckForPlanTurn` made of a turn's halts. */
export type PlanDeckStage =
  /** A deck was written to the session. `prompt` is the visible answer, `deck` goes to the browser and onto the halt message's metadata. */
  | { kind: "deck"; deck: PendingApprovalDeck; prompt: string }
  /** No deck (a halt kind that has none, a build that failed, or another request holds the session's one deck slot): the plain-text confirmation prompt, as in Emma's loop. */
  | { kind: "text"; prompt: string }
  /** Nothing to show (should not happen: a halt always carries a prompt). The caller keeps its own fixed note. */
  | { kind: "none" };

/** The metadata Emma's loop puts on a deck's halt message, so the portal renders the card from it. */
export function deckMessageMetadata(deck: PendingApprovalDeck): Record<string, unknown> {
  return { awaitingUserConfirmation: true, pendingApprovalDeckId: deck.deckId, approvalDeckItems: deck.items };
}
