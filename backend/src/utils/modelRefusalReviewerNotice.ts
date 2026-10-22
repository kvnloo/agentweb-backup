import { buildModelUnavailableBody, type ModelUnavailableError } from '../services/agentMode/modelUnavailable';

/**
 * ENG-669 PR-C: what a headless revision caller (Slack "Request changes", the batch-review auto-revision, the
 * human-eval image revision) tells the reviewer when runVerifiedChat refused the chat's model (model_unavailable: the
 * AgentWeb Model switched off or unavailable for the owner's plan, or a selection outside the plan). The owner must
 * change the chat's model, so this is not an outage: callers post this instead of the generic "didn't go through"
 * notice and do NOT page on-call. runVerifiedChat has already saved the refusal to the chat (recordModelRefusal).
 */
export const MODEL_REFUSAL_REVIEWER_ADVICE = 'To fix it, choose another model for this chat in AgentWeb, then retry the feedback.';

export async function modelRefusalReviewerNotice(error: ModelUnavailableError): Promise<string> {
  let sentence: string | undefined;
  try {
    // The controller's body names a concrete model by its registry display name (lazy: this util is imported by
    // modules the controller graph reaches).
    const controller = await import('../controllers/agentModeController');
    if (typeof controller.modelUnavailableBody === 'function') sentence = controller.modelUnavailableBody(error).error;
  } catch {
    // fall through to the registry-free sentence
  }
  sentence ??= buildModelUnavailableBody(error).error;
  return `:no_entry_sign: This revision didn't run. ${sentence} ${MODEL_REFUSAL_REVIEWER_ADVICE}`;
}
