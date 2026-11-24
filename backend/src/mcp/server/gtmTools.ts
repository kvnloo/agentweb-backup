/**
 * ENG-2840 wave 2 (W2-4): `manage_gtm_plan` and `manage_gtm_items` for outside agents over MCP, repaired.
 *
 * What was wrong (found by reading the tools against the routes they call, plan v3 section 7.3): most actions either failed on every call
 * (`add_phase` sent `name` where the route wants `title`, `add_work_items` sent an array to a route that takes one item, `update_phase`
 * called a route that did not exist) or succeeded while dropping what the agent sent (`goals`, `target_audience`, `timeline`, `budget`,
 * a plan `status`, `name` and `due_date` on a work item, `include_summary` on a status report). A dropped argument is a silent false
 * success: the agent reports a plan it never wrote.
 *
 * What these tools do now:
 *  - each action has an exact list of inputs, and an argument that is not one of them is refused BY NAME, never ignored (the MCP path
 *    validates nothing against the input schema, so the handler checks);
 *  - the tool still calls the routes the customer portal uses, through `mcpFetch`, never Emma's in-process functions: only a route sees
 *    the delegation and the share-link restriction claim that `mcpFetch` signs into the self-call token;
 *  - `title` names a phase or a work item (`name` stays accepted as the old spelling; both given and different is refused);
 *  - values are checked before anything is sent: a work item status is one of pending, in_progress, completed, skipped; a date is
 *    exactly YYYY-MM-DD (the report emails split it on "-") or empty to clear; a contact (`dri`) is an email address or empty to clear;
 *  - `add_work_items` takes up to 20 items and sends them one after the other through the single-item route. A failure says which items
 *    were added and which were not tried; nothing is rolled back (the same as adding them one by one in the portal);
 *  - nothing here emails anyone. `send_status_report` is not an action (it answered "sent" while sending nothing; the routes now report
 *    what was sent, but they put the caller's text into the HTML of a system email unescaped, so an outside agent's key must not drive them
 *    yet), and `update_work_item` takes no `notify_*` flags (the old tool forwarded a guessed `notifications` object to the route). Both
 *    are refused by name with that reason. Enabling them is a decision: escape the report templates first (services/gtmPlanNotificationService.ts).
 *
 * A plan's status and a phase's status follow their work items (complete when everything under them is), so they cannot be set here.
 *
 * Nothing here adds a stored attribute, a table or an index.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { exactArgs } from './memoryTools';

export const GTM_WORK_ITEM_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const;
export const GTM_MAX_TITLE_CHARS = 300;
export const GTM_MAX_TEXT_CHARS = 5_000;
export const GTM_MAX_BATCH_ITEMS = 20;
export const GTM_MAX_COMMON_ITEMS = 50;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface GtmRequest { method: Method; path: string; body?: Record<string, unknown> }

const PLAN_BASE = '/api/gtm-plan';
const enc = encodeURIComponent;

// ─── argument checks ────────────────────────────────────────────────────────

function fail(tool: string, message: string): never {
  throw new Error(`${tool}: ${message} Nothing was changed.`);
}

/** An id as an agent may send it: text, no whitespace or control characters, at most 200 characters. */
function idArg(tool: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail(tool, `${field} is required and must be text.`);
  if ((value as string).length > 200 || /[\s\u0000-\u001f\u007f-\u009f]/.test(value as string)) {
    fail(tool, `${field} is not a valid id. Use an id returned by manage_gtm_plan get or list_gtm_plans.`);
  }
  try {
    encodeURIComponent(value as string);
  } catch {
    // a lone surrogate half cannot be written into a path
    fail(tool, `${field} is not a valid id. Use an id returned by manage_gtm_plan get or list_gtm_plans.`);
  }
  return value as string;
}

/** Text within a bound. Empty is allowed (it clears the field on an update) unless the field is required. */
function textArg(tool: string, field: string, value: unknown, max: number, opts: { required?: boolean } = {}): string {
  if (typeof value !== 'string') fail(tool, `${field} must be text.`);
  const text = value as string;
  if (text.length > max) fail(tool, `${field} is too long (${text.length} characters; the most is ${max}).`);
  if (opts.required && text.trim() === '') fail(tool, `${field} is required and cannot be empty.`);
  return text;
}

function emailArg(tool: string, field: string, value: unknown): string {
  const text = textArg(tool, field, value, 254);
  // one address: no whitespace, control or invisible characters, no markup, quotes, list or display-name separators, no empty label
  const plausible = /^[^\s@<>"(),;:\[\]\\]+@[^\s@<>"(),;:\[\]\\]+\.[^\s@<>"(),;:\[\]\\]+$/.test(text)
    && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/.test(text)
    && !/\.\.|@\.|\.$/.test(text);
  if (text !== '' && !plausible) {
    fail(tool, `${field} must be an email address, or an empty string to remove it.`);
  }
  return text;
}

/** YYYY-MM-DD that is a real calendar day, or `''` to clear. The report emails split the date on "-". */
function dateArg(tool: string, field: string, value: unknown): string {
  if (typeof value !== 'string') fail(tool, `${field} must be text written YYYY-MM-DD, or an empty string to remove it.`);
  const text = value as string;
  if (text === '') return text;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const real = match && (() => {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  })();
  if (!real) fail(tool, `${field} must be a date written YYYY-MM-DD (for example 2026-12-31), or an empty string to remove it.`);
  return text;
}

/** `title`, or its old spelling `name`; both given and different is refused. */
function titleArg(tool: string, a: Record<string, unknown>, required: boolean): string | undefined {
  const { title, name } = a;
  if (title !== undefined && name !== undefined && title !== name) fail(tool, 'send title, not both title and name (name is the old spelling of title).');
  const value = title !== undefined ? title : name;
  if (value === undefined) {
    if (required) fail(tool, 'title is required.');
    return undefined;
  }
  return textArg(tool, 'title', value, GTM_MAX_TITLE_CHARS, { required: true }).trim();
}

function actionOf(tool: string, args: unknown, allowed: readonly string[]): { action: string; a: Record<string, unknown> } {
  if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) fail(tool, 'the arguments must be an object.');
  const a = args as Record<string, unknown>;
  if (typeof a.action !== 'string' || !allowed.includes(a.action)) fail(tool, `action must be one of: ${allowed.join(', ')}.`);
  return { action: a.action as string, a };
}

/** Define only what was sent, so an omitted field is left alone by the route (an explicit `''` clears). */
function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

// ─── manage_gtm_plan ────────────────────────────────────────────────────────

const PLAN_ACTIONS = ['create', 'get', 'update', 'delete'] as const;
const PLAN_NOT_STORED = ['goals', 'target_audience', 'timeline', 'budget'] as const;

const PLAN_INPUTS: Record<(typeof PLAN_ACTIONS)[number], readonly string[]> = {
  create: ['action', 'title', 'description', 'dri'],
  get: ['action', 'plan_id'],
  update: ['action', 'plan_id', 'title', 'description', 'dri', 'due_date'],
  delete: ['action', 'plan_id'],
};

/** The one request a `manage_gtm_plan` call makes, or the refusal. Pure: nothing is sent here. */
export function planRequest(args: unknown): GtmRequest {
  const tool = 'manage_gtm_plan';
  const { action, a } = actionOf(tool, args, PLAN_ACTIONS);
  const stored = PLAN_NOT_STORED.filter((key) => key in a);
  if (stored.length > 0) {
    fail(tool, `${stored.map((k) => `"${k}"`).join(', ')} ${stored.length > 1 ? 'are' : 'is'} not stored on a plan. A plan has a title, a description, a contact (dri) and a due date: put goals, audience, timeline and budget in the description.`);
  }
  if ('status' in a) fail(tool, '"status" cannot be set: a plan is complete when every phase is, and a phase when every work item is done or skipped. Update the work items instead.');
  exactArgs(`${tool} ${action}`, a, PLAN_INPUTS[action as (typeof PLAN_ACTIONS)[number]]);

  switch (action) {
    case 'create': {
      const title = titleArg(tool, { title: a.title }, true) as string;
      return {
        method: 'POST', path: PLAN_BASE,
        body: defined({
          title,
          description: a.description === undefined ? undefined : textArg(tool, 'description', a.description, GTM_MAX_TEXT_CHARS),
          dri: a.dri === undefined ? undefined : emailArg(tool, 'dri', a.dri),
        }),
      };
    }
    case 'get':
      return { method: 'GET', path: `${PLAN_BASE}/${enc(idArg(tool, 'plan_id', a.plan_id))}` };
    case 'update': {
      const planId = idArg(tool, 'plan_id', a.plan_id);
      const body = defined({
        title: titleArg(tool, { title: a.title }, false),
        description: a.description === undefined ? undefined : textArg(tool, 'description', a.description, GTM_MAX_TEXT_CHARS),
        dri: a.dri === undefined ? undefined : emailArg(tool, 'dri', a.dri),
        dueDate: a.due_date === undefined ? undefined : dateArg(tool, 'due_date', a.due_date),
      });
      if (Object.keys(body).length === 0) fail(tool, 'update needs at least one of title, description, dri, due_date.');
      return { method: 'PUT', path: `${PLAN_BASE}/${enc(planId)}`, body };
    }
    default:
      return { method: 'DELETE', path: `${PLAN_BASE}/${enc(idArg(tool, 'plan_id', a.plan_id))}` };
  }
}

// ─── manage_gtm_items ───────────────────────────────────────────────────────

const ITEM_ACTIONS = [
  'add_phase', 'update_phase', 'delete_phase', 'add_work_items', 'update_work_item', 'delete_work_item',
  'get_common_items', 'add_common_items',
] as const;

/** What an outside agent may not make this tool do, and why. Named, so the refusal teaches instead of saying "not an input". */
const EMAIL_REFUSAL = 'emailing people is not available over MCP: the status report and the update notifications send email from AgentWeb to the addresses on the plan. Use the GTM plan page in the portal.';
const EMAIL_INPUTS = ['notify_user', 'notify_item_poc', 'notify_phase_poc', 'notify_plan_poc', 'notify_phase_pocs', 'notification_message', 'notifications', 'message'] as const;
type ItemAction = (typeof ITEM_ACTIONS)[number];

const WORK_ITEM_FIELDS = ['title', 'name', 'description', 'dri', 'due_date'] as const;
/** What a common item may carry: `id` and `sortOrder` are what get_common_items returns, accepted and not sent. */
const COMMON_ITEM_FIELDS = ['title', 'description', 'id', 'sortOrder'] as const;

const ITEM_INPUTS: Record<ItemAction, readonly string[]> = {
  add_phase: ['action', 'plan_id', 'title', 'name', 'description', 'dri', 'due_date'],
  update_phase: ['action', 'plan_id', 'phase_id', 'title', 'name', 'description', 'dri', 'due_date'],
  delete_phase: ['action', 'plan_id', 'phase_id'],
  add_work_items: ['action', 'plan_id', 'phase_id', 'work_items'],
  update_work_item: ['action', 'plan_id', 'phase_id', 'work_item_id', 'title', 'name', 'description', 'status', 'notes', 'dri', 'due_date'],
  delete_work_item: ['action', 'plan_id', 'phase_id', 'work_item_id'],
  // plan_id is accepted and ignored: the list is the same for every plan, and the previous schema listed plan_id as required
  get_common_items: ['action', 'plan_id'],
  add_common_items: ['action', 'plan_id', 'items', 'target_phase_id', 'new_phase_name'],
};

function workItemBody(tool: string, a: Record<string, unknown>): Record<string, unknown> {
  return defined({
    title: titleArg(tool, a, true),
    description: a.description === undefined ? undefined : textArg(tool, 'description', a.description, GTM_MAX_TEXT_CHARS),
    dri: a.dri === undefined ? undefined : emailArg(tool, 'dri', a.dri),
    dueDate: a.due_date === undefined ? undefined : dateArg(tool, 'due_date', a.due_date),
  });
}

/** The requests a `manage_gtm_items` call makes, in order (one, except `add_work_items`), or the refusal. Pure: nothing is sent here. */
export function itemRequests(args: unknown): GtmRequest[] {
  const tool = 'manage_gtm_items';
  if (args !== null && typeof args === 'object' && (args as Record<string, unknown>).action === 'send_status_report') fail(`${tool} send_status_report`, EMAIL_REFUSAL);
  const { action, a } = actionOf(tool, args, ITEM_ACTIONS);
  const label = `${tool} ${action}`;
  const emailing = EMAIL_INPUTS.filter((key) => key in a);
  if (emailing.length > 0) fail(label, `${emailing.map((k) => `"${k}"`).join(', ')}: ${EMAIL_REFUSAL}`);
  if ('status' in a && (action === 'add_phase' || action === 'update_phase')) {
    fail(label, '"status" cannot be set on a phase: it is complete when every work item under it is done or skipped. Update the work items instead.');
  }
  exactArgs(label, a, ITEM_INPUTS[action as ItemAction]);

  switch (action as ItemAction) {
    case 'add_phase': {
      const planId = idArg(tool, 'plan_id', a.plan_id);
      return [{ method: 'POST', path: `${PLAN_BASE}/${enc(planId)}/phases`, body: workItemBody(label, a) }];
    }
    case 'update_phase': {
      const planId = idArg(tool, 'plan_id', a.plan_id);
      const phaseId = idArg(tool, 'phase_id', a.phase_id);
      const body = defined({
        title: titleArg(label, a, false),
        description: a.description === undefined ? undefined : textArg(label, 'description', a.description, GTM_MAX_TEXT_CHARS),
        dri: a.dri === undefined ? undefined : emailArg(label, 'dri', a.dri),
        dueDate: a.due_date === undefined ? undefined : dateArg(label, 'due_date', a.due_date),
      });
      if (Object.keys(body).length === 0) fail(label, 'it needs at least one of title, description, dri, due_date.');
      return [{ method: 'PUT', path: `${PLAN_BASE}/${enc(planId)}/phases/${enc(phaseId)}`, body }];
    }
    case 'delete_phase':
      return [{ method: 'DELETE', path: `${PLAN_BASE}/${enc(idArg(tool, 'plan_id', a.plan_id))}/phases/${enc(idArg(tool, 'phase_id', a.phase_id))}` }];
    case 'add_work_items': {
      const planId = idArg(tool, 'plan_id', a.plan_id);
      const phaseId = idArg(tool, 'phase_id', a.phase_id);
      const list = a.work_items;
      if (!Array.isArray(list) || list.length === 0) fail(label, 'work_items must be a non-empty list of items, each with a title.');
      if ((list as unknown[]).length > GTM_MAX_BATCH_ITEMS) fail(label, `work_items has ${(list as unknown[]).length} items; the most in one call is ${GTM_MAX_BATCH_ITEMS}. Send them in several calls.`);
      return (list as unknown[]).map((item, index) => {
        const where = `${label} work_items[${index}]`;
        if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(where, 'each item must be an object with a title.');
        exactArgs(where, item, WORK_ITEM_FIELDS);
        return { method: 'POST' as const, path: `${PLAN_BASE}/${enc(planId)}/phases/${enc(phaseId)}/work-items`, body: workItemBody(where, item as Record<string, unknown>) };
      });
    }
    case 'update_work_item': {
      const planId = idArg(tool, 'plan_id', a.plan_id);
      const phaseId = idArg(tool, 'phase_id', a.phase_id);
      const itemId = idArg(tool, 'work_item_id', a.work_item_id);
      let status: string | undefined;
      if (a.status !== undefined) {
        if (typeof a.status !== 'string' || !(GTM_WORK_ITEM_STATUSES as readonly string[]).includes(a.status)) {
          fail(label, `status must be one of: ${GTM_WORK_ITEM_STATUSES.join(', ')}.`);
        }
        status = a.status as string;
      }
      const body = defined({
        title: titleArg(label, a, false),
        description: a.description === undefined ? undefined : textArg(label, 'description', a.description, GTM_MAX_TEXT_CHARS),
        status,
        notes: a.notes === undefined ? undefined : textArg(label, 'notes', a.notes, GTM_MAX_TEXT_CHARS),
        dri: a.dri === undefined ? undefined : emailArg(label, 'dri', a.dri),
        dueDate: a.due_date === undefined ? undefined : dateArg(label, 'due_date', a.due_date),
      });
      if (Object.keys(body).length === 0) fail(label, 'it needs at least one of title, description, status, notes, dri, due_date.');
      return [{ method: 'PUT', path: `${PLAN_BASE}/${enc(planId)}/phases/${enc(phaseId)}/work-items/${enc(itemId)}`, body }];
    }
    case 'delete_work_item':
      return [{ method: 'DELETE', path: `${PLAN_BASE}/${enc(idArg(tool, 'plan_id', a.plan_id))}/phases/${enc(idArg(tool, 'phase_id', a.phase_id))}/work-items/${enc(idArg(tool, 'work_item_id', a.work_item_id))}` }];
    case 'get_common_items':
      return [{ method: 'GET', path: `${PLAN_BASE}/common-items` }];
    case 'add_common_items': {
      const planId = idArg(tool, 'plan_id', a.plan_id);
      if (!Array.isArray(a.items) || a.items.length === 0) fail(label, 'items must be a non-empty list, each item with a title (see get_common_items).');
      if (a.items.length > GTM_MAX_COMMON_ITEMS) fail(label, `items has ${a.items.length} entries; the most in one call is ${GTM_MAX_COMMON_ITEMS}.`);
      // what get_common_items returns (id, sortOrder) is accepted and left out; only a title and a description are added to the plan
      const commonItems = a.items.map((item: unknown, index: number) => {
        const where = `${label} items[${index}]`;
        if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(where, 'each item must be an object with a title.');
        exactArgs(where, item, COMMON_ITEM_FIELDS);
        const entry = item as Record<string, unknown>;
        return defined({
          title: titleArg(where, { title: entry.title }, true),
          description: entry.description === undefined || entry.description === null ? undefined : textArg(where, 'description', entry.description, GTM_MAX_TEXT_CHARS),
        });
      });
      const targetPhaseId = a.target_phase_id === undefined ? undefined : idArg(label, 'target_phase_id', a.target_phase_id);
      const newPhaseName = a.new_phase_name === undefined ? undefined : textArg(label, 'new_phase_name', a.new_phase_name, GTM_MAX_TITLE_CHARS, { required: true });
      if ((targetPhaseId === undefined) === (newPhaseName === undefined)) fail(label, 'send exactly one of target_phase_id (an existing phase) or new_phase_name (a phase to create).');
      return [{ method: 'POST', path: `${PLAN_BASE}/${enc(planId)}/add-common-items`, body: defined({ items: commonItems, targetPhaseId, newPhaseName }) }];
    }
    default:
      throw new Error(`${label}: unhandled action.`);
  }
}

// ─── execution ──────────────────────────────────────────────────────────────

/** The work item a batch call just added: the route pushes it to the end of its phase and answers with the whole plan. */
function addedItem(plan: any, phaseId: string): { id: string; title: string } | undefined {
  const phase = plan?.data?.phases?.find((p: any) => p?.id === phaseId);
  const last = phase?.workItems?.[phase.workItems.length - 1];
  return last ? { id: last.id, title: last.title } : undefined;
}

async function runBatch(requests: GtmRequest[], phaseId: string, context: any): Promise<unknown> {
  const added: Array<{ id: string; title: string } | { title: string }> = [];
  let last: any;
  for (let index = 0; index < requests.length; index++) {
    try {
      last = await mcpFetch({ method: requests[index].method, path: requests[index].path, context: ctx(context), body: requests[index].body });
    } catch (err: any) {
      const done = added.length === 0 ? 'No item was added before it.' : `Added before it: ${added.map((x) => `"${x.title}"`).join(', ')}.`;
      throw new Error(`manage_gtm_items add_work_items: item ${index + 1} of ${requests.length} failed (${err?.message || 'error'}). ${done} The items after it were not tried; nothing was rolled back. If the failure was a timeout the failed item may still have been written: read the plan before retrying.`);
    }
    added.push(addedItem(last, phaseId) ?? { title: String(requests[index].body?.title) });
  }
  return { success: true, message: `${added.length} work item${added.length === 1 ? '' : 's'} added`, added, plan: last?.data };
}

mcpToolRegistry.register({
  name: 'manage_gtm_plan',
  definition: {
    name: 'manage_gtm_plan',
    description: 'Create, read, update or delete a go-to-market (GTM) plan. action "create": title (required), description, dri (the plan contact\'s email). '
      + 'action "get" and "delete": plan_id. action "update": plan_id and at least one of title, description, dri, due_date (YYYY-MM-DD; an empty string removes dri or due_date). '
      + 'A plan has no goals, audience, timeline, budget or status fields to set: write goals and the like into the description; the status follows the phases. '
      + 'An argument that is not an input of the action is refused by name. Phases and work items are managed with manage_gtm_items.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...PLAN_ACTIONS], description: 'What to do' },
        plan_id: { type: 'string', description: 'Plan id (get, update, delete); list_gtm_plans returns them' },
        title: { type: 'string', description: `Plan title (create, update), at most ${GTM_MAX_TITLE_CHARS} characters` },
        description: { type: 'string', description: `Plan description (create, update), at most ${GTM_MAX_TEXT_CHARS} characters; an empty string clears it` },
        dri: { type: 'string', description: 'Email address of the plan contact (create, update). On update an empty string removes it; on create it defaults to your own email address' },
        due_date: { type: 'string', description: 'Plan due date YYYY-MM-DD (update); an empty string removes it' },
      },
      required: ['action'],
    },
  },
  execute: async (args: any, context: any) => {
    const request = planRequest(args);
    return jsonResult(await mcpFetch({ method: request.method, path: request.path, context: ctx(context), body: request.body }));
  },
});

mcpToolRegistry.register({
  name: 'manage_gtm_items',
  definition: {
    name: 'manage_gtm_items',
    description: 'Manage the phases and work items of a GTM plan. Each action takes only its own inputs; any other argument is refused by name. '
      + 'add_phase: plan_id, title (required), description, dri, due_date. update_phase: plan_id, phase_id and at least one of title, description, dri, due_date. delete_phase: plan_id, phase_id. '
      + `add_work_items: plan_id, phase_id, work_items (1 to ${GTM_MAX_BATCH_ITEMS} objects, each with title and optionally description, dri, due_date); they are added one after the other. `
      + 'update_work_item: plan_id, phase_id, work_item_id and at least one of title, description, status (pending, in_progress, completed, skipped), notes, dri, due_date. '
      + 'delete_work_item: plan_id, phase_id, work_item_id. get_common_items: nothing (a plan_id is accepted and ignored). add_common_items: plan_id, items (up to 50, from get_common_items: each a title and optionally a description), and exactly one of target_phase_id or new_phase_name. '
      + 'Nothing here emails anyone: status reports and update notifications are sent from the portal. '
      + 'Dates are YYYY-MM-DD; dri is an email address; an empty string clears description, notes, dri or due_date. A phase\'s and a plan\'s status follow their work items and cannot be set.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ITEM_ACTIONS], description: 'Action to perform' },
        plan_id: { type: 'string', description: 'Plan id' },
        phase_id: { type: 'string', description: 'Phase id' },
        work_item_id: { type: 'string', description: 'Work item id' },
        title: { type: 'string', description: `Phase or work item title, at most ${GTM_MAX_TITLE_CHARS} characters (name is accepted as the old spelling)` },
        name: { type: 'string', description: 'Old spelling of title' },
        description: { type: 'string', description: `Description, at most ${GTM_MAX_TEXT_CHARS} characters; an empty string clears it` },
        status: { type: 'string', enum: [...GTM_WORK_ITEM_STATUSES], description: 'Work item status (update_work_item only)' },
        notes: { type: 'string', description: 'Work item notes (update_work_item); an empty string clears them' },
        dri: { type: 'string', description: 'Email address of the contact; an empty string removes it' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD; an empty string removes it' },
        work_items: { type: 'array', maxItems: GTM_MAX_BATCH_ITEMS, items: { type: 'object' }, description: 'Items to add (add_work_items): title, description, dri, due_date' },
        items: { type: 'array', maxItems: GTM_MAX_COMMON_ITEMS, items: { type: 'object' }, description: 'Common items to add (add_common_items), from get_common_items: a title and optionally a description each' },
        target_phase_id: { type: 'string', description: 'Existing phase for the common items (add_common_items)' },
        new_phase_name: { type: 'string', description: 'Name of a new phase for the common items (add_common_items)' },
      },
      required: ['action'],
    },
  },
  execute: async (args: any, context: any) => {
    const requests = itemRequests(args);
    if (args.action === 'add_work_items') {
      return jsonResult(await runBatch(requests, args.phase_id, context));
    }
    const [request] = requests;
    return jsonResult(await mcpFetch({ method: request.method, path: request.path, context: ctx(context), body: request.body }));
  },
});
