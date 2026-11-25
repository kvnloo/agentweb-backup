/**
 * ENG-2840 (W2-5a): the three lead reads for outside agents (`get_lead_details`, `get_lead_engagements`, `get_lead_list_statuses`).
 * What each call sends to the route, what is refused before anything is called, and that a refusal from the route is an error and never
 * data. No network: the self-call is a double. The tenant check itself lives on the route (emmaApi.leadReadback.test.ts) and is proved
 * end to end with two tenants in mcp.leadReads.twoTenant.test.ts.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import {
  ENGAGEMENTS_DEFAULT_LIMIT,
  ENGAGEMENTS_MAX_LIMIT,
  leadDetailsRequest,
  leadEngagementsRequest,
  leadListStatusesRequest,
  requireSuccess,
} from '../leadReadTools';

const mockFetch = mcpFetch as jest.Mock;
const context = { userId: 'user-1', sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true, restrictionProfile: undefined };

beforeEach(() => mockFetch.mockReset());

const TOOLS = ['get_lead_details', 'get_lead_engagements', 'get_lead_list_statuses'] as const;
const call = (name: string, args: unknown) => (mcpToolRegistry.getTool(name) as any).execute(args, context);
const ids = { list_id: 'list_1', lead_id: 'lead_1' };
const LINE_SEPARATOR = String.fromCharCode(0x2028);
/** The arguments each tool accepts (the list tool takes no lead id: one sent is refused by name). */
const argsFor = (name: string) => (name === 'get_lead_list_statuses' ? { list_id: 'list_1' } : ids);

describe('the request each tool builds', () => {
  it('get_lead_details posts both ids to the Emma lead-details route and nothing else', () => {
    expect(leadDetailsRequest(ids)).toEqual({ path: '/api/emma/lead-details', body: { list_id: 'list_1', lead_id: 'lead_1' } });
  });

  it('get_lead_engagements posts both ids, and a limit only when one was given', () => {
    expect(leadEngagementsRequest(ids)).toEqual({ path: '/api/emma/lead-engagements', body: { list_id: 'list_1', lead_id: 'lead_1' } });
    expect(leadEngagementsRequest({ ...ids, limit: null }).body).toEqual({ list_id: 'list_1', lead_id: 'lead_1' });
    expect(leadEngagementsRequest({ ...ids, limit: 50 }).body).toEqual({ list_id: 'list_1', lead_id: 'lead_1', limit: 50 });
  });

  it('get_lead_list_statuses posts the list id', () => {
    expect(leadListStatusesRequest({ list_id: 'list_1' })).toEqual({ path: '/api/emma/lead-list-statuses', body: { list_id: 'list_1' } });
  });

  it('the limit bounds are Emma\'s own: 1 and 100 pass, anything else is refused and not clamped', () => {
    expect(ENGAGEMENTS_DEFAULT_LIMIT).toBe(20);
    expect(ENGAGEMENTS_MAX_LIMIT).toBe(100);
    for (const limit of [1, 100]) expect(leadEngagementsRequest({ ...ids, limit }).body.limit).toBe(limit);
    for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', true, [5], {}]) {
      expect(() => leadEngagementsRequest({ ...ids, limit })).toThrow(/limit must be a whole number from 1 to 100/);
    }
  });
});

describe('arguments are checked by name, before anything is called', () => {
  const builders: Array<[string, (a: unknown) => unknown, Record<string, unknown>]> = [
    ['get_lead_details', leadDetailsRequest, ids],
    ['get_lead_engagements', leadEngagementsRequest, ids],
    ['get_lead_list_statuses', leadListStatusesRequest, { list_id: 'list_1' }],
  ];

  it.each(builders)('%s refuses an argument that is not an input, naming it (identity overrides included)', (name, build, ok) => {
    for (const extra of ['userId', 'user_id', 'client_id', 'tenantId', 'orgId', 'accountOwnerUserId', 'anything']) {
      expect(() => build({ ...ok, [extra]: 'x' })).toThrow(new RegExp(`${name}: "${extra}" is not an input of ${name}`));
    }
  });

  it('get_lead_list_statuses takes a list only: a lead_id sent to it is refused by name, and the other two tools refuse a list-only call for lack of a lead', () => {
    expect(() => leadListStatusesRequest({ list_id: 'list_1', lead_id: 'lead_1' })).toThrow(/get_lead_list_statuses: "lead_id" is not an input of get_lead_list_statuses\. Its inputs are: list_id\./);
    expect(() => leadDetailsRequest({ list_id: 'list_1' })).toThrow(/lead_id is required and must be text/);
    expect(() => leadEngagementsRequest({ list_id: 'list_1' })).toThrow(/lead_id is required and must be text/);
  });

  it.each(builders)('%s refuses arguments that are not an object', (name, build) => {
    for (const bad of ['list_1', 7, true, ['list_1']]) expect(() => build(bad)).toThrow(/arguments must be an object/);
  });

  it.each(builders)('%s refuses a list_id that is missing, empty, blank, not text, padded, or has control characters', (name, build, ok) => {
    for (const list_id of [undefined, null, '', '   ', 7, true, ['list_1'], { $ne: '' }, ' list_1', 'list_1 ', 'list\n1', 'list\u00001', 'a' + LINE_SEPARATOR + 'b']) {
      expect(() => build({ ...ok, list_id })).toThrow(/list_id/);
    }
  });

  it.each(builders.slice(0, 2))('%s refuses a lead_id that is missing, empty, blank, not text, padded, or has control characters', (name, build, ok) => {
    for (const lead_id of [undefined, null, '', '   ', 7, ['lead_1'], { $gt: '' }, ' lead_1', 'lead_1\t', 'lead\r1', 'lead\u007f1']) {
      expect(() => build({ ...ok, lead_id })).toThrow(/lead_id/);
    }
  });

  it('an id longer than 200 characters is refused, 200 is allowed', () => {
    expect(() => leadDetailsRequest({ list_id: 'a'.repeat(201), lead_id: 'x' })).toThrow(/list_id is not a valid id/);
    expect(leadDetailsRequest({ list_id: 'a'.repeat(200), lead_id: 'x' }).body.list_id).toHaveLength(200);
  });

  it('ids an import or an email key produces are accepted (the id shape is not AgentWeb\'s alone)', () => {
    for (const lead_id of ['lead_1700000000000_ab12cd34e', 'jane@acme.test', 'imported-9981', 'row 12', 'ID:00Q5g00000AbCdE']) {
      expect(leadDetailsRequest({ list_id: 'list_1', lead_id }).body.lead_id).toBe(lead_id);
    }
  });

  it('an invalid call never reaches the route', async () => {
    await expect(call('get_lead_details', { list_id: 'list_1' })).rejects.toThrow(/lead_id/);
    await expect(call('get_lead_engagements', { ...ids, userId: 'victim' })).rejects.toThrow(/"userId" is not an input/);
    await expect(call('get_lead_list_statuses', {})).rejects.toThrow(/list_id/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('requireSuccess: a refusal is an error, never data', () => {
  it('passes a success answer through unchanged', () => {
    const answer = { success: true, lead: { leadId: 'lead_1' }, note: 'x' };
    expect(requireSuccess('get_lead_details', answer)).toBe(answer);
  });

  it.each([
    ['access denied', { success: false, message: 'Access denied', error: 'You do not have permission to access this list' }],
    ['list not found', { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' }],
    ['lead not found', { success: false, message: 'Lead not found' }],
  ])('%s becomes an error that carries the route\'s message', (_label, answer) => {
    expect(() => requireSuccess('get_lead_details', answer)).toThrow(`get_lead_details: ${(answer as any).message}.`);
  });

  it('never repeats the route\'s `error` field: on an internal failure it holds the raw exception text', () => {
    let thrown = '';
    try {
      requireSuccess('get_lead_engagements', { success: false, message: 'Failed to get lead engagements', error: 'ProvisionedThroughputExceededException: table AW-EmailEvents arn:aws:dynamodb:us-west-2:992382574572' });
    } catch (err: any) {
      thrown = err.message;
    }
    expect(thrown).toBe('get_lead_engagements: Failed to get lead engagements.');
    expect(thrown).not.toMatch(/Dynamo|arn:|AW-EmailEvents|Throughput/);
  });

  it('anything that is not success === true is refused: false, missing, the text "true", a number', () => {
    for (const success of [false, undefined, null, 'true', 1, {}]) {
      expect(() => requireSuccess('get_lead_list_statuses', { success, statuses: [{ id: 'secret' }] })).toThrow(/^get_lead_list_statuses: /);
    }
  });

  it('an answer that is not an object is refused (a null, a string, a list, nothing)', () => {
    for (const answer of [null, undefined, 'ok', 7, ['x'], true]) {
      expect(() => requireSuccess('get_lead_details', answer)).toThrow(/the CRM gave no answer/);
    }
  });

  it('a refusal with no message, or a blank one, still says it was refused; a long message is cut', () => {
    expect(() => requireSuccess('get_lead_details', { success: false })).toThrow('get_lead_details: the request was refused.');
    expect(() => requireSuccess('get_lead_details', { success: false, message: '   ' })).toThrow('get_lead_details: the request was refused.');
    expect(() => requireSuccess('get_lead_details', { success: false, message: 7 })).toThrow('get_lead_details: the request was refused.');
    let thrown = '';
    try {
      requireSuccess('get_lead_details', { success: false, message: 'x'.repeat(5000) });
    } catch (err: any) {
      thrown = err.message;
    }
    expect(thrown.length).toBeLessThan(260);
  });
});

describe('a call through the registered tool', () => {
  it('posts to the route as the caller (service context only), once, and returns the answer as the text result', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, lead: { leadId: 'lead_1', email: 'jane@acme.test' } });
    const result = await call('get_lead_details', ids);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/emma/lead-details',
      context: expect.objectContaining({ userId: 'user-1', sessionId: 'sess-1' }),
      body: { list_id: 'list_1', lead_id: 'lead_1' },
    });
    // the self-call context is the narrowed one: nothing about the key or the client is forwarded
    expect(mockFetch.mock.calls[0][0].context).not.toHaveProperty('apiKeyId');
    expect(mockFetch.mock.calls[0][0].context).not.toHaveProperty('externalMcp');
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true, lead: { leadId: 'lead_1', email: 'jane@acme.test' } });
  });

  it('get_lead_engagements sends the limit; get_lead_list_statuses sends only the list id', async () => {
    mockFetch.mockResolvedValue({ success: true });
    await call('get_lead_engagements', { ...ids, limit: 5 });
    await call('get_lead_list_statuses', { list_id: 'list_1' });
    expect(mockFetch.mock.calls[0][0]).toMatchObject({ path: '/api/emma/lead-engagements', body: { list_id: 'list_1', lead_id: 'lead_1', limit: 5 } });
    expect(mockFetch.mock.calls[1][0]).toMatchObject({ path: '/api/emma/lead-list-statuses', body: { list_id: 'list_1' } });
  });

  it.each(TOOLS)('%s: a refusal from the route (HTTP 200, success false) is thrown, not returned', async (name) => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'Access denied', error: 'You do not have permission to access this list' });
    await expect(call(name, argsFor(name))).rejects.toThrow(`${name}: Access denied.`);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(TOOLS)('%s: a 5xx from the route is replaced by a fixed text: the route answers it with the exception\'s own message', async (name) => {
    for (const status of [500, 502, 503]) {
      mockFetch.mockRejectedValueOnce(new Error(`API error (${status}): ProvisionedThroughputExceededException on table AW-Leads arn:aws:dynamodb:us-west-2:992382574572`));
      let thrown = '';
      try {
        await call(name, argsFor(name));
      } catch (err: any) {
        thrown = err.message;
      }
      expect(thrown).toBe(`${name}: the CRM could not answer (HTTP ${status}). Try again later; nothing was changed.`);
      expect(thrown).not.toMatch(/Dynamo|arn:|AW-Leads|Throughput/);
    }
  });

  it.each(TOOLS)('%s: a 4xx from the route (a 429 for an account over its monthly quota, a 400) and a network failure pass through as errors', async (name) => {
    mockFetch.mockRejectedValueOnce(new Error('API error (429): {"error":"usage limit reached"}'));
    await expect(call(name, argsFor(name))).rejects.toThrow('API error (429): {"error":"usage limit reached"}');
    mockFetch.mockRejectedValueOnce(new Error('API error (400): list_id is required'));
    await expect(call(name, argsFor(name))).rejects.toThrow('API error (400): list_id is required');
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(call(name, argsFor(name))).rejects.toThrow('fetch failed');
  });
});

describe('registration', () => {
  it.each(TOOLS)('%s is registered for a user account, not read-only, with no opt-in scope and no key-only gate', (name) => {
    const tool = mcpToolRegistry.getTool(name) as any;
    expect(tool).toBeDefined();
    expect(tool.requiresUserAccount).toBe(true);
    // a read can store a fetched email body and check a LinkedIn account: a tools:read key must not reach it (same as manage_leads, search_leads)
    expect(tool.readOnly).toBeFalsy();
    expect(tool.requiredScope).toBeUndefined();
    expect(tool.apiKeyOnly).toBeFalsy();
    expect(tool.internal).toBeFalsy();
    expect(tool.internalOnly).toBeFalsy();
  });

  it('each schema lists exactly the inputs the handler accepts, and requires the ids', () => {
    const schema = (name: string) => (mcpToolRegistry.getTool(name) as any).definition.inputSchema;
    expect(Object.keys(schema('get_lead_details').properties)).toEqual(['list_id', 'lead_id']);
    expect(Object.keys(schema('get_lead_engagements').properties)).toEqual(['list_id', 'lead_id', 'limit']);
    expect(Object.keys(schema('get_lead_list_statuses').properties)).toEqual(['list_id']);
    expect(schema('get_lead_details').required).toEqual(['list_id', 'lead_id']);
    expect(schema('get_lead_engagements').required).toEqual(['list_id', 'lead_id']);
    expect(schema('get_lead_list_statuses').required).toEqual(['list_id']);
  });

  it('the descriptions say what the read can touch, what it cannot see, and what is refused', () => {
    for (const name of ['get_lead_details', 'get_lead_engagements'] as const) {
      const description = (mcpToolRegistry.getTool(name) as any).definition.description as string;
      expect(description).toMatch(/Reading never changes the lead/);
      expect(description).toMatch(/every email event that has none stored yet from the mail provider, all at once/);
      expect(description).toMatch(/sending-domain setting/);
      expect(description).toMatch(/does not prove a lead was never emailed/);
      expect(description).toMatch(/engagementSummary\.total and last7Days count messages SENT/);
      expect(description).toMatch(/totalAllMessages/);
      expect(description).toMatch(/refused by name \(userId, sessionId and llmModel are ignored by the server\)/);
    }
  });

  it('get_lead_details does not claim the pipeline status or the deal value (its projection has neither) and sends the agent to manage_leads get for them', () => {
    const description = (mcpToolRegistry.getTool('get_lead_details') as any).definition.description as string;
    expect(description).toMatch(/does NOT return the pipeline status or the deal value: read those with manage_leads get/);
    expect(description).not.toMatch(/superset|stored fields only|status, deal value/);
  });

  it('get_lead_engagements says it has no stale-list recovery, and where the whole-history signal is', () => {
    const description = (mcpToolRegistry.getTool('get_lead_engagements') as any).definition.description as string;
    expect(description).toMatch(/Showing the first N of M/);
    expect(description).toMatch(/get_lead_details finds a lead in another of your lists/);
  });
});
