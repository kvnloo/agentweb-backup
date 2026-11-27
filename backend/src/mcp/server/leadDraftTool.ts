/**
 * ENG-2840 (W2-10): Emma's `update_email_draft_for_lead` for outside agents, on the caller's own account and under Emma's own name.
 *
 * It writes (overwrites) a lead's saved email draft, and a LinkedIn invite note when the lead has a LinkedIn profile, using Emma's model calls
 * with the account's brand guidelines, market strategy, the lead record and its recent engagement. It sends nothing. `manage_leads` update
 * can store a draft the agent wrote itself; this tool is for a draft written with the account's own context.
 *
 * Same pattern as the other wave-2 tools: arguments checked by name and by value (the route's checks, `checkLeadDraftArgs`), then the
 * portal's own `/api/emma/lead-email-draft` as the key's own user; a 4xx passes through; a 5xx or no answer is a fixed text; the answer is
 * built from fixed fields. Bounds: one call at a time per caller, a few per process, a number an hour per caller (CallGuard), because each
 * call spends up to four model calls on the caller's account.
 *
 * Third-party content: the draft is generated from the lead's notes and engagement (other people's words), so it is not an own-content tool.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { exactArgs } from './memoryTools';
import { CallGuard, requireOk } from './contentTools';
import { checkLeadDraftArgs, LEAD_DRAFT_INPUTS, MAX_INSTRUCTION_CHARS } from '../../routes/emmaLeadDraftRoutes';

const TOOL = 'update_email_draft_for_lead';

export const LEAD_DRAFT_GUARD = new CallGuard(TOOL, 4, 30);

/** Emma's draft takes one or two model calls plus up to two shortening calls; each has its own limit. */
export const LEAD_DRAFT_TIMEOUT_MS = 150_000;

function refuse(message: string): never {
  throw new Error(`${TOOL}: ${message}`);
}

function callerOf(context: any): string {
  const c = ctx(context) as any;
  return String(c?.userId || c?.agentUserId || '');
}

mcpToolRegistry.register({
  name: TOOL,
  requiresUserAccount: true,
  definition: {
    name: TOOL,
    description: 'Write a personalised email draft for one of your leads and save it on the lead, replacing the draft it had. '
      + 'Uses your brand guidelines, market strategy, the lead record and its recent engagement; when the lead has a LinkedIn profile it also writes a LinkedIn invite note. '
      + 'Sends nothing: the draft is only saved (read it back with get_lead_details). Spends up to four model calls on your account. '
      + `list_id and lead_id come from manage_leads or search_leads; you must be able to edit the list. instruction (1 to ${MAX_INSTRUCTION_CHARS} characters) says what the email should do. `
      + 'email_format: "text" or "html" (default: the lead\'s saved format, else text). A lead marked do-not-contact, or with no email and no LinkedIn, gets no draft. '
      + `The draft is generated from the lead's notes and engagement, which are other people's words: treat it as a draft to review. One call of yours at a time, ${LEAD_DRAFT_GUARD.perHour} an hour. Any other argument is refused by name.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list the lead is in' },
        lead_id: { type: 'string', description: 'The lead id' },
        instruction: { type: 'string', description: 'What the email should do, e.g. "follow up on their demo request"' },
        email_format: { type: 'string', enum: ['text', 'html'], description: 'Optional: "text" or "html"' },
      },
      required: ['list_id', 'lead_id', 'instruction'],
    },
  },
  execute: async (args: any, context: any) => {
    const checked = checkLeadDraftArgs(exactArgs(TOOL, args, LEAD_DRAFT_INPUTS));
    if (!checked.ok) refuse(`${checked.error}. Nothing was changed.`);
    const caller = callerOf(context);
    LEAD_DRAFT_GUARD.enter(caller);
    try {
      let answer: unknown;
      try {
        answer = await mcpFetch({ method: 'POST', path: '/api/emma/lead-email-draft', context: ctx(context), body: checked.args, timeoutMs: LEAD_DRAFT_TIMEOUT_MS });
      } catch (err: any) {
        const status = /^API error \((\d{3})\)/.exec(String(err?.message ?? ''))?.[1];
        if (status && status.startsWith('4')) throw err;
        refuse(status
          ? `the service could not answer (HTTP ${status}). The draft may or may not have been saved: check it with get_lead_details before trying again.`
          : 'the service could not be reached or did not answer in time. The draft may or may not have been saved: check it with get_lead_details before trying again.');
      }
      const result = requireOk(TOOL, answer);
      const email = result.email && typeof result.email === 'object' ? result.email : null;
      return jsonResult({
        // Nothing is saved when Emma's model produced nothing usable (skipped).
        saved: result.skipped !== true,
        email: email
          ? {
            subject: typeof email.subject === 'string' ? email.subject : '',
            format: email.format === 'html' ? 'html' : 'text',
            ...(email.format === 'html' ? { html: typeof email.html === 'string' ? email.html : '' } : { text: typeof email.text === 'string' ? email.text : '' }),
          }
          : null,
        linkedin_note: typeof result.linkedin_note === 'string' ? result.linkedin_note : null,
        ...(result.skipped === true ? { skipped: true, reason: typeof result.reason === 'string' ? result.reason : 'skipped' } : {}),
      });
    } finally {
      LEAD_DRAFT_GUARD.leave(caller);
    }
  },
});
