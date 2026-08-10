import { isPublishName } from './hardeningGaps';
import { resolveSchedulePublishAuthorization } from './schedulePublishAuthorization';

/**
 * ENG-827 — enforcing publish consent at the moment a publish tool RUNS.
 *
 * The scheduled runner re-reads consent before every verification attempt, which
 * stops a revoked run being nudged and tells the model its authorization is void.
 * That is enforcement BETWEEN turns — and a single turn is one worker invocation
 * that can iterate over many internal model steps and tool calls for minutes. An
 * owner who revokes ten seconds after a turn begins has, until now, no effect on
 * the publish that turn makes a minute later: the loop is not at a re-check point,
 * and the model is working from the prompt it was given at the start of the turn.
 *
 * A kill switch that only takes effect at a loop boundary is not a kill switch, so
 * the authorization is checked HERE too, against live storage, immediately before
 * the tool executes. There is no window left after this point.
 *
 * This lives in the central dispatcher rather than inside each publishing tool for
 * the same reason as the anonymous-account and external-MCP refusals it sits with:
 * a gate that must be remembered for every new publishing tool is a gate that
 * silently rots. `isPublishName` also matches future `publish_*` / `post_on_*`
 * tools by prefix, so a new one is covered on the day it is added.
 */

export interface ScheduledPublishRefusal {
  success: false;
  error: string;
}

export interface ScheduledPublishGuardDeps {
  getChatSession: (sessionId: string) => Promise<any>;
  getScheduleById: (scheduleId: string) => Promise<any>;
}

async function defaultDeps(): Promise<ScheduledPublishGuardDeps> {
  const [{ chatbotDb }, { scheduleDb }] = await Promise.all([
    import('../services/chatbotService'),
    import('../services/db'),
  ]);
  return {
    getChatSession: (sessionId: string) => chatbotDb.getChatSession(sessionId),
    getScheduleById: (scheduleId: string) => scheduleDb.getScheduleById(scheduleId),
  };
}

/**
 * One retry, no backoff. This sits directly in front of a user-visible tool call,
 * so the budget is "absorb a dropped connection", not "ride out an outage" —
 * during a real outage the refusal is the correct answer anyway.
 */
async function readSessionWithOneRetry(
  deps: ScheduledPublishGuardDeps,
  sessionId: string
): Promise<any> {
  try {
    return await deps.getChatSession(sessionId);
  } catch (firstAttemptError) {
    console.warn(
      `ENG-827: session read for ${sessionId} failed while checking publish consent; retrying once:`,
      firstAttemptError
    );
    return await deps.getChatSession(sessionId);
  }
}

function refuse(toolName: string, detail: string): ScheduledPublishRefusal {
  return {
    success: false,
    error:
      `${toolName} was not executed: this unattended scheduled run is not authorized to publish. ${detail} ` +
      `Do NOT retry this tool in this run. Save the content as a draft, state plainly that it is ` +
      `drafted and awaiting the owner's approval, and finish the rest of the task.`,
  };
}

/**
 * Returns a refusal to hand back to the model in place of executing `toolName`, or
 * null when the call may proceed.
 *
 * Only scheduled sessions are gated. An interactive session has a human in the
 * conversation who approves the post there and then — that path proceeds normally,
 * and costs not even a read for any non-publishing tool or any session it was given
 * no id for, because the guard returns before touching storage in those cases.
 *
 * Everything that cannot be established is treated as withheld. There is no
 * "probably fine" branch: the action being gated is irreversible.
 */
export async function refuseUnauthorizedScheduledPublish(
  toolName: string,
  context: any,
  deps?: ScheduledPublishGuardDeps
): Promise<ScheduledPublishRefusal | null> {
  if (!isPublishName(toolName)) return null;
  const sessionId = context?.sessionId;
  if (!sessionId || typeof sessionId !== 'string') return null;

  const resolved = deps ?? (await defaultDeps());

  let session: any;
  try {
    // The session read is what identifies an unattended run, so a failure here is
    // not "probably interactive" — it is "unknown", and an unknown authorization
    // must not produce an irreversible public post. Retry once first, because the
    // cost of the two outcomes is wildly asymmetric in BOTH directions: a refused
    // interactive post is recoverable in seconds by a human who is right there,
    // while a post made against consent the owner has just withdrawn cannot be
    // un-made. One retry absorbs the transient blip; a persistent failure refuses.
    session = await readSessionWithOneRetry(resolved, sessionId);
  } catch (sessionReadError) {
    console.error(
      `ENG-827: could not read session ${sessionId} to check publish consent for ${toolName} ` +
      '(after one retry); withholding the publish (fail-closed):', sessionReadError
    );
    return {
      success: false,
      error:
        `${toolName} was not executed: this run's publishing authorization could not be confirmed, ` +
        `and an unconfirmed permission is treated as withheld — a live post cannot be un-made. ` +
        `Nothing was published. If someone is present in this conversation, they can ask you to try ` +
        `again; otherwise save the content as a draft, say it is awaiting approval, and carry on ` +
        `with the rest of the task.`,
    };
  }

  if (session?.sessionType !== 'scheduled') return null;

  const scheduleId = String(session?.pageIdentifier || '').match(/scheduleId:([a-f0-9-]+)/)?.[1];
  if (!scheduleId) {
    // A scheduled session whose schedule cannot be identified has no consent record
    // to stand on. The prompt directive treats this same state as 'withheld'.
    return refuse(toolName, 'This run could not be matched to a schedule, so no owner authorization could be confirmed.');
  }

  let authorization;
  try {
    authorization = resolveSchedulePublishAuthorization(await resolved.getScheduleById(scheduleId));
  } catch (scheduleReadError) {
    console.error(
      `ENG-827: could not read schedule ${scheduleId} to check publish consent for ${toolName}; ` +
      'withholding the publish (fail-closed):', scheduleReadError
    );
    return refuse(toolName, 'The schedule\'s publishing permission could not be read, and an unconfirmed permission is treated as withheld.');
  }

  if (!authorization.authorized || !authorization.tools.includes(toolName)) {
    return refuse(
      toolName,
      authorization.tools.length > 0
        ? `The owner authorized only: ${authorization.tools.join(', ')}.`
        : 'The owner has not enabled "Publish without my review" for this schedule (or has just switched it off).'
    );
  }

  return null;
}
