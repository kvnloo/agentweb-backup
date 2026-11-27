/**
 * ENG-2840 (W2-7): `add_lead_engagement` and `manage_leads update` + `status_note`, proved through the REAL path (MCP client -> MCP server ->
 * tool -> mcpFetch -> the real Express app and routes -> Emma's real handler / the CRM route -> db.ts -> in-memory DynamoDB), with two tenants.
 * Same harness as mcp.leadReads.twoTenant.test.ts / mcp.manageLeads.writes.test.ts.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__leadEngagementFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import app from '../app';
import { engagementBudget } from '../mcp/server/leadEngagementTool';
import {
  connectCaller,
  contentMarkers,
  installSelfCallFetch,
  seedTwoTenantWorld,
  snapshotTenant,
  TENANT_A,
  TENANT_B,
  type McpCaller,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__leadEngagementFake;
const leadRow = (listId: string, leadId: string) => fake.items('AW-Leads').find((r: any) => r.listId === listId && r.leadId === leadId);
const [a1] = TENANT_A.leads;
const [b1] = TENANT_B.leads;
const KEY = 'retry-key-2026-11-26';
const OWN_NOTES = 'ALPHA lead own notes';

let restoreFetch: () => void;
let a: McpCaller;
let b: McpCaller;

beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  a = await connectCaller(TENANT_A.owner);
  b = await connectCaller(TENANT_B.owner);
});
afterAll(async () => {
  await a.close();
  await b.close();
  restoreFetch();
});
beforeEach(() => {
  seedTwoTenantWorld(fake);
  // A's first lead carries its own notes, so a status note landing there would be visible.
  fake.seed('AW-Leads', { ...leadRow(TENANT_A.listId, a1.leadId), notes: OWN_NOTES });
  engagementBudget.reset();
});

const engagementsOf = (listId: string, leadId: string): any[] => leadRow(listId, leadId)?.engagements ?? [];
const noVictimContent = (text: string, victim = TENANT_A) => {
  const leaked = [...contentMarkers(victim), OWN_NOTES].filter((m) => text.includes(m));
  expect(leaked).toEqual([]);
};

describe('add_lead_engagement', () => {
  it('(1) tenant B on tenant A\'s list and lead is refused, and A\'s data is unchanged', async () => {
    const before = snapshotTenant(fake, TENANT_A);
    const o = await b.call('add_lead_engagement', {
      list_id: TENANT_A.listId, lead_id: a1.leadId, event_type: 'custom.phone_call', event_data: { outcome: 'hijack' }, idempotency_key: KEY,
    });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(/^Error: add_lead_engagement: /);
    noVictimContent(o.text);
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    expect(engagementsOf(TENANT_A.listId, a1.leadId)).toEqual([]);
  });

  it('(1b) tenant B naming its own list with A\'s lead id finds nothing and writes nothing', async () => {
    const beforeA = snapshotTenant(fake, TENANT_A);
    const o = await b.call('add_lead_engagement', { list_id: TENANT_B.listId, lead_id: a1.leadId, event_type: 'custom.phone_call' });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(/Lead not found/);
    noVictimContent(o.text);
    expect(snapshotTenant(fake, TENANT_A)).toBe(beforeA);
    expect(leadRow(TENANT_B.listId, a1.leadId)).toBeUndefined();
  });

  it('(2) tenant A records an event: stored with eventData.channel === "mcp" and the caller\'s data', async () => {
    const o = await a.call('add_lead_engagement', {
      list_id: TENANT_A.listId, lead_id: a1.leadId, event_type: 'custom.phone_call', event_data: { outcome: 'booked', minutes: 12 },
    });
    expect(o.isError).toBe(false);
    expect(o.json).toMatchObject({ success: true, recorded: true, event_type: 'custom.phone_call' });
    const events = engagementsOf(TENANT_A.listId, a1.leadId);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('custom.phone_call');
    expect(events[0].eventData).toEqual({ outcome: 'booked', minutes: 12, channel: 'mcp' });
    // B's leads are untouched.
    expect(engagementsOf(TENANT_B.listId, b1.leadId)).toEqual([]);
  });

  it('(3) the same idempotency_key twice records once; the second answer is recorded: false, duplicate: true', async () => {
    const args = { list_id: TENANT_A.listId, lead_id: a1.leadId, event_type: 'custom.meeting', event_data: { topic: 'demo' }, idempotency_key: KEY };
    const first = await a.call('add_lead_engagement', args);
    expect(first.isError).toBe(false);
    expect(first.json).toMatchObject({ success: true, recorded: true });
    const second = await a.call('add_lead_engagement', args);
    expect(second.isError).toBe(false);
    expect(second.json).toMatchObject({ success: true, recorded: false, duplicate: true });
    const events = engagementsOf(TENANT_A.listId, a1.leadId);
    expect(events).toHaveLength(1);
    expect(events[0].eventData).toMatchObject({ channel: 'mcp', idempotencyKey: KEY, topic: 'demo' });
  });

  it('(3b) the same key on ANOTHER lead is not a duplicate', async () => {
    const args = { list_id: TENANT_A.listId, event_type: 'custom.meeting', idempotency_key: KEY };
    expect((await a.call('add_lead_engagement', { ...args, lead_id: a1.leadId })).json).toMatchObject({ recorded: true });
    expect((await a.call('add_lead_engagement', { ...args, lead_id: TENANT_A.leads[1].leadId })).json).toMatchObject({ recorded: true });
  });

  it('(4) a lead already holding 50 channel "mcp" events refuses a 51st', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      eventId: `seed-${i}`, eventType: 'custom.note', eventData: { channel: 'mcp' }, createdAt: '2026-11-20T10:00:00.000Z',
    }));
    fake.seed('AW-Leads', { ...leadRow(TENANT_A.listId, a1.leadId), engagements: full, updatedAt: '2026-11-20T10:00:00.000Z' });
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    const o = await a.call('add_lead_engagement', { list_id: TENANT_A.listId, lead_id: a1.leadId, event_type: 'custom.note' });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(/holds 50 events/);
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
  });

  it('(4b) 50 events from other channels do not count toward the cap', async () => {
    const others = Array.from({ length: 50 }, (_, i) => ({
      eventId: `seed-${i}`, eventType: 'email.sent', eventData: { channel: 'smartlead' }, createdAt: '2026-11-20T10:00:00.000Z',
    }));
    fake.seed('AW-Leads', { ...leadRow(TENANT_A.listId, a1.leadId), engagements: others, updatedAt: '2026-11-20T10:00:00.000Z' });
    const o = await a.call('add_lead_engagement', { list_id: TENANT_A.listId, lead_id: a1.leadId, event_type: 'custom.note' });
    expect(o.isError).toBe(false);
    expect(engagementsOf(TENANT_A.listId, a1.leadId)).toHaveLength(51);
  });
});

describe('manage_leads update with status_note', () => {
  it('(5) a real status change stores the note in the status.changed event, not on the lead\'s own notes', async () => {
    const o = await a.call('manage_leads', {
      action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'contacted' }, status_note: '  Left a voicemail  ',
    });
    expect(o.isError).toBe(false);
    expect(o.json?.statusNoteRecorded).toBe(true);
    const row = leadRow(TENANT_A.listId, a1.leadId);
    expect(row.status).toBe('contacted');
    expect(row.notes).toBe(OWN_NOTES);
    expect(row.statusNote).toBeUndefined();
    const changed = (row.engagements ?? []).filter((e: any) => e.eventType === 'status.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].eventData).toMatchObject({ from: 'new', to: 'contacted', notes: 'Left a voicemail' });
  });

  it('(5b) an unchanged status records no event and answers statusNoteRecorded: false', async () => {
    const o = await a.call('manage_leads', {
      action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'new' }, status_note: 'nothing changed',
    });
    expect(o.isError).toBe(false);
    expect(o.json?.statusNoteRecorded).toBe(false);
    const row = leadRow(TENANT_A.listId, a1.leadId);
    expect((row.engagements ?? []).filter((e: any) => e.eventType === 'status.changed')).toEqual([]);
    expect(JSON.stringify(row)).not.toContain('nothing changed');
  });

  it('(5c) status_note without updates.status is refused and nothing is written', async () => {
    const before = snapshotTenant(fake, TENANT_A);
    const o = await a.call('manage_leads', {
      action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { company: 'Alpha Inc' }, status_note: 'why',
    });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(/status_note/);
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
  });

  it('(5d) tenant B cannot change A\'s lead status or leave a note on it', async () => {
    const before = snapshotTenant(fake, TENANT_A);
    const o = await b.call('manage_leads', {
      action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'lost' }, status_note: 'BRAVO was here',
    });
    expect(o.isError).toBe(true);
    noVictimContent(o.text);
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    expect(JSON.stringify(fake.items('AW-Leads'))).not.toContain('BRAVO was here');
  });
});
