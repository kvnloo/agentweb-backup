import {
  resolveSchedulePublishAuthorization,
  narrowPublishAuthorization,
  isPublishCall,
  SchedulePublishAuthorization,
} from './schedulePublishAuthorization';
import { extractScheduleId } from './schedulePublishApproval';

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
 * silently rots. `isPublishCall` also matches future `publish_*` / `post_on_*` tools
 * by prefix, so a new one is covered on the day it is added, and classifies the two
 * mixed-action tools (`twitter_manage_post`, `linkedin_manage_post`) per action so a
 * thread or repost is gated while an analytics read is not.
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
 * Name of the last-moment re-validation the dispatcher hangs on a publishing tool's
 * context. A handler that does slow work between being admitted and committing the
 * irreversible act — resolving accounts, downloading media, uploading a video, which
 * for YouTube is minutes — calls this immediately before it commits, and abandons the
 * post if it returns a refusal.
 *
 * The dispatch-time check alone would admit such a call and then let it publish long
 * after the owner switched consent off, because the decision was made at the START of
 * work that outlives it. Handlers that commit immediately need nothing extra; the
 * dispatch check already covers them, and covers every publishing tool by prefix.
 */
export type AssertPublishStillAuthorized = () => Promise<ScheduledPublishRefusal | null>;

/**
 * Returns the context to hand the handler: for a publishing tool, the same context
 * plus the re-validation hook; for anything else, the context untouched.
 */
/**
 * Runs the hook if the dispatcher attached one. Returns a refusal to hand back in
 * place of committing, or null to proceed. Safe on any context — a handler reached
 * outside tool dispatch (direct service call, interactive route) simply proceeds.
 */
export async function publishWithdrawnMidFlight(context: any): Promise<ScheduledPublishRefusal | null> {
  return (await context?.assertPublishStillAuthorized?.()) ?? null;
}

/**
 * Header the MCP HTTP client puts a scheduled run's session id in, so a route on the
 * far side of a self-call can rebuild the run's identity. Set in
 * `mcp/server/httpClient.ts`; read by the routes that do the irreversible work.
 */
export const SCHEDULED_SESSION_HEADER = 'X-AgentWeb-Session';

/**
 * Rebuild the re-validation hook on the far side of a self-call.
 *
 * The hook is a closure, so it cannot cross an HTTP boundary — only the session id it
 * is keyed on can. A route that does the slow, irreversible work for a publishing tool
 * remakes the identical hook from that id and calls `publishWithdrawnMidFlight` right
 * before it commits. Absent header means an ordinary interactive call, which is not
 * gated and gets no hook.
 */
export function publishRevalidationForForwardedRun(
  req: { header(name: string): string | undefined },
  toolName: string
): any {
  const sessionId = req.header(SCHEDULED_SESSION_HEADER);
  if (!sessionId) return undefined;
  return attachPublishRevalidation(toolName, { sessionId });
}

export function attachPublishRevalidation(toolName: string, context: any, args?: any): any {
  if (!isPublishCall(toolName, args)) return context;
  // Capture the ARGS the call was admitted with, so the last-moment re-check
  // classifies the same call the same way an action-scoped tool was admitted under.
  const assertPublishStillAuthorized: AssertPublishStillAuthorized = () =>
    refuseUnauthorizedScheduledPublish(toolName, context, undefined, args);
  return { ...(context ?? {}), assertPublishStillAuthorized };
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

/**
 * The authorization this run was ADMITTED under, read back from the session the
 * scheduled runner stamped before its first turn.
 *
 * A run keeps the permissions it started with. Live schedule state is still read on
 * every publish so a revocation bites immediately, but it is intersected with this —
 * so consent granted while the run is in flight cannot reach into it. Without the
 * intersection, an owner ticking the box mid-run would publish content that a
 * draft-only run had already generated under a prompt telling it not to publish:
 * the owner never saw that content, and never approved a run that produced it.
 *
 * A missing or malformed stamp is NOT authorized, like every other ambiguous case
 * here. The runner writes it only for runs admitted as authorized, so absent is the
 * ordinary state of every draft-only run, and the correct answer for both a session
 * that predates this field and a run whose stamp could not be written.
 */
export function readAdmittedAuthorization(session: any): SchedulePublishAuthorization {
  const admission = session?.publishAdmission;
  if (!admission || admission.authorized !== true) return { authorized: false, tools: [] };
  const tools = Array.isArray(admission.tools)
    ? admission.tools.filter((tool: unknown): tool is string => typeof tool === 'string')
    : [];
  // Consent is tool-scoped, so a stamp with no tools has unknown scope and authorizes
  // nothing — the same rule the resolver applies.
  return { authorized: tools.length > 0, tools };
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
  deps?: ScheduledPublishGuardDeps,
  args?: any
): Promise<ScheduledPublishRefusal | null> {
  // Two tools publish only on SOME of their actions (an X thread, a LinkedIn
  // repost) and read on the rest, so the classification takes the call's args:
  // gating the whole tool would refuse a scheduled analytics read, and gating
  // none of it would leave a public post reachable without consent.
  if (!isPublishCall(toolName, args)) return null;
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

  // A read that SUCCEEDS but returns no record is not "interactive" — it is unknown,
  // and unknown fails closed like every other ambiguous case here (Greptile, security).
  // The retry above only covers a THROWN error; a missing key comes back as undefined
  // rather than an exception, so without this a session deleted mid-run, or an
  // eventually-consistent read that has not caught up, would take the interactive path
  // and publish with no consent check at all.
  if (!session) {
    console.error(
      `ENG-827: session ${sessionId} could not be found while checking publish consent for ` +
      `${toolName}; withholding the publish (fail-closed).`
    );
    return refuse(
      toolName,
      'This run could not be identified, so no owner authorization could be confirmed.'
    );
  }

  if (session.sessionType !== 'scheduled') return null;

  // Use ENG-803's ANCHORED parser rather than an unanchored search. `pageIdentifier`
  // is `"<scheduleName>|scheduleId:<id>"`, and the schedule NAME is owner-supplied
  // text sitting in front of the authoritative id — so an unanchored match takes the
  // FIRST hit and a schedule named `Evil scheduleId:deadbeef` resolves this run's
  // consent against a DIFFERENT schedule's record. Verified: on
  // `"Evil scheduleId:deadbeef|scheduleId:<real>"` the unanchored form returned
  // `deadbeef`. One shared, audited parser so the two gates cannot disagree about
  // which schedule a run belongs to.
  const scheduleId = extractScheduleId(session?.pageIdentifier);
  if (!scheduleId) {
    // A scheduled session whose schedule cannot be identified has no consent record
    // to stand on. The prompt directive treats this same state as 'withheld'.
    return refuse(toolName, 'This run could not be matched to a schedule, so no owner authorization could be confirmed.');
  }

  // What this run was admitted with. Read BEFORE the schedule so a run that never
  // carried publishing rights is refused without a second storage read at all.
  const admitted = readAdmittedAuthorization(session);
  if (!admitted.authorized) {
    return refuse(
      toolName,
      'This run started without permission to publish, and a run keeps the permissions it began with. ' +
      'If publishing has since been enabled for this schedule, it takes effect on the next run.'
    );
  }

  let latest;
  try {
    latest = resolveSchedulePublishAuthorization(await resolved.getScheduleById(scheduleId));
  } catch (scheduleReadError) {
    console.error(
      `ENG-827: could not read schedule ${scheduleId} to check publish consent for ${toolName}; ` +
      'withholding the publish (fail-closed):', scheduleReadError
    );
    return refuse(toolName, 'The schedule\'s publishing permission could not be read, and an unconfirmed permission is treated as withheld.');
  }

  // Live state can only ever REMOVE rights from here: `narrowPublishAuthorization` is
  // the same monotonic intersection the turn loop applies, so a revocation stops this
  // publish immediately while a mid-run grant is invisible to this run.
  const authorization = narrowPublishAuthorization(admitted, latest);

  // Gate on the boolean AND the approved scope. Consent is recorded against the publish
  // tools the owner could see when they gave it, so a run can be authorized for one tool
  // while reaching for another they never approved — that call is refused.
  if (!authorization.authorized || !authorization.tools.includes(toolName)) {
    return refuse(
      toolName,
      authorization.tools.length > 0
        ? `The owner authorized only: ${authorization.tools.join(', ')}.`
        : 'The owner has not enabled unattended publishing for this schedule (or has just switched it off).'
    );
  }

  return null;
}
