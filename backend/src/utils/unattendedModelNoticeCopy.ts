import type { ModelUnavailableReason } from '../services/agentMode/modelUnavailable';

/**
 * ENG-669 PR-D: every customer-facing word of the "your unattended run's model is outside your plan (or gone)" owner
 * notices, in one place for copy review. Two notices:
 *  - a SCHEDULE whose saved model was refused (runScheduledChat records the run as blocked and emails once per change
 *    into that state), and
 *  - a WORK PLAN STEP whose model was refused in an unattended session (pauseWorkPlanForUnavailableStepModel emails
 *    once per session and step).
 *
 * Plain text only: emailService escapes every string before it goes into HTML. Callers pass a model label that has
 * already been through sanitizeModelLabel. No prices or amounts: the remedy is "choose another model" or "upgrade",
 * and the pricing page says what an upgrade costs.
 *
 * The in-chat pause message and the 422 bodies are NOT here: they are modelUnavailable.ts's and
 * workPlanStepModels.ts's, unchanged by this notice.
 */

/** A link in the notice. `path` is relative to the customer portal (emailService prefixes CUSTOMER_FRONTEND_URL). */
export interface ModelNoticeAction {
  label: string;
  path: string;
}

export interface ModelNoticeCopy {
  subject: string;
  headline: string;
  /** The line under the headline: the schedule or chat the notice is about. */
  subheading: string;
  paragraphs: string[];
  /** First action is the primary button; any further one is a secondary link. */
  actions: ModelNoticeAction[];
  /** The small print under the buttons. */
  footer: string;
}

/** Where the owner changes a schedule's model (the portal's schedules tab). */
export const SCHEDULES_PATH = '/agent-mode?tab=scheduled';
/** Where the owner compares plans. */
export const PRICING_PATH = '/pricing';

const COMPARE_PLANS: ModelNoticeAction = { label: 'Compare plans', path: PRICING_PATH };

/** Only `not_in_plan` can be fixed by upgrading; a model that is not served or not selectable is gone for every plan. */
function isPlanLimit(reason: ModelUnavailableReason): boolean {
  return reason === 'not_in_plan';
}

function whyClause(reason: ModelUnavailableReason): string {
  return isPlanLimit(reason) ? "which isn't included in your current plan" : 'which is no longer available';
}

const ONCE_ONLY =
  "We'll only email you once about this, not on every run. You'll also see it on the schedule's card in AgentWeb.";

export function buildScheduleModelNotice(input: {
  scheduleName: string;
  modelLabel: string;
  reason: ModelUnavailableReason;
}): ModelNoticeCopy {
  const { scheduleName, modelLabel, reason } = input;
  const planLimit = isPlanLimit(reason);
  return {
    // Same style as the other schedule emails (emailService): a leading emoji, and the name quoted mid-sentence.
    subject: planLimit
      ? `⚠️ Your scheduled chat "${scheduleName}" didn't run: its model isn't included in your plan`
      : `⚠️ Your scheduled chat "${scheduleName}" didn't run: its model is no longer available`,
    headline: planLimit
      ? "This schedule's model isn't included in your plan"
      : "This schedule's model is no longer available",
    subheading: scheduleName,
    paragraphs: [
      `Your scheduled chat "${scheduleName}" is set to run on ${modelLabel}, ${whyClause(reason)}. Its latest run did not start, and nothing was sent to a different model.`,
      planLimit
        ? `Each run of this schedule will stop in the same way until this is resolved. To fix this, please open the schedule and choose a model your plan includes, or upgrade your plan to keep using ${modelLabel}.`
        : 'Each run of this schedule will stop in the same way until this is resolved. To fix this, please open the schedule and choose another model.',
      ONCE_ONLY,
    ],
    actions: [
      { label: "Change the schedule's model", path: SCHEDULES_PATH },
      ...(planLimit ? [COMPARE_PLANS] : []),
    ],
    footer: 'This is an automated email from your scheduled chat.',
  };
}

export function buildWorkPlanStepModelNotice(input: {
  stepCount: number;
  modelLabel: string;
  reason: ModelUnavailableReason;
  sessionId: string;
  /** Set when the session is a run of one of the owner's schedules. */
  scheduleName?: string | null;
  /** The chat's title, used when there is no schedule to name. */
  sessionTitle?: string | null;
}): ModelNoticeCopy {
  const { stepCount, modelLabel, reason, sessionId } = input;
  const planLimit = isPlanLimit(reason);
  const scheduleName = input.scheduleName?.trim();
  const sessionTitle = input.sessionTitle?.trim();
  const where = scheduleName
    ? `in a run of your scheduled chat "${scheduleName}"`
    : sessionTitle ? `in your chat "${sessionTitle}"` : 'in one of your chats';
  const name = scheduleName || sessionTitle;
  const workPlan = name ? `Your work plan "${name}"` : 'Your work plan';
  return {
    subject: planLimit
      ? `⚠️ ${workPlan} paused: a step's model isn't included in your plan`
      : `⚠️ ${workPlan} paused: a step's model is no longer available`,
    headline: planLimit
      ? "A work plan step's model isn't included in your plan"
      : "A work plan step's model is no longer available",
    subheading: scheduleName || sessionTitle || 'Work plan',
    paragraphs: [
      `Step ${stepCount} of the work plan ${where} uses ${modelLabel}, ${whyClause(reason)}. The plan paused at that step, and nothing was sent to a different model.`,
      planLimit
        ? `To resume the plan, please open the chat, choose a model your plan includes in the model picker, and send a message. Alternatively, you can upgrade your plan to keep using ${modelLabel}.`
        : 'To resume the plan, please open the chat, choose another model in the model picker, and send a message.',
      "To prevent this from happening again, please change that step's model in the work plan's settings.",
    ],
    actions: [
      { label: 'Open the chat', path: `/agent-mode/${encodeURIComponent(sessionId)}` },
      ...(planLimit ? [COMPARE_PLANS] : []),
    ],
    footer: scheduleName ? 'This is an automated email from your scheduled chat.' : 'This is an automated email from AgentWeb.',
  };
}
