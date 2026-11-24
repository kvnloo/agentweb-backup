/**
 * ENG-2840 wave 2 (W2-4): the GTM plan tools for outside agents. What each action sends to the route the portal uses, what is refused
 * before anything is sent, and how a batch reports a failure. The end-to-end proof (real routes, real database writes) is in
 * mcp.manageGtm.writes.test.ts; this file pins the request each action builds and every refusal, with no network.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { itemRequests, planRequest } from '../gtmTools';

const mockFetch = mcpFetch as jest.Mock;
const context = { userId: 'user-1', isDelegatedAccess: false, sessionId: 'sess-1', restrictionProfile: undefined, apiKeyId: 'key-1' };

beforeEach(() => mockFetch.mockReset());

describe('manage_gtm_plan: the request each action builds', () => {
  it('create sends title, description and dri, and only what was given', () => {
    expect(planRequest({ action: 'create', title: 'Q1 launch' })).toEqual({ method: 'POST', path: '/api/gtm-plan', body: { title: 'Q1 launch' } });
    expect(planRequest({ action: 'create', title: 'Q1 launch', description: 'Win mid-market', dri: 'owner@example.com' }))
      .toEqual({ method: 'POST', path: '/api/gtm-plan', body: { title: 'Q1 launch', description: 'Win mid-market', dri: 'owner@example.com' } });
  });

  it('ordinary email addresses are accepted (apostrophe, plus tag, subdomain)', () => {
    for (const dri of ["o'brien@example.com", 'first.last+tag@sub.example.co.uk', 'a@b.io']) {
      expect(planRequest({ action: 'create', title: 'T', dri }).body).toEqual({ title: 'T', dri });
    }
  });

  it('every forbidden character is refused in the local part, in the domain label and in the top-level label', () => {
    for (const c of ['<', '>', '"', '(', ')', ',', ';', ':', '[', ']', '\\', ' ', '\t', '\u0000', '\u007f', '​', '﻿']) {
      for (const dri of [`${c}a@b.io`, `a@${c}b.io`, `a@b.i${c}o`, `a${c}@b.io`]) {
        expect(() => planRequest({ action: 'create', title: 'T', dri })).toThrow('dri must be an email address');
      }
    }
  });

  it('empty labels are refused (a double dot, a leading or a trailing dot in the domain)', () => {
    for (const dri of ['a@b..io', 'a@.b.io', 'a@b.io.', 'a@b.', 'a@.io']) {
      expect(() => planRequest({ action: 'create', title: 'T', dri })).toThrow('dri must be an email address');
    }
  });

  it('null means none, the same as an empty string, for optional text, dates and contacts (agents send it to clear a field)', () => {
    expect(itemRequests({ action: 'update_work_item', plan_id: 'p', phase_id: 'ph', work_item_id: 'i', notes: null })[0].body).toEqual({ notes: '' });
    expect(itemRequests({ action: 'update_work_item', plan_id: 'p', phase_id: 'ph', work_item_id: 'i', description: null, dri: null, due_date: null })[0].body)
      .toEqual({ description: '', dri: '', dueDate: '' });
    expect(planRequest({ action: 'update', plan_id: 'p', description: null, dri: null, due_date: null }).body).toEqual({ description: '', dri: '', dueDate: '' });
    expect(itemRequests({ action: 'update_phase', plan_id: 'p', phase_id: 'ph', description: null })[0].body).toEqual({ description: '' });
    expect(itemRequests({ action: 'add_work_items', plan_id: 'p', phase_id: 'ph', work_items: [{ title: 'A', description: null, due_date: null }] })[0].body)
      .toEqual({ title: 'A', description: '', dueDate: '' });
  });

  it('null is not a title, and a value that is neither text nor null still says how to clear a field', () => {
    expect(() => planRequest({ action: 'create', title: null })).toThrow('title is required and cannot be empty');
    expect(() => itemRequests({ action: 'add_phase', plan_id: 'p', title: null })).toThrow('title is required and cannot be empty');
    expect(() => itemRequests({ action: 'update_work_item', plan_id: 'p', phase_id: 'ph', work_item_id: 'i', notes: 5 })).toThrow('notes must be text, or an empty string to clear it');
    expect(() => planRequest({ action: 'update', plan_id: 'p', due_date: 5 })).toThrow('due_date must be text written YYYY-MM-DD, or an empty string to remove it');
  });

  it('a title is sent trimmed', () => {
    expect(planRequest({ action: 'create', title: '  Q1 launch  ' }).body).toEqual({ title: 'Q1 launch' });
    expect(itemRequests({ action: 'add_phase', plan_id: 'p', name: '  Launch ' })[0].body).toEqual({ title: 'Launch' });
  });

  it('get and delete address the plan by an escaped id', () => {
    expect(planRequest({ action: 'get', plan_id: 'plan-1' })).toEqual({ method: 'GET', path: '/api/gtm-plan/plan-1' });
    expect(planRequest({ action: 'delete', plan_id: 'a/b' })).toEqual({ method: 'DELETE', path: '/api/gtm-plan/a%2Fb' });
  });

  it('update renames due_date to the route\'s dueDate; an empty string is sent (it clears)', () => {
    expect(planRequest({ action: 'update', plan_id: 'p1', title: 'New', due_date: '2026-12-31' }))
      .toEqual({ method: 'PUT', path: '/api/gtm-plan/p1', body: { title: 'New', dueDate: '2026-12-31' } });
    expect(planRequest({ action: 'update', plan_id: 'p1', dri: '', due_date: '', description: '' }))
      .toEqual({ method: 'PUT', path: '/api/gtm-plan/p1', body: { dri: '', dueDate: '', description: '' } });
  });
});

describe('the limits are exactly these (a value at the limit is accepted, one over is refused above)', () => {
  it('title 300, description 5000, notes 5000 characters, 20 items in a batch', () => {
    expect(planRequest({ action: 'create', title: 'x'.repeat(300), description: 'y'.repeat(5000) }).body).toEqual({ title: 'x'.repeat(300), description: 'y'.repeat(5000) });
    expect(itemRequests({ action: 'update_work_item', plan_id: 'p', phase_id: 'ph', work_item_id: 'i', notes: 'n'.repeat(5000) })).toHaveLength(1);
    expect(itemRequests({ action: 'add_work_items', plan_id: 'p', phase_id: 'ph', work_items: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}` })) })).toHaveLength(20);
  });
});

describe('manage_gtm_plan: refused before anything is sent', () => {
  it.each([
    [{ action: 'create', title: 'T', goals: ['x'] }, '"goals" is not stored on a plan'],
    [{ action: 'create', title: 'T', target_audience: 'SMB', timeline: 'Q1', budget: '10k' }, '"target_audience", "timeline", "budget" are not stored'],
    [{ action: 'update', plan_id: 'p', status: 'completed' }, '"status" cannot be set'],
    [{ action: 'create', title: 'T', userId: 'someone-else' }, '"userId" is not an input of manage_gtm_plan create'],
    [{ action: 'get', plan_id: 'p', title: 'T' }, '"title" is not an input'],
    [{ action: 'delete', plan_id: 'p', description: 'x' }, '"description" is not an input'],
    [{ action: 'frobnicate' }, 'action must be one of: create, get, update, delete'],
    [{}, 'action must be one of'],
    [{ action: 'create' }, 'title is required'],
    [{ action: 'create', title: '   ' }, 'title is required and cannot be empty'],
    [{ action: 'create', title: 7 }, 'title must be text'],
    [{ action: 'create', title: 'x'.repeat(301) }, 'title is too long'],
    [{ action: 'create', title: 'T', description: 'x'.repeat(5001) }, 'description is too long'],
    [{ action: 'create', title: 'T', description: { a: 1 } }, 'description must be text'],
    [{ action: 'create', title: 'T', dri: 'not-an-email' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'Evil<victim@x.com>' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@b.co,c@d.ef' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: '"x"@y.zz' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: '<img/src=x/onerror=alert(1)>@a.bc' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@b.co;c@d.ef' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@b.co:c' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@b\\c.io' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: '(x)a@b.co' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@b.co\u0000' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a\u200b@b.co' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@b..co' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@.b.co' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@b.co.' }, 'dri must be an email address'],
    [{ action: 'create', title: 'T', dri: 'a@@b.co' }, 'dri must be an email address'],
    [{ action: 'get', plan_id: '\uD800' }, 'plan_id is not a valid id'],
    [{ action: 'get' }, 'plan_id is required'],
    [{ action: 'get', plan_id: 'has space' }, 'plan_id is not a valid id'],
    [{ action: 'get', plan_id: 'a\nb' }, 'plan_id is not a valid id'],
    [{ action: 'get', plan_id: 'x'.repeat(201) }, 'plan_id is not a valid id'],
    [{ action: 'get', plan_id: 42 }, 'plan_id is required and must be text'],
    [{ action: 'update', plan_id: 'p' }, 'update needs at least one of title, description, dri, due_date'],
    [{ action: 'update', plan_id: 'p', due_date: '2026-13-01' }, 'due_date must be a date written YYYY-MM-DD'],
    [{ action: 'update', plan_id: 'p', due_date: '2026-02-30' }, 'due_date must be a date written YYYY-MM-DD'],
    [{ action: 'update', plan_id: 'p', due_date: '12/31/2026' }, 'due_date must be a date written YYYY-MM-DD'],
    [{ action: 'update', plan_id: 'p', due_date: '2026-12-31T00:00:00Z' }, 'due_date must be a date written YYYY-MM-DD'],
    [{ action: 'update', plan_id: 'p', due_date: 20261231 }, 'due_date must be text written YYYY-MM-DD'],
  ])('%j -> %s', (args, message) => {
    expect(() => planRequest(args)).toThrow(message);
    expect(() => planRequest(args)).toThrow('Nothing was changed.');
  });

  it('refuses arguments that are not an object', () => {
    for (const args of [undefined, null, 'create', 5, ['create']]) expect(() => planRequest(args)).toThrow('the arguments must be an object');
  });
});

describe('manage_gtm_items: the request each action builds', () => {
  it('add_phase sends title (the route\'s name for it); name is accepted as the old spelling', () => {
    const expected = { method: 'POST', path: '/api/gtm-plan/p1/phases', body: { title: 'Launch', description: 'Go live', dri: 'a@b.co', dueDate: '2026-12-01' } };
    expect(itemRequests({ action: 'add_phase', plan_id: 'p1', title: 'Launch', description: 'Go live', dri: 'a@b.co', due_date: '2026-12-01' })).toEqual([expected]);
    expect(itemRequests({ action: 'add_phase', plan_id: 'p1', name: 'Launch', description: 'Go live', dri: 'a@b.co', due_date: '2026-12-01' })).toEqual([expected]);
    expect(itemRequests({ action: 'add_phase', plan_id: 'p1', title: 'Launch', name: 'Launch' })).toHaveLength(1);
  });

  it('update_phase calls the phase route with only the given fields', () => {
    expect(itemRequests({ action: 'update_phase', plan_id: 'p1', phase_id: 'ph1', title: 'Renamed', due_date: '' }))
      .toEqual([{ method: 'PUT', path: '/api/gtm-plan/p1/phases/ph1', body: { title: 'Renamed', dueDate: '' } }]);
  });

  it('delete_phase and delete_work_item address the id they name', () => {
    expect(itemRequests({ action: 'delete_phase', plan_id: 'p1', phase_id: 'ph1' })).toEqual([{ method: 'DELETE', path: '/api/gtm-plan/p1/phases/ph1' }]);
    expect(itemRequests({ action: 'delete_work_item', plan_id: 'p1', phase_id: 'ph1', work_item_id: 'i/1' }))
      .toEqual([{ method: 'DELETE', path: '/api/gtm-plan/p1/phases/ph1/work-items/i%2F1' }]);
  });

  it('add_work_items builds one single-item request per item, in order, each with the route\'s own field names', () => {
    expect(itemRequests({
      action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1',
      work_items: [{ title: 'A', due_date: '2026-11-30' }, { name: 'B', description: 'd', dri: 'x@y.zz' }],
    })).toEqual([
      { method: 'POST', path: '/api/gtm-plan/p1/phases/ph1/work-items', body: { title: 'A', dueDate: '2026-11-30' } },
      { method: 'POST', path: '/api/gtm-plan/p1/phases/ph1/work-items', body: { title: 'B', description: 'd', dri: 'x@y.zz' } },
    ]);
  });

  it('update_work_item sends the route\'s field names (title, description, status, notes, dri, dueDate)', () => {
    expect(itemRequests({
      action: 'update_work_item', plan_id: 'p1', phase_id: 'ph1', work_item_id: 'i1',
      title: 'T', status: 'completed', notes: 'done', dri: 'me@x.io', due_date: '2026-12-02', description: '',
    })).toEqual([{
      method: 'PUT', path: '/api/gtm-plan/p1/phases/ph1/work-items/i1',
      body: { title: 'T', description: '', status: 'completed', notes: 'done', dri: 'me@x.io', dueDate: '2026-12-02' },
    }]);
  });

  it('update_work_item sends only what was given, and never a notifications object', () => {
    const [req] = itemRequests({ action: 'update_work_item', plan_id: 'p1', phase_id: 'ph1', work_item_id: 'i1', status: 'skipped' });
    expect(req.body).toEqual({ status: 'skipped' });
    expect(req.body).not.toHaveProperty('notifications');
  });

  it('add_common_items sends only a title and a description per item (id and sortOrder from get_common_items are accepted and left out)', () => {
    expect(itemRequests({
      action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1',
      items: [{ id: 'ci-1', sortOrder: 3, title: ' Blog strategy ', description: 'Plan posts' }, { title: 'Podcast' }],
    })).toEqual([{ method: 'POST', path: '/api/gtm-plan/p1/add-common-items', body: { items: [{ title: 'Blog strategy', description: 'Plan posts' }, { title: 'Podcast' }], targetPhaseId: 'ph1' } }]);
    expect(itemRequests({ action: 'add_common_items', plan_id: 'p', target_phase_id: 'ph', items: Array.from({ length: 50 }, (_, i) => ({ title: `T${i}` })) })[0].body!.items).toHaveLength(50);
  });

  it('a common item with a null description is the same as one without', () => {
    expect(itemRequests({ action: 'add_common_items', plan_id: 'p', target_phase_id: 'ph', items: [{ title: 'Blog', description: null }] })[0].body)
      .toEqual({ items: [{ title: 'Blog' }], targetPhaseId: 'ph' });
  });

  it('get_common_items and add_common_items', () => {
    expect(itemRequests({ action: 'get_common_items' })).toEqual([{ method: 'GET', path: '/api/gtm-plan/common-items' }]);
    // the previous schema listed plan_id as required for every action, so clients send one: accepted, and not part of the request
    expect(itemRequests({ action: 'get_common_items', plan_id: 'p1' })).toEqual([{ method: 'GET', path: '/api/gtm-plan/common-items' }]);
    expect(itemRequests({ action: 'add_common_items', plan_id: 'p1', items: [{ title: 'Blog' }], target_phase_id: 'ph1' }))
      .toEqual([{ method: 'POST', path: '/api/gtm-plan/p1/add-common-items', body: { items: [{ title: 'Blog' }], targetPhaseId: 'ph1' } }]);
    expect(itemRequests({ action: 'add_common_items', plan_id: 'p1', items: [{ title: 'Blog' }], new_phase_name: 'Content' }))
      .toEqual([{ method: 'POST', path: '/api/gtm-plan/p1/add-common-items', body: { items: [{ title: 'Blog' }], newPhaseName: 'Content' } }]);
  });

});

describe('manage_gtm_items: refused before anything is sent', () => {
  const ids = { plan_id: 'p1', phase_id: 'ph1', work_item_id: 'i1' };
  it.each([
    [{ action: 'add_phase', ...ids, title: 'T', status: 'in_progress' }, '"status" cannot be set on a phase'],
    [{ action: 'update_phase', plan_id: 'p1', phase_id: 'ph1', status: 'completed' }, '"status" cannot be set on a phase'],
    [{ action: 'add_phase', plan_id: 'p1', title: 'A', name: 'B' }, 'send title, not both title and name'],
    [{ action: 'add_phase', plan_id: 'p1' }, 'title is required'],
    [{ action: 'add_phase', plan_id: 'p1', title: 'T', work_items: [] }, '"work_items" is not an input of manage_gtm_items add_phase'],
    [{ action: 'add_phase', title: 'T' }, 'plan_id is required'],
    [{ action: 'update_phase', plan_id: 'p1', phase_id: 'ph1' }, 'needs at least one of title, description, dri, due_date'],
    [{ action: 'update_phase', plan_id: 'p1', title: 'T' }, 'phase_id is required'],
    [{ action: 'delete_phase', plan_id: 'p1' }, 'phase_id is required'],
    [{ action: 'delete_work_item', plan_id: 'p1', phase_id: 'ph1' }, 'work_item_id is required'],
    [{ action: 'get_common_items', title: 'x' }, '"title" is not an input of manage_gtm_items get_common_items'],
    [{ action: 'update_work_item', ...ids }, 'needs at least one of title, description, status, notes, dri, due_date'],
    [{ action: 'update_work_item', ...ids, status: 'banana' }, 'status must be one of: pending, in_progress, completed, skipped'],
    [{ action: 'update_work_item', ...ids, status: 3 }, 'status must be one of'],
    [{ action: 'update_work_item', ...ids, notes: 'x'.repeat(5001) }, 'notes is too long'],
    [{ action: 'update_work_item', ...ids, due_date: 'soon' }, 'due_date must be a date written YYYY-MM-DD'],
    [{ action: 'update_work_item', ...ids, dri: 'someone' }, 'dri must be an email address'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1' }, 'work_items must be a non-empty list'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [] }, 'work_items must be a non-empty list'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: 'A' }, 'work_items must be a non-empty list'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: Array.from({ length: 21 }, (_, i) => ({ title: `T${i}` })) }, 'the most in one call is 20'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'ok' }, 'text'] }, 'work_items[1]: each item must be an object'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'ok' }, { description: 'no title' }] }, 'work_items[1]: title is required'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'ok', status: 'completed' }] }, 'work_items[0]: "status" is not an input'],
    [{ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'ok', due_date: 'x' }] }, 'work_items[0]: due_date must be a date'],
    [{ action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1' }, 'items must be a non-empty list'],
    [{ action: 'add_common_items', plan_id: 'p1', items: [], target_phase_id: 'ph1' }, 'items must be a non-empty list'],
    [{ action: 'add_common_items', plan_id: 'p1', items: [{ title: 'x' }] }, 'send exactly one of target_phase_id'],
    [{ action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1', items: Array.from({ length: 51 }, (_, i) => ({ title: `T${i}` })) }, 'the most in one call is 50'],
    [{ action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1', items: [{ title: 'ok' }, 'text'] }, 'items[1]: each item must be an object'],
    [{ action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1', items: [{ description: 'no title' }] }, 'items[0]: title is required'],
    [{ action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1', items: [{ title: 'ok', dri: 'x@y.zz', status: 'completed' }] }, 'items[0]: "dri", "status" are not inputs'],
    [{ action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1', items: [{ title: 'ok', description: 5 }] }, 'items[0]: description must be text'],
    [{ action: 'add_common_items', plan_id: 'p1', target_phase_id: 'ph1', items: [null] }, 'items[0]: each item must be an object'],
    [{ action: 'add_common_items', plan_id: 'p1', items: [{ title: 'x' }], target_phase_id: 'ph1', new_phase_name: 'N' }, 'send exactly one of target_phase_id'],
    [{ action: 'nope', plan_id: 'p1' }, 'action must be one of: add_phase'],
    // emailing is not available over MCP (the report templates put text into HTML unescaped); each way in is refused with the reason
    [{ action: 'send_status_report', plan_id: 'p1', notify_user: true }, 'emailing people is not available over MCP'],
    [{ action: 'send_status_report', plan_id: 'p1' }, 'manage_gtm_items send_status_report: emailing people is not available over MCP'],
    [{ action: 'send_status_report', plan_id: 'p1', include_summary: true }, 'emailing people is not available over MCP'],
    [{ action: 'update_work_item', ...ids, status: 'completed', notify_user: true }, '"notify_user": emailing people is not available over MCP'],
    [{ action: 'update_work_item', ...ids, status: 'completed', notify_item_poc: false }, '"notify_item_poc": emailing people'],
    [{ action: 'update_work_item', ...ids, status: 'completed', notify_phase_pocs: true }, '"notify_phase_pocs": emailing people'],
    [{ action: 'update_work_item', ...ids, status: 'completed', notify_phase_poc: true, notify_plan_poc: true }, '"notify_phase_poc", "notify_plan_poc": emailing people'],
    [{ action: 'update_work_item', ...ids, status: 'completed', notification_message: 'hi' }, '"notification_message": emailing people'],
    [{ action: 'update_work_item', ...ids, status: 'completed', notifications: { notifyUser: true, message: '<b>x</b>' } }, '"notifications": emailing people'],
    [{ action: 'add_phase', plan_id: 'p1', title: 'T', message: 'x' }, '"message": emailing people'],
  ])('%j -> %s', (args, message) => {
    expect(() => itemRequests(args)).toThrow(message);
  });

  it('every refusal says nothing was changed', () => {
    expect(() => itemRequests({ action: 'add_phase', plan_id: 'p1' })).toThrow('Nothing was changed.');
  });

  it('a batch with one bad item builds NO request (nothing is sent for the good ones before it)', () => {
    expect(() => itemRequests({ action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'good' }, { title: '' }] })).toThrow('work_items[1]');
  });
});

describe('the registered tools', () => {
  const run = (name: string, args: unknown) => mcpToolRegistry.execute(name, args, context);

  it('send the request as the caller, through mcpFetch, and return the route\'s answer', async () => {
    mockFetch.mockResolvedValue({ success: true, data: { planId: 'plan-9' } });
    const result: any = await run('manage_gtm_plan', { action: 'create', title: 'Q1' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith({
      method: 'POST', path: '/api/gtm-plan', body: { title: 'Q1' },
      context: expect.objectContaining({ userId: 'user-1', sessionId: 'sess-1' }),
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true, data: { planId: 'plan-9' } });
  });

  it('a refusal never reaches the network', async () => {
    await expect(run('manage_gtm_plan', { action: 'create', title: 'Q1', goals: ['x'] })).rejects.toThrow('"goals" is not stored on a plan');
    await expect(run('manage_gtm_items', { action: 'send_status_report', plan_id: 'p1', notify_user: true })).rejects.toThrow('emailing people is not available over MCP');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('propagates a refusal from the route (not the owner\'s plan)', async () => {
    mockFetch.mockRejectedValue(new Error('API error (403): Access denied'));
    await expect(run('manage_gtm_items', { action: 'delete_phase', plan_id: 'p1', phase_id: 'ph1' })).rejects.toThrow('Access denied');
  });

  describe('add_work_items', () => {
    const planAfter = (titles: string[]) => ({
      success: true,
      data: { phases: [{ id: 'ph1', workItems: titles.map((title, i) => ({ id: `item-${i + 1}`, title })) }] },
    });

    it('adds the items one after the other and returns the new ids', async () => {
      mockFetch
        .mockResolvedValueOnce(planAfter(['A']))
        .mockResolvedValueOnce(planAfter(['A', 'B']));
      const result: any = await run('manage_gtm_items', { action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'A' }, { title: 'B' }] });
      expect(mockFetch.mock.calls.map((c) => c[0].body.title)).toEqual(['A', 'B']);
      const body = JSON.parse(result.content[0].text);
      expect(body).toMatchObject({ success: true, message: '2 work items added', added: [{ id: 'item-1', title: 'A' }, { id: 'item-2', title: 'B' }] });
      expect(body.plan.phases[0].workItems).toHaveLength(2);
    });

    it('says "1 work item added" for one', async () => {
      mockFetch.mockResolvedValueOnce(planAfter(['A']));
      const result: any = await run('manage_gtm_items', { action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'A' }] });
      expect(JSON.parse(result.content[0].text).message).toBe('1 work item added');
    });

    it('on a failure names the items added before it, does not try the ones after it, and says nothing was rolled back', async () => {
      mockFetch
        .mockResolvedValueOnce(planAfter(['A']))
        .mockResolvedValueOnce(planAfter(['A', 'B']))
        .mockRejectedValueOnce(new Error('API error (404): Phase not found'))
        .mockResolvedValue(planAfter(['never']));
      await expect(run('manage_gtm_items', {
        action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }],
      })).rejects.toThrow('item 3 of 4 failed (API error (404): Phase not found). Added before it: "A", "B". The items after it were not tried; nothing was rolled back.');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('sends the items strictly one after the other: the second request starts only after the first one answered', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      mockFetch
        .mockImplementationOnce(() => gate.then(() => planAfter(['A'])))
        .mockResolvedValueOnce(planAfter(['A', 'B']));
      const pending = run('manage_gtm_items', { action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'A' }, { title: 'B' }] });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      release();
      await pending;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('a failure message warns that a timeout may still have written the failed item', async () => {
      mockFetch.mockRejectedValueOnce(new Error('MCP self-call timed out'));
      await expect(run('manage_gtm_items', { action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'A' }] }))
        .rejects.toThrow('may still have been written: read the plan before retrying');
    });

    it('a failure on the first item says no item was added', async () => {
      mockFetch.mockRejectedValueOnce(new Error('API error (404): Phase not found'));
      await expect(run('manage_gtm_items', { action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'A' }, { title: 'B' }] }))
        .rejects.toThrow('item 1 of 2 failed (API error (404): Phase not found). No item was added before it.');
    });

    it('falls back to the title sent when the answer does not show the new item', async () => {
      mockFetch.mockResolvedValueOnce({ success: true, data: { phases: [] } });
      const result: any = await run('manage_gtm_items', { action: 'add_work_items', plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'A' }] });
      expect(JSON.parse(result.content[0].text).added).toEqual([{ title: 'A' }]);
    });
  });

  it('declares exactly the inputs the handler accepts, so a client can build a valid call from the schema', () => {
    const schema = (name: string) => (mcpToolRegistry.getTool(name) as any).definition.inputSchema;
    const planInputs = Object.keys(schema('manage_gtm_plan').properties).filter((k) => k !== 'action').sort();
    expect(planInputs).toEqual(['description', 'dri', 'due_date', 'plan_id', 'title']);
    const itemProps = Object.keys(schema('manage_gtm_items').properties).sort();
    // every property is an input of at least one action, and every action input is a property
    const used = new Set(['action', 'plan_id', 'phase_id', 'work_item_id', 'title', 'name', 'description', 'dri', 'due_date', 'work_items', 'status', 'notes',
      'items', 'target_phase_id', 'new_phase_name']);
    expect(new Set(itemProps)).toEqual(used);
    expect(schema('manage_gtm_items').required).toEqual(['action']);
    expect(schema('manage_gtm_plan').properties).not.toHaveProperty('goals');
    expect(schema('manage_gtm_items').properties).not.toHaveProperty('include_summary');
    // nothing that emails is offered
    expect(itemProps.filter((k) => /notif|message/.test(k))).toEqual([]);
    expect(schema('manage_gtm_items').properties.action.enum).not.toContain('send_status_report');
    // the batch and the common items are bounded in the schema as in the handler
    expect(schema('manage_gtm_items').properties.work_items.maxItems).toBe(20);
    expect(schema('manage_gtm_items').properties.items.maxItems).toBe(50);
  });
});
