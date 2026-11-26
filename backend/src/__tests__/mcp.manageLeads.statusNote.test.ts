/**
 * ENG-2840 (W2-7): manage_leads update's `status_note` (statusNoteArg + executeLeadUpdate). The note is trimmed and sent to the PUT route
 * as body `statusNote` only with `updates.status`; anything else is refused before any call. mcpFetch and the stored-lead read are mocked
 * (as in src/mcp/server/__tests__/manageLeadsWrites.budget.test.ts).
 */
jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../services/db', () => ({ crmDb: { getLeadById: jest.fn() } }));
jest.mock('../emma/impl/leads', () => ({ suppressionContactStatusUpdates: jest.fn(() => ({})) }));

import { mcpFetch } from '../mcp/server/httpClient';
import { crmDb } from '../services/db';
import { executeLeadUpdate, statusNoteArg } from '../mcp/server/manageLeadsWrites';

const mockFetch = mcpFetch as jest.Mock;
const mockStored = (crmDb as any).getLeadById as jest.Mock;
const ctxA = { userId: 'user-a1', agentUserId: 'user-a1' };
const ch = (code: number) => String.fromCharCode(code);

beforeEach(() => {
  mockFetch.mockReset();
  mockStored.mockReset();
});

describe('statusNoteArg', () => {
  it('absent (undefined or null) is no note, with or without a status', () => {
    expect(statusNoteArg(undefined, 'qualified')).toBeUndefined();
    expect(statusNoteArg(null, 'qualified')).toBeUndefined();
    expect(statusNoteArg(undefined, undefined)).toBeUndefined();
    expect(statusNoteArg(null, undefined)).toBeUndefined();
  });

  it('is trimmed', () => {
    expect(statusNoteArg('  Spoke to the CFO  ', 'qualified')).toBe('Spoke to the CFO');
  });

  it('keeps inner line breaks and tabs', () => {
    expect(statusNoteArg(`a${ch(10)}b${ch(9)}c`, 'won')).toBe(`a${ch(10)}b${ch(9)}c`);
  });

  it('accepts 500 characters and refuses 501', () => {
    expect(statusNoteArg('n'.repeat(500), 'won')).toHaveLength(500);
    expect(() => statusNoteArg('n'.repeat(501), 'won')).toThrow(/status_note must be 1 to 500 characters/);
  });

  it.each([
    ['status not being set', undefined],
    ['status null', null],
    ['status a number', 3],
  ])('is refused with %s', (_label, status) => {
    expect(() => statusNoteArg('reason', status)).toThrow(/status_note goes with a status change/);
  });

  it.each([
    ['a number', 7],
    ['an object', { text: 'x' }],
    ['an array', ['x']],
    ['true', true],
  ])('is refused when it is %s', (_label, value) => {
    expect(() => statusNoteArg(value, 'qualified')).toThrow(/status_note must be text/);
  });

  it.each([['empty', ''], ['whitespace only', '   ']])('is refused when %s', (_label, value) => {
    expect(() => statusNoteArg(value, 'qualified')).toThrow(/status_note must be 1 to 500 characters/);
  });

  it.each([
    ['NUL', 0x00], ['BEL', 0x07], ['VT', 0x0b], ['CR', 0x0d], ['ESC', 0x1b], ['DEL', 0x7f], ['NEL (C1)', 0x85],
    ['zero-width space', 0x200b], ['zero-width joiner', 0x200d], ['LRM', 0x200e], ['RLM', 0x200f],
    ['LRE', 0x202a], ['RLO', 0x202e], ['line separator', 0x2028], ['paragraph separator', 0x2029],
    ['LRI', 0x2066], ['PDI', 0x2069], ['BOM / zero-width no-break space', 0xfeff],
  ])('is refused when it contains %s inside the text', (_label, code) => {
    expect(() => statusNoteArg(`before${ch(code)}after`, 'qualified')).toThrow(/no control or invisible characters/);
  });

  // The check runs on the text as sent: String.prototype.trim would remove U+FEFF, U+2028, U+2029, VT, FF and CR at the edges and hide them.
  it.each([
    ['a leading BOM', `${ch(0xfeff)}note`],
    ['a trailing line separator', `note${ch(0x2028)}`],
    ['a trailing CR', `note${ch(0x0d)}`],
  ])('refuses %s at the edge', (_label, value) => {
    expect(() => statusNoteArg(value, 'qualified')).toThrow();
  });
});

describe('executeLeadUpdate sends status_note as the PUT body statusNote', () => {
  const route = () => {
    mockFetch.mockImplementation(async ({ method }: any) => {
      if (method === 'GET') return { leadId: 'lead-1', status: 'new' };
      if (method === 'PUT') return { leadId: 'lead-1', status: 'qualified', statusNoteRecorded: true };
      throw new Error(`unexpected ${method}`);
    });
    mockStored.mockResolvedValue({ leadId: 'lead-1', status: 'new' });
  };
  const putBody = () => mockFetch.mock.calls.find(([o]: any) => o.method === 'PUT')?.[0].body;
  const update = (extra: Record<string, unknown>) =>
    executeLeadUpdate({ action: 'update', list_id: 'list-a1', lead_id: 'lead-1', ...extra }, ctxA);

  it('with updates.status: the trimmed note is in the PUT body as statusNote, next to the status', async () => {
    route();
    const out = await update({ updates: { status: 'qualified' }, status_note: '  Spoke to the CFO  ' });
    expect(putBody()).toMatchObject({ status: 'qualified', statusNote: 'Spoke to the CFO' });
    expect(JSON.parse(out.content[0].text).statusNoteRecorded).toBe(true);
  });

  it('the note never becomes the lead\'s own notes field', async () => {
    route();
    await update({ updates: { status: 'qualified', notes: 'the lead\'s own notes' }, status_note: 'why it moved' });
    expect(putBody().notes).toBe('the lead\'s own notes');
    expect(putBody().statusNote).toBe('why it moved');
    route();
    mockFetch.mockClear();
    await update({ updates: { status: 'qualified' }, status_note: 'why it moved' });
    expect('notes' in putBody()).toBe(false);
  });

  it('absent: no statusNote key in the PUT body', async () => {
    route();
    await update({ updates: { status: 'qualified' } });
    expect(putBody()).toBeDefined();
    expect('statusNote' in putBody()).toBe(false);
  });

  it('null: no statusNote key in the PUT body', async () => {
    route();
    await update({ updates: { status: 'qualified' }, status_note: null });
    expect('statusNote' in putBody()).toBe(false);
  });

  it.each([
    ['status is not being set', { updates: { company: 'Acme' }, status_note: 'why' }],
    ['the note is not text', { updates: { status: 'qualified' }, status_note: 12 }],
    ['the note is empty', { updates: { status: 'qualified' }, status_note: '  ' }],
    ['the note is too long', { updates: { status: 'qualified' }, status_note: 'n'.repeat(501) }],
    ['the note has a control character', { updates: { status: 'qualified' }, status_note: `a${ch(0x1b)}b` }],
    ['the note has a zero-width character', { updates: { status: 'qualified' }, status_note: `a${ch(0x200b)}b` }],
    ['the note has a bidi override', { updates: { status: 'qualified' }, status_note: `a${ch(0x202e)}b` }],
  ])('refused before any call when %s', async (_label, extra) => {
    route();
    await expect(update(extra)).rejects.toThrow(/status_note/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStored).not.toHaveBeenCalled();
  });

  it('a camelCase statusNote inside updates is NOT the status note (it is an ordinary custom field)', async () => {
    route();
    mockFetch.mockImplementation(async ({ method }: any) => (method === 'GET' ? { leadId: 'lead-1' } : { leadId: 'lead-1' }));
    await update({ updates: { statusNote: 'sneaky' } });
    expect('statusNote' in putBody()).toBe(false);
    expect(putBody().customFields).toMatchObject({ statusNote: 'sneaky' });
  });
});
