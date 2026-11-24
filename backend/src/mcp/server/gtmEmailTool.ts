/**
 * ENG-2840 (W2-4 follow-up): `send_gtm_status_report`, the one MCP tool that emails people.
 *
 * Emma has had this tool since GTM plans existed. Over MCP it was held back (the report templates put caller text into HTML unescaped, and
 * one call mails every distinct phase contact). The templates escape now (W2-4), the shared mail queue gives it its own bounded lane (PR
 * #4236), and this tool adds the three things an outside agent needs on top:
 *
 *  1. an opt-in key scope: only an `aw_` key that holds `gtm:email` may call it (`requiredScope` + `apiKeyOnly`, the same gate as the org
 *     memory writes). A default key, an OAuth client and a delegated session are refused before this code runs;
 *  2. explicit choices: nobody is emailed by default, at least one `notify_*` must be true, an argument that is not an input is refused by
 *     name, the message is at most 2,000 characters;
 *  3. limits (gtmEmailLimits.ts): at most 10 people a call (the report service refuses before sending anything when it would reach more),
 *     about 50 emails an hour per ACCOUNT (all of its keys together), and the same report is not sent twice within 10 minutes.
 *
 * The limits bound the volume, not the audience. The report goes to the addresses on the plan, and a key can write those itself
 * (`manage_gtm_plan update dri`, which needs only `tools:execute`): a key that holds `gtm:email` can email any address it puts on a plan it
 * owns, with up to 2,000 characters of its own text. The account owner grants the scope knowing that; the audit line is how it is seen.
 *
 * It calls the portal routes through `mcpFetch`, as the other GTM tools do, so the plan owner check stays on the route (the two report routes
 * read no delegation or restriction claim: an `aw_` key is never a share-link visitor); a key can email only the people on ITS OWN user's
 * plans. A POST self-call is never retried, so a network blip cannot send a report twice.
 *
 * Every attempt writes one audit line (`mcp_gtm_email`): who (user, key), which plan and phase, which people were chosen, the outcome and the
 * counts. Never the message and never an address. `userId` is always the account that owns the plan and the key. `apiKeyId` is the key that
 * OPENED the MCP session: a second key of the same user that reuses that session id is checked on its own scopes (per request) but logged under
 * the opener's id, as every MCP tool's audit line is (mcpServer.ts builds a session's context once). Binding sessions to keys is a change to
 * the session layer for every tool and is not made here.
 *
 * Update-time notifications (`notify_*` on `update_work_item`) are NOT offered: update the item, then send a report.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { exactArgs } from './memoryTools';
import { idArg } from './gtmTools';
import { API_KEY_SCOPE_GTM_EMAIL } from './apiKeyScopes';
import {
  GTM_EMAIL_COOLDOWN_MS,
  GTM_EMAIL_HOURLY_BUDGET,
  GTM_EMAIL_MAX_MESSAGE_CHARS,
  GTM_EMAIL_MAX_RECIPIENTS,
  GtmEmailLimiter,
  gtmEmailLimiter,
  reportFingerprint,
} from './gtmEmailLimits';

const TOOL = 'send_gtm_status_report';
const PLAN_BASE = '/api/gtm-plan';
const enc = encodeURIComponent;

const INPUTS = ['plan_id', 'phase_id', 'notify_user', 'notify_plan_poc', 'notify_phase_poc', 'notify_phase_pocs', 'message'] as const;

/** Real plan and phase ids are letters, digits, hyphens and underscores. This tool sends email, so it accepts nothing else: no `.`, `..`, slash or space. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function refuse(message: string): never {
  throw new Error(`${TOOL}: ${message} Nothing was emailed.`);
}

/** A choice must be `true` or `false`; leaving it out (or null) is false. Text such as "true" is refused, not guessed. */
function flagArg(a: Record<string, unknown>, field: string): boolean {
  const value = a[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') refuse(`${field} must be true or false.`);
  return value as boolean;
}

export interface GtmEmailRequest {
  kind: 'phase' | 'plan';
  planId: string;
  phaseId?: string;
  path: string;
  body: Record<string, unknown>;
  /** Which people were chosen (true values only), for the fingerprint and the audit line. */
  flags: Record<string, boolean>;
  message?: string;
  /** The most emails this call could send: what it reserves against the key's hour before it starts. */
  reserve: number;
}

function strictId(field: string, value: unknown): string {
  const id = idArg(TOOL, field, value);
  if (!ID_PATTERN.test(id)) refuse(`${field} is not a valid id. Use an id returned by manage_gtm_plan get or list_gtm_plans.`);
  return id;
}

/** The request a `send_gtm_status_report` call makes, or the refusal. Pure: nothing is sent and no limit is touched here. */
export function gtmEmailRequest(args: unknown): GtmEmailRequest {
  try {
    return buildRequest(args);
  } catch (err: any) {
    // the shared argument checks end "Nothing was changed."; for a tool that emails, say what matters
    throw new Error(String(err?.message ?? err).replace(/ Nothing was changed\.$/, ' Nothing was emailed.'));
  }
}

function buildRequest(args: unknown): GtmEmailRequest {
  const a = exactArgs(TOOL, args, INPUTS);
  const planId = strictId('plan_id', a.plan_id);
  const phaseId = a.phase_id === undefined || a.phase_id === null ? undefined : strictId('phase_id', a.phase_id);
  const kind = phaseId === undefined ? 'plan' : 'phase';

  const user = flagArg(a, 'notify_user');
  const planPoc = flagArg(a, 'notify_plan_poc');
  const phasePoc = flagArg(a, 'notify_phase_poc');
  const phasePocs = flagArg(a, 'notify_phase_pocs');
  if (kind === 'phase' && phasePocs) refuse('notify_phase_pocs is for a whole-plan report (leave out phase_id); for one phase use notify_phase_poc.');
  if (kind === 'plan' && phasePoc) refuse('notify_phase_poc is for one phase (send phase_id); for a whole-plan report use notify_phase_pocs, which emails every phase contact.');
  if (!user && !planPoc && !phasePoc && !phasePocs) {
    refuse('choose who gets the report: set at least one of notify_user, notify_plan_poc, notify_phase_poc (a phase report) or notify_phase_pocs (a plan report) to true. Nobody is emailed by default.');
  }

  let message: string | undefined;
  if (a.message !== undefined && a.message !== null) {
    if (typeof a.message !== 'string') refuse('message must be text.');
    const raw = a.message as string;
    if (raw.length > GTM_EMAIL_MAX_MESSAGE_CHARS) refuse(`message is too long (${raw.length} characters; the most is ${GTM_EMAIL_MAX_MESSAGE_CHARS}).`);
    message = raw.trim() === '' ? undefined : raw.trim();
  }

  const flags: Record<string, boolean> = {
    ...(user ? { notify_user: true } : {}),
    ...(planPoc ? { notify_plan_poc: true } : {}),
    ...(phasePoc ? { notify_phase_poc: true } : {}),
    ...(phasePocs ? { notify_phase_pocs: true } : {}),
  };
  const notifications = {
    ...(user ? { notifyUser: true } : {}),
    ...(planPoc ? { notifyPlanPoc: true } : {}),
    ...(phasePoc ? { notifyPhasePoc: true } : {}),
    ...(phasePocs ? { notifyPhasePocs: true } : {}),
    // enforced by the report service where the recipients are resolved: over it, nothing is sent
    maxRecipients: GTM_EMAIL_MAX_RECIPIENTS,
  };
  // every phase contact is as many people as the plan has phases: reserve the whole cap for that choice, one each for the others
  const reserve = Math.min(GTM_EMAIL_MAX_RECIPIENTS, (user ? 1 : 0) + (planPoc ? 1 : 0) + (phasePoc ? 1 : 0) + (phasePocs ? GTM_EMAIL_MAX_RECIPIENTS : 0));

  return {
    kind,
    planId,
    ...(phaseId !== undefined ? { phaseId } : {}),
    path: phaseId !== undefined
      ? `${PLAN_BASE}/${enc(planId)}/phases/${enc(phaseId)}/send-status-report`
      : `${PLAN_BASE}/${enc(planId)}/send-status-report`,
    body: { notifications, ...(message !== undefined ? { message } : {}) },
    flags,
    ...(message !== undefined ? { message } : {}),
    reserve,
  };
}

/** The HTTP status in a self-call error ("API error (404): ..."), or undefined when the failure was not an HTTP answer. */
function statusOf(err: unknown): number | undefined {
  const match = /^API error \((\d{3})\)/.exec(String((err as any)?.message ?? ''));
  return match ? Number(match[1]) : undefined;
}

/** Run one call: validate, take the limits, send, settle the limits, audit. `limiter` is injectable for tests. */
export async function sendGtmStatusReport(args: unknown, context: any, limiter: GtmEmailLimiter = gtmEmailLimiter): Promise<unknown> {
  const audit = (fields: Record<string, unknown>) =>
    console.info(JSON.stringify({
      event: 'mcp_gtm_email',
      tool: TOOL,
      userId: context?.userId,
      apiKeyId: context?.apiKeyId,
      external: context?.externalMcp === true,
      ...fields,
    }));

  let request: GtmEmailRequest;
  try {
    request = gtmEmailRequest(args);
  } catch (err: any) {
    audit({ outcome: 'refused', reason: 'invalid', error: String(err?.message ?? err).slice(0, 200) });
    throw err;
  }
  const about = { kind: request.kind, planId: request.planId, phaseId: request.phaseId, flags: Object.keys(request.flags) };

  // Counted per ACCOUNT: every key of one user shares the hour and the cooldown, so minting more keys does not buy more email.
  const accountKey = context?.userId ? `account:${context.userId}` : context?.apiKeyId ? `key:${context.apiKeyId}` : 'unknown';
  const fingerprint = reportFingerprint({ planId: request.planId, phaseId: request.phaseId, flags: request.flags, message: request.message });
  const reservation = limiter.reserve(accountKey, fingerprint, request.reserve);
  if (!reservation.ok) {
    audit({ outcome: 'refused', reason: reservation.reason, ...about });
    throw new Error(`${TOOL}: ${reservation.message}`);
  }

  let answer: any;
  try {
    answer = await mcpFetch({ method: 'POST', path: request.path, context: ctx(context), body: request.body });
  } catch (err: any) {
    const status = statusOf(err);
    // A 4xx means the route refused before sending (no recipient, over the cap, wrong plan): nothing went out, so the reservation and the
    // cooldown are given back. Anything else (a 5xx, a timeout) is ambiguous: keep both, so a retry cannot mail anyone twice.
    if (status !== undefined && status >= 400 && status < 500) limiter.release(reservation.ticket);
    audit({ outcome: 'error', status, ...about, error: String(err?.message ?? err).slice(0, 200) });
    throw err;
  }

  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const sent = count(answer?.sent);
  const failed = count(answer?.failed);
  const suppressed = count(answer?.suppressed) ?? 0;
  // Settle to what was attempted; if the route did not say, keep the whole reservation (the cautious reading).
  if (sent !== undefined && failed !== undefined) limiter.settle(reservation.ticket, sent + failed + suppressed);
  audit({ outcome: 'ok', ...about, sent, failed, suppressed });
  return answer;
}

mcpToolRegistry.register({
  name: TOOL,
  readOnly: false,
  requiredScope: API_KEY_SCOPE_GTM_EMAIL,
  apiKeyOnly: true,
  requiresUserAccount: true,
  definition: {
    name: TOOL,
    description: 'Email a status report for one phase or for a whole GTM plan to the people you choose. Needs an API key with the gtm:email scope. '
      + 'plan_id (required). phase_id: send it for a phase report, leave it out for a whole-plan report. '
      + 'Choose who gets it by setting at least one of notify_user (the account owner), notify_plan_poc (the plan contact), notify_phase_poc (a phase report: that phase\'s contact), '
      + 'notify_phase_pocs (a plan report: every phase contact) to true; nobody is emailed by default. message: an optional note, at most '
      + `${GTM_EMAIL_MAX_MESSAGE_CHARS} characters. `
      + `Limits: at most ${GTM_EMAIL_MAX_RECIPIENTS} people per call (a report that would reach more sends nothing), about ${GTM_EMAIL_HOURLY_BUDGET} emails an hour per account (all your keys together), `
      + `and the same report is not sent twice within ${GTM_EMAIL_COOLDOWN_MS / 60_000} minutes. `
      + 'The email goes from AgentWeb to whatever addresses are on the plan, including contacts set with manage_gtm_plan, so check them first with manage_gtm_plan get. '
      + 'The answer says how many emails were accepted and how many failed. Any other argument is refused by name.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'Plan id; list_gtm_plans returns them' },
        phase_id: { type: 'string', description: 'Send it for a phase report; leave it out for a whole-plan report' },
        notify_user: { type: 'boolean', description: 'Email the account owner' },
        notify_plan_poc: { type: 'boolean', description: 'Email the plan contact (the plan dri)' },
        notify_phase_poc: { type: 'boolean', description: 'Phase report only: email that phase\'s contact' },
        notify_phase_pocs: { type: 'boolean', description: 'Plan report only: email every phase contact' },
        message: { type: 'string', maxLength: GTM_EMAIL_MAX_MESSAGE_CHARS, description: `Optional note shown in the report, at most ${GTM_EMAIL_MAX_MESSAGE_CHARS} characters` },
      },
      required: ['plan_id'],
    },
  },
  execute: async (args: any, context: any) => jsonResult(await sendGtmStatusReport(args, context)),
});
