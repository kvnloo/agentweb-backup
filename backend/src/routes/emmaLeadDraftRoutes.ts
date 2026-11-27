/**
 * ENG-2840 (W2-10): `POST /api/emma/lead-email-draft`, the route behind the MCP tool `update_email_draft_for_lead`.
 *
 * Mounted on the /api/emma router (authenticated, metered). Any portal token can reach it directly, so it does not trust its caller: the
 * body is checked again with the same rules as the tool (`checkLeadDraftArgs`), and Emma's own tool runs through her registry with
 * `{ userId: req.user.userId }` as the only context (no session: the draft is stored without one).
 *
 * Access is checked here first, so that a list the caller cannot read answers exactly like a missing one (404), and a member who may read the
 * list but not edit it is told that editing needs an editor (403). Emma's tool answers "Lead list not found" and "Access denied" for those,
 * which tells a caller whether another account's list exists.
 *
 * Answers: `{ success: true, email, linkedin_note, skipped?, reason? }` built from fixed fields; `{ success: false, message }` (HTTP 200) with
 * a fixed text when the lead cannot get a draft (do-not-contact, no channel); 404 for an unknown lead; 403 for a sandbox workspace; 500 with a
 * fixed text otherwise. Emma's raw `error` is never passed on.
 */
import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { EvaluationDenied } from '../services/evaluationPolicy';

export const LEAD_DRAFT_INPUTS = ['list_id', 'lead_id', 'instruction', 'email_format'] as const;
export const MAX_LEAD_ID_CHARS = 200;
export const MAX_INSTRUCTION_CHARS = 2000;
/** The longest email body passed back (Emma's model call is capped at 3,000 output tokens, so a real draft is far shorter). */
export const MAX_DRAFT_CHARS = 50_000;

const FAILED_TEXT = 'The draft could not be written. Try again later.';
const LIST_NOT_FOUND = 'Lead list not found';

export type LeadDraftArgs = { list_id: string; lead_id: string; instruction: string; email_format?: 'text' | 'html' };
export type Checked = { ok: true; args: LeadDraftArgs } | { ok: false; error: string };

// Control characters other than tab and line breaks, and the invisible or direction-changing characters.
const BAD_INSTRUCTION_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const BAD_ID_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function idOf(field: string, value: unknown): string | { error: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: `${field} is required and must be text` };
  if (value.length > MAX_LEAD_ID_CHARS || value !== value.trim() || BAD_ID_CHARS.test(value)) {
    return { error: `${field} is not a valid id. Use an id returned by manage_leads, search_leads or list_lead_lists` };
  }
  return value;
}

/** The checks the tool and the route both apply. Pure. */
export function checkLeadDraftArgs(body: unknown): Checked {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'the arguments must be an object' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((key) => !(LEAD_DRAFT_INPUTS as readonly string[]).includes(key));
  if (unknown.length > 0) return { ok: false, error: `${unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ')} not accepted. Inputs: ${LEAD_DRAFT_INPUTS.join(', ')}` };
  const listId = idOf('list_id', b.list_id);
  if (typeof listId !== 'string') return { ok: false, error: listId.error };
  const leadId = idOf('lead_id', b.lead_id);
  if (typeof leadId !== 'string') return { ok: false, error: leadId.error };
  const instruction = b.instruction;
  if (typeof instruction !== 'string' || instruction.trim() === '') return { ok: false, error: 'instruction is required: say what the email should do (for example "follow up on their demo request")' };
  if (instruction.length > MAX_INSTRUCTION_CHARS) return { ok: false, error: `instruction must be at most ${MAX_INSTRUCTION_CHARS} characters` };
  if (BAD_INSTRUCTION_CHARS.test(instruction)) return { ok: false, error: 'instruction must not contain control or invisible characters' };
  const format = b.email_format;
  if (format !== undefined && format !== null && format !== 'text' && format !== 'html') return { ok: false, error: 'email_format must be "text" or "html"' };
  return {
    ok: true,
    args: { list_id: listId, lead_id: leadId, instruction, ...(format === 'text' || format === 'html' ? { email_format: format } : {}) },
  };
}

function cutText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > MAX_DRAFT_CHARS ? `${value.slice(0, MAX_DRAFT_CHARS)}… [cut at ${MAX_DRAFT_CHARS} characters]` : value;
}

/** The answer from fixed fields of Emma's result. Exported for tests. */
export function shapeDraft(result: Record<string, any>): Record<string, unknown> {
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const email = data.email && typeof data.email === 'object' ? data.email : null;
  const note = data.message && typeof data.message === 'object' ? cutText(data.message.content) : undefined;
  return {
    success: true,
    email: email
      ? {
        subject: cutText(email.subject) ?? '',
        format: typeof email.htmlContent === 'string' ? 'html' : 'text',
        ...(typeof email.htmlContent === 'string' ? { html: cutText(email.htmlContent) } : { text: cutText(email.textContent) ?? '' }),
      }
      : null,
    linkedin_note: note ?? null,
    ...(result.skipped === true ? { skipped: true, reason: result.reason === 'nothing_generated' ? 'nothing_generated' : 'skipped' } : {}),
  };
}

/** Fixed texts for Emma's refusals; anything else is a failure. */
function refusalOf(result: Record<string, any>): { status: number; message: string } {
  switch (result.message) {
    case 'Lead not found':
      return { status: 404, message: 'Lead not found in this list. Use a lead id from manage_leads or search_leads.' };
    case 'Do not contact':
      return { status: 200, message: 'This lead is marked do-not-contact, so no draft is written.' };
    case 'No contact channel':
      return { status: 200, message: 'This lead has no email address and no LinkedIn profile, so no draft is written.' };
    case LIST_NOT_FOUND:
    case 'Access denied':
      return { status: 404, message: LIST_NOT_FOUND };
    default:
      return { status: 500, message: FAILED_TEXT };
  }
}

async function runEmmaTool(args: LeadDraftArgs, caller: string): Promise<any> {
  await import('../emma/tools');
  const { emmaToolRegistry } = await import('../emma/registry');
  return emmaToolRegistry.execute('update_email_draft_for_lead', args, { userId: caller });
}

export function registerLeadDraftRoutes(router: Router): void {
  router.post('/lead-email-draft', async (req: Request, res: Response) => {
    const caller = (req as AuthenticatedRequest).user?.userId;
    if (typeof caller !== 'string' || caller === '') return res.status(401).json({ message: 'Authentication required' });
    const checked = checkLeadDraftArgs(req.body);
    if (!checked.ok) return res.status(400).json({ message: checked.error });
    const { args } = checked;
    try {
      const { crmDb } = await import('../services/db');
      const list = await crmDb.getLeadListById(args.list_id).catch(() => null);
      const { canAccessCrmList, canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../services/crmAccessControl');
      if (!list || !(await canAccessCrmList(caller, list))) return res.status(404).json({ message: LIST_NOT_FOUND });
      if (!(await canDestructiveCrmList(caller, list))) return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });

      const result = await runEmmaTool(args, caller);
      if (!result || typeof result !== 'object' || Array.isArray(result)) return res.status(500).json({ message: FAILED_TEXT });
      if (result.success === true) return res.json(shapeDraft(result));
      const refusal = refusalOf(result);
      if (refusal.status === 200) return res.json({ success: false, message: refusal.message });
      return res.status(refusal.status).json({ message: refusal.message });
    } catch (err: any) {
      if (err instanceof EvaluationDenied) return res.status(403).json({ message: 'This tool is not available in this sandbox workspace' });
      console.error('[emma lead-email-draft] failed:', String(err?.message ?? '').slice(0, 200));
      return res.status(500).json({ message: FAILED_TEXT });
    }
  });
}
