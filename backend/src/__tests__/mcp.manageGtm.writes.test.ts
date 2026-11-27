/**
 * ENG-2840 wave 2 (W2-4): manage_gtm_plan and manage_gtm_items, proved through the REAL path (MCP client -> MCP server -> tool -> mcpFetch ->
 * the real Express app and gtmPlan routes -> in-memory DynamoDB), the same path as mcp.manageStrategy.writes.test.ts.
 *
 * Before this change most actions failed on every call (add_phase sent `name`, add_work_items sent an array, update_phase called a route that
 * did not exist) or succeeded while dropping what the agent sent. A unit test with a mocked route cannot see that: the defect was the gap
 * between the tool and the route. These tests send each action through both and read the stored plan back.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__gtmWritesFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import app from '../app';
import { resendService } from '../services/resendService';
import {
  connectCaller,
  installSelfCallFetch,
  seedTwoTenantWorld,
  TENANT_A,
  TENANT_B,
  type McpCaller,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__gtmWritesFake;
const plans = () => fake.items('AW-GTMPlan');
const planRow = (planId: string) => plans().find((p: any) => p.planId === planId);
const phaseOf = (planId: string, phaseId: string) => planRow(planId).phases.find((p: any) => p.id === phaseId);
const snapshot = (planId: string) => JSON.stringify(planRow(planId));
const SEEDED_AT = '2026-10-01T09:00:00.000Z';
const OWNER_EMAIL = `${TENANT_A.owner}@${TENANT_A.orgId}.test`;

const seedPlan = (t: typeof TENANT_A, planId: string, marker: string) => fake.seed('AW-GTMPlan', {
  planId,
  userId: t.owner,
  title: `${marker} launch`,
  description: `${marker} plan`,
  dri: `plan-poc@${marker.toLowerCase()}.test`,
  status: 'in_progress',
  phases: [
    {
      id: `${planId}-ph1`, title: `${marker} Research`, description: null, dri: `phase-poc@${marker.toLowerCase()}.test`, dueDate: null, status: 'in_progress',
      workItems: [{ id: `${planId}-it1`, title: `${marker} Interview`, description: null, dri: null, status: 'pending', notes: null, dueDate: null }],
    },
    { id: `${planId}-ph2`, title: `${marker} Build`, description: null, dri: null, dueDate: null, status: 'in_progress', workItems: [] },
  ],
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
});

let restoreFetch: () => void;
let owner: McpCaller;
let other: McpCaller;
let sendMail: jest.SpyInstance;

beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  owner = await connectCaller(TENANT_A.owner);
  other = await connectCaller(TENANT_B.owner);
});
afterAll(async () => {
  await Promise.all([owner.close(), other.close()]);
  restoreFetch();
});

beforeEach(() => {
  seedTwoTenantWorld(fake);
  fake.tables.get('AW-GTMPlan')?.clear();
  fake.tables.get('AW-Settings')?.clear();
  seedPlan(TENANT_A, 'plan-a1', 'ALPHA');
  seedPlan(TENANT_B, 'plan-b1', 'BRAVO');
  sendMail = jest.spyOn(resendService, 'sendSystemEmail').mockResolvedValue({ id: 'email-1' } as any);
});
afterEach(() => sendMail.mockRestore());

const plan = (caller: McpCaller, args: Record<string, unknown>) => caller.call('manage_gtm_plan', args);
const items = (caller: McpCaller, args: Record<string, unknown>) => caller.call('manage_gtm_items', { plan_id: 'plan-a1', ...args });

describe('manage_gtm_plan', () => {
  it('create stores title, description and contact on a new plan owned by the caller, and get reads it back', async () => {
    const r = await plan(owner, { action: 'create', title: 'Q1 launch', description: 'Win mid-market', dri: 'lead@alpha.test' });
    expect(r.isError).toBe(false);
    const stored = plans().find((p: any) => p.title === 'Q1 launch');
    expect(stored).toMatchObject({ userId: TENANT_A.owner, description: 'Win mid-market', dri: 'lead@alpha.test', status: 'in_progress', phases: [] });
    expect(r.json.data.planId).toBe(stored.planId);
    const got = await plan(owner, { action: 'get', plan_id: stored.planId });
    expect(got.isError).toBe(false);
    expect(got.json.data.title).toBe('Q1 launch');
  });

  it('create refuses the fields a plan does not store, by name, and writes nothing', async () => {
    const before = plans().length;
    const r = await plan(owner, { action: 'create', title: 'T', goals: ['grow'], budget: '10k' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"goals", "budget" are not stored on a plan');
    expect(plans()).toHaveLength(before);
  });

  it('update changes only what was sent (title and due date); an empty string clears the contact', async () => {
    const r = await plan(owner, { action: 'update', plan_id: 'plan-a1', title: 'ALPHA relaunch', due_date: '2026-12-31', dri: '' });
    expect(r.isError).toBe(false);
    expect(planRow('plan-a1')).toMatchObject({ title: 'ALPHA relaunch', dueDate: '2026-12-31', dri: null, description: 'ALPHA plan' });
    expect(planRow('plan-a1').updatedAt).not.toBe(SEEDED_AT);
    expect(planRow('plan-a1').phases).toHaveLength(2);
  });

  it('update with a status, or with nothing, is refused and the plan is untouched (it used to answer success after changing only updatedAt)', async () => {
    const before = snapshot('plan-a1');
    expect((await plan(owner, { action: 'update', plan_id: 'plan-a1', status: 'completed' })).text).toContain('"status" cannot be set');
    expect((await plan(owner, { action: 'update', plan_id: 'plan-a1' })).text).toContain('needs at least one of');
    expect((await plan(owner, { action: 'update', plan_id: 'plan-a1', timeline: 'Q1' })).text).toContain('"timeline" is not stored');
    expect(snapshot('plan-a1')).toBe(before);
  });

  it('delete removes the caller\'s plan', async () => {
    expect((await plan(owner, { action: 'delete', plan_id: 'plan-a1' })).isError).toBe(false);
    expect(planRow('plan-a1')).toBeUndefined();
    expect(planRow('plan-b1')).toBeDefined();
  });

  it('another tenant can neither read, change nor delete the plan, and learns nothing about it', async () => {
    const before = snapshot('plan-a1');
    for (const args of [
      { action: 'get', plan_id: 'plan-a1' },
      { action: 'update', plan_id: 'plan-a1', title: 'HIJACKED' },
      { action: 'delete', plan_id: 'plan-a1' },
    ]) {
      const r = await plan(other, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Access denied');
      expect(r.text).not.toContain('ALPHA');
    }
    expect(snapshot('plan-a1')).toBe(before);
  });
});

describe('manage_gtm_items: phases', () => {
  it('add_phase stores a phase with the title, contact and due date (it sent `name` and failed on every call)', async () => {
    const r = await items(owner, { action: 'add_phase', title: 'Launch', description: 'Go live', dri: 'ops@alpha.test', due_date: '2026-12-01' });
    expect(r.isError).toBe(false);
    const phase = planRow('plan-a1').phases.find((p: any) => p.title === 'Launch');
    expect(phase).toMatchObject({ description: 'Go live', dri: 'ops@alpha.test', dueDate: '2026-12-01', status: 'in_progress', workItems: [] });
    expect(planRow('plan-a1').phases).toHaveLength(3);
  });

  it('add_phase still accepts the old spelling `name` for the title', async () => {
    expect((await items(owner, { action: 'add_phase', name: 'Legacy name' })).isError).toBe(false);
    expect(planRow('plan-a1').phases.map((p: any) => p.title)).toContain('Legacy name');
  });

  it('update_phase renames one phase and leaves its work items, status and the other phase alone (the route did not exist)', async () => {
    const otherPhase = JSON.stringify(phaseOf('plan-a1', 'plan-a1-ph2'));
    const r = await items(owner, { action: 'update_phase', phase_id: 'plan-a1-ph1', title: 'Discovery', dri: '' });
    expect(r.isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1')).toMatchObject({ title: 'Discovery', dri: null, status: 'in_progress' });
    expect(phaseOf('plan-a1', 'plan-a1-ph1').workItems).toHaveLength(1);
    expect(JSON.stringify(phaseOf('plan-a1', 'plan-a1-ph2'))).toBe(otherPhase);
  });

  it('renaming a phase whose work items are all done leaves it completed (its status is derived, update_phase does not touch it)', async () => {
    expect((await items(owner, { action: 'update_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1', status: 'skipped' })).isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1').status).toBe('completed');
    expect((await items(owner, { action: 'update_phase', phase_id: 'plan-a1-ph1', title: 'Renamed after completion' })).isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1')).toMatchObject({ title: 'Renamed after completion', status: 'completed' });
  });

  it('update_phase for a phase that is not in the plan is refused and nothing changes', async () => {
    const before = snapshot('plan-a1');
    const r = await items(owner, { action: 'update_phase', phase_id: 'nope', title: 'X' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Phase not found');
    expect(snapshot('plan-a1')).toBe(before);
  });

  it('delete_phase removes it', async () => {
    expect((await items(owner, { action: 'delete_phase', phase_id: 'plan-a1-ph2' })).isError).toBe(false);
    expect(planRow('plan-a1').phases.map((p: any) => p.id)).toEqual(['plan-a1-ph1']);
  });

  it('another tenant cannot add, change or delete a phase of this plan', async () => {
    const before = snapshot('plan-a1');
    for (const args of [
      { action: 'add_phase', title: 'EVIL' },
      { action: 'update_phase', phase_id: 'plan-a1-ph1', title: 'EVIL' },
      { action: 'delete_phase', phase_id: 'plan-a1-ph1' },
    ]) {
      const r = await items(other, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Access denied');
    }
    expect(snapshot('plan-a1')).toBe(before);
  });
});

describe('manage_gtm_items: work items', () => {
  const batch = (work_items: unknown[], phase_id = 'plan-a1-ph2') => items(owner, { action: 'add_work_items', phase_id, work_items });

  it('add_work_items stores every item in order, with its fields, and returns the new ids (it sent an array to a one-item route)', async () => {
    const r = await batch([{ title: 'Write brief', due_date: '2026-11-30' }, { name: 'Design page', description: 'Hero', dri: 'des@alpha.test' }, { title: 'Ship' }]);
    expect(r.isError).toBe(false);
    const stored = phaseOf('plan-a1', 'plan-a1-ph2').workItems;
    expect(stored.map((i: any) => i.title)).toEqual(['Write brief', 'Design page', 'Ship']);
    expect(stored[0]).toMatchObject({ dueDate: '2026-11-30', status: 'pending', description: null });
    expect(stored[1]).toMatchObject({ description: 'Hero', dri: 'des@alpha.test' });
    expect(r.json.added).toEqual(stored.map((i: any) => ({ id: i.id, title: i.title })));
    expect(r.json.message).toBe('3 work items added');
  });

  it('a bad item refuses the whole call before anything is written', async () => {
    const before = snapshot('plan-a1');
    const r = await batch([{ title: 'Good' }, { description: 'no title' }]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('work_items[1]: title is required');
    expect(snapshot('plan-a1')).toBe(before);
  });

  it('a phase that does not exist fails on the first item and says nothing was added', async () => {
    const before = snapshot('plan-a1');
    const r = await batch([{ title: 'A' }, { title: 'B' }], 'no-such-phase');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('item 1 of 2 failed');
    expect(r.text).toContain('No item was added before it');
    expect(snapshot('plan-a1')).toBe(before);
  });

  it('update_work_item writes the route\'s fields (title, status, notes, contact, due date) and `name` is not a way to rename', async () => {
    const r = await items(owner, {
      action: 'update_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1',
      title: 'Customer interviews', notes: 'five booked', dri: 'pm@alpha.test', due_date: '2026-11-20', status: 'in_progress', description: 'with buyers',
    });
    expect(r.isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1').workItems[0]).toMatchObject({
      title: 'Customer interviews', notes: 'five booked', dri: 'pm@alpha.test', dueDate: '2026-11-20', status: 'in_progress', description: 'with buyers',
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('null clears a work item\'s notes and contact, as it did before the tool validated its input', async () => {
    const base = { action: 'update_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1' };
    expect((await items(owner, { ...base, notes: 'five booked', dri: 'pm@alpha.test' })).isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1').workItems[0]).toMatchObject({ notes: 'five booked', dri: 'pm@alpha.test' });
    const cleared = await items(owner, { ...base, notes: null, dri: null });
    expect(cleared.isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1').workItems[0]).toMatchObject({ notes: null, dri: null });
  });

  it('completing the only item completes its phase (derived status), and marking it done sets completedAt', async () => {
    const r = await items(owner, { action: 'update_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1', status: 'completed' });
    expect(r.isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1').workItems[0].completedAt).toEqual(expect.any(String));
    expect(phaseOf('plan-a1', 'plan-a1-ph1').status).toBe('completed');
    expect(planRow('plan-a1').status).toBe('in_progress');
  });

  it('update_work_item refuses an unknown status and an empty update, and the plan is untouched', async () => {
    const before = snapshot('plan-a1');
    const base = { action: 'update_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1' };
    expect((await items(owner, { ...base, status: 'done' })).text).toContain('status must be one of');
    expect((await items(owner, base)).text).toContain('needs at least one of');
    expect((await items(owner, { ...base, due_date: 'next week' })).text).toContain('due_date must be a date');
    expect(snapshot('plan-a1')).toBe(before);
  });

  it('emailing is refused whichever way it is asked for, and nothing is written or sent', async () => {
    const before = snapshot('plan-a1');
    const base = { action: 'update_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1', status: 'completed' };
    for (const extra of [
      { notify_user: true },
      { notify_plan_poc: true, notification_message: '<a href="https://example.test">hello</a>' },
      { notifications: { notifyUser: true, message: '<b>x</b>' } },
    ]) {
      const r = await items(owner, { ...base, ...extra });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('emailing people is not available over MCP');
    }
    expect(snapshot('plan-a1')).toBe(before);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('delete_work_item removes it', async () => {
    expect((await items(owner, { action: 'delete_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1' })).isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph1').workItems).toEqual([]);
  });

  it('another tenant cannot add, change or delete a work item', async () => {
    const before = snapshot('plan-a1');
    for (const args of [
      { action: 'add_work_items', phase_id: 'plan-a1-ph1', work_items: [{ title: 'EVIL' }] },
      { action: 'update_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1', status: 'completed' },
      { action: 'delete_work_item', phase_id: 'plan-a1-ph1', work_item_id: 'plan-a1-it1' },
    ]) {
      const r = await items(other, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Access denied');
    }
    expect(snapshot('plan-a1')).toBe(before);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('manage_gtm_items: common items', () => {
  const CATEGORIES = [{ id: 'cat-1', name: 'Content', sortOrder: 1, items: [{ id: 'ci-1', title: 'Blog strategy', sortOrder: 1 }] }];

  it('get_common_items returns the stored categories', async () => {
    fake.seed('AW-Settings', { settingName: 'gtm_common_items', settingValue: JSON.stringify(CATEGORIES) });
    const r = await owner.call('manage_gtm_items', { action: 'get_common_items' });
    expect(r.isError).toBe(false);
    expect(r.json.data).toEqual(CATEGORIES);
  });

  it('add_common_items refuses an item that carries anything but a title and a description, and writes nothing', async () => {
    const before = snapshot('plan-a1');
    const r = await items(owner, { action: 'add_common_items', items: [{ title: 'Blog', dri: 'x@y.zz', status: 'completed' }], target_phase_id: 'plan-a1-ph2' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('items[0]: "dri", "status" are not inputs');
    expect(snapshot('plan-a1')).toBe(before);
  });

  it('add_common_items accepts what get_common_items returns (id, sortOrder) and stores a title and a description only', async () => {
    const r = await items(owner, { action: 'add_common_items', items: [{ id: 'ci-1', sortOrder: 2, title: 'Blog strategy', description: 'Plan posts' }], target_phase_id: 'plan-a1-ph2' });
    expect(r.isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph2').workItems).toEqual([expect.objectContaining({ title: 'Blog strategy', description: 'Plan posts', status: 'pending' })]);
    expect(JSON.stringify(phaseOf('plan-a1', 'plan-a1-ph2').workItems)).not.toContain('ci-1');
  });

  it('add_common_items adds to an existing phase, or creates the phase named', async () => {
    const toPhase = await items(owner, { action: 'add_common_items', items: [{ title: 'Blog strategy' }], target_phase_id: 'plan-a1-ph2' });
    expect(toPhase.isError).toBe(false);
    expect(phaseOf('plan-a1', 'plan-a1-ph2').workItems.map((i: any) => i.title)).toEqual(['Blog strategy']);
    const newPhase = await items(owner, { action: 'add_common_items', items: [{ title: 'Podcast' }], new_phase_name: 'Content' });
    expect(newPhase.isError).toBe(false);
    const created = planRow('plan-a1').phases.find((p: any) => p.title === 'Content');
    expect(created.workItems.map((i: any) => i.title)).toEqual(['Podcast']);
  });
});

describe('manage_gtm_items: send_status_report is not available', () => {
  // Until the report templates escape what a caller wrote (they put the message, titles and notes into the HTML of a system email as
  // they are), an outside agent's key must not be able to send one. Every route into it is refused with the reason.
  const report = (args: Record<string, unknown>, caller = owner) => items(caller, { action: 'send_status_report', ...args });

  it('refuses the action, with the reason, and sends nothing', async () => {
    for (const args of [{}, { notify_user: true, notify_plan_poc: true, message: 'Weekly update' }, { phase_id: 'plan-a1-ph1', notify_phase_poc: true }, { include_summary: true }]) {
      const r = await report(args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('emailing people is not available over MCP');
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('is not offered: the tool\'s actions do not include it', async () => {
    const { mcpToolRegistry } = await import('../mcp/server/registry');
    const schema = (mcpToolRegistry.getTool('manage_gtm_items') as any).definition.inputSchema;
    expect(schema.properties.action.enum).not.toContain('send_status_report');
  });
});
