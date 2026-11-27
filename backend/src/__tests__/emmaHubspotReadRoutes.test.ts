/**
 * ENG-2840 (W2-9): `POST /api/emma/hubspot-read` (routes/emmaHubspotReadRoutes.ts), the route behind the MCP tool `call_hubspot_api`.
 * Mounted here on a bare express Router with a fake authenticated user (the real /api/emma router adds auth and the token budget).
 *  - It refuses writes, raw-REST shapes, bad ids and unknown fields itself (400) and never calls Emma's handler for them.
 *  - It hands the handler ONLY the checked fields, as req.user.userId, with the MCP bound on DEALS GET_CONTACTS.
 *  - An evaluation sandbox whose denied classes cover the tool gets LinkedIn's fixed 403, and the handler is never called.
 *  - Its answer names the account that served the call; a refusal is a fixed text (Emma's raw err.message is never passed on); anything
 *    unexpected is a fixed 500.
 *  - Through the REAL handler (HubSpotService doubled): own vs org-shared account, the 100-contact bound that stops association paging
 *    early, and Emma's two-argument call unchanged.
 */
import express, { Router } from 'express';
import request from 'supertest';

const mockCreate = jest.fn();
jest.mock('../services/hubspotService', () => ({
  HubSpotService: { create: (...a: any[]) => mockCreate(...a), fromToken: jest.fn() },
}));
jest.mock('../services/evaluationPolicy', () => {
  const actual = jest.requireActual('../services/evaluationPolicy');
  return { ...actual, enforceEvaluationTool: jest.fn(async () => undefined) };
});
const mockHandle = jest.fn();
jest.mock('../emma/impl/adsCrmApis', () => {
  const actual = jest.requireActual('../emma/impl/adsCrmApis');
  return { ...actual, handleHubspotApi: (...a: any[]) => mockHandle(...a) };
});

import { registerHubspotReadRoutes, cleanHubspotText, describeServingAccount, refusalMessage } from '../routes/emmaHubspotReadRoutes';
import { EvaluationDenied, enforceEvaluationTool } from '../services/evaluationPolicy';

const mockEnforce = enforceEvaluationTool as jest.Mock;

const realAds = jest.requireActual('../emma/impl/adsCrmApis');

function appFor(userId: string | null) {
  const router = Router();
  router.use((req: any, _res, next) => {
    if (userId) req.user = { userId, email: 'qa-user@agentweb.pro', isAdmin: false };
    next();
  });
  registerHubspotReadRoutes(router);
  const app = express();
  app.use(express.json());
  app.use('/api/emma', router);
  return app;
}

const app = appFor('caller-1');
const post = (body: unknown) => request(app).post('/api/emma/hubspot-read').send(body as any);

beforeEach(() => {
  mockHandle.mockReset();
  mockCreate.mockReset();
  mockEnforce.mockReset();
  mockEnforce.mockImplementation(async () => undefined);
  mockHandle.mockImplementation((...a: any[]) => realAds.handleHubspotApi(...a));
});

describe('refused by the route itself (400), the handler never called', () => {
  it('every write action, lower case, and an unknown entity', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ entity_type: 'EMAIL', action: 'PUBLISH', email_id: '1' }, /EMAIL PUBLISH is not available here: this tool only reads/],
      [{ entity_type: 'SOCIAL', action: 'CREATE_BROADCAST' }, /SOCIAL CREATE_BROADCAST is not available here/],
      [{ entity_type: 'WORKFLOW', action: 'ENABLE', workflow_id: '1' }, /WORKFLOW ENABLE is not available here/],
      [{ entity_type: 'WORKFLOW', action: 'DELETE', workflow_id: '1' }, /WORKFLOW DELETE is not available here/],
      [{ entity_type: 'FORM', action: 'SUBMIT', form_id: 'f' }, /FORM SUBMIT is not available here/],
      [{ entity_type: 'CONTACT_LIST', action: 'ADD_CONTACTS', list_id: '1' }, /CONTACT_LIST ADD_CONTACTS is not available here/],
      [{ entity_type: 'CAMPAIGN', action: 'ADD_ASSET', guid: 'g' }, /CAMPAIGN ADD_ASSET is not available here/],
      [{ entity_type: 'LANDING_PAGE', action: 'UPDATE', page_id: '1' }, /LANDING_PAGE UPDATE is not available here/],
      [{ entity_type: 'contacts', action: 'list' }, /entity_type must be one of/],
      [{ entity_type: 'TICKETS', action: 'LIST' }, /entity_type must be one of/],
    ];
    for (const [body, re] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(re);
    }
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('raw-REST shapes, aliases, an identity in the body, and unknown fields', async () => {
    for (const body of [
      { endpoint: '/crm/v3/objects/contacts', method: 'GET' },
      { entity_type: 'CONTACTS', action: 'LIST', endpoint: '/crm/v3/objects/deals' },
      { entity_type: 'CAMPAIGN', action: 'GET', id: 'g1' },
      { entity_type: 'DEALS', action: 'GET_CONTACTS', id: '5' },
      { entity_type: 'CONTACTS', action: 'LIST', userId: 'victim-9' },
      { entity_type: 'CONTACTS', action: 'LIST', session_id: 's' },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not an input|are not inputs/);
    }
    for (const body of [null, [], 'CONTACTS']) {
      const res = await request(app).post('/api/emma/hubspot-read').set('Content-Type', 'application/json').send(JSON.stringify(body));
      expect(res.status).toBe(400);
    }
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('ids and cursors that could steer a HubSpot URL', async () => {
    const cases: Array<Record<string, unknown>> = [
      { entity_type: 'EMAIL', action: 'GET', email_id: '../../crm/v3/objects/contacts' },
      { entity_type: 'CAMPAIGN', action: 'GET_METRICS', guid: 'g?x=1' },
      { entity_type: 'CONTACT_LIST', action: 'GET', list_id: '12/../13' },
      { entity_type: 'WORKFLOW', action: 'GET', workflow_id: '%2e%2e' },
      { entity_type: 'FORM', action: 'GET', form_id: 'a b' },
      { entity_type: 'DEALS', action: 'GET_CONTACTS', deal_id: '1#x' },
      { entity_type: 'CONTACTS', action: 'LIST', cursor: '1&limit=100000' },
      { entity_type: 'CONTACTS', action: 'LIST', account_id: '../x' },
      { entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: '1', start: '1767225600000&x=1', end: 1769904000000, bucket: 'DAY' },
      { entity_type: 'CAMPAIGN', action: 'LIST_ASSETS', guid: 'g', asset_type: '../emails' },
    ];
    for (const body of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(typeof res.body.message).toBe('string');
    }
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('refuses an evaluation sandbox\'s denied tool class with LinkedIn\'s 403, nothing called', async () => {
    mockEnforce.mockRejectedValueOnce(new EvaluationDenied('Tool "call_hubspot_api" is not available in this sandbox workspace (third_party_writes).'));
    const res = await post({ entity_type: 'WORKFLOW', action: 'LIST' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'This tool is not available in this sandbox workspace' });
    expect(mockEnforce).toHaveBeenCalledWith('caller-1', 'call_hubspot_api');
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('401 without an authenticated user', async () => {
    const res = await request(appFor(null)).post('/api/emma/hubspot-read').send({ entity_type: 'WORKFLOW', action: 'LIST' });
    expect(res.status).toBe(401);
    expect(mockHandle).not.toHaveBeenCalled();
  });
});

describe('what the handler is given', () => {
  it('only the checked fields, as req.user.userId, with the GET_CONTACTS bound', async () => {
    mockHandle.mockResolvedValue({ success: true, x: 1 });
    await post({ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: ['11', 12], start_timestamp: '2026-01-01', account_id: '4242' });
    const [uid, args, options] = mockHandle.mock.calls[0];
    expect(uid).toBe('caller-1');
    expect(args).toStrictEqual({ entity_type: 'EMAIL', action: 'GET_STATS', account_id: '4242', email_ids: ['11', '12'], start_timestamp: '1767225600000' });
    expect(options.maxDealContacts).toBe(100);
    expect(mockEnforce).toHaveBeenCalledWith('caller-1', 'call_hubspot_api');
    expect(typeof options.onResolved).toBe('function');

    await post({ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'Closed Won', created_after: 1767225600000 });
    expect(mockHandle.mock.calls[1][1]).toStrictEqual({ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'Closed Won', created_after: '1767225600000', limit: 25 });
  });

  it('answers the account that served it, the pair and the handler\'s result without success', async () => {
    mockHandle.mockImplementationOnce(async (_u: string, _a: any, options: any) => {
      options.onResolved({ accountId: 'hub-1', ownerUserId: 'caller-1' });
      return { success: true, results: [{ id: '1' }], paging: { next: { after: '2' } } };
    });
    const res = await post({ entity_type: 'FORM', action: 'LIST' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, account: { account_id: 'hub-1', source: 'own' }, entity_type: 'FORM', action: 'LIST', result: { results: [{ id: '1' }], paging: { next: { after: '2' } } } });
  });

  it('describeServingAccount: own, org_shared, lead_list_token', () => {
    expect(describeServingAccount({ accountId: '1', ownerUserId: 'me' }, 'me')).toEqual({ account_id: '1', source: 'own' });
    expect(describeServingAccount({ accountId: '1', ownerUserId: 'teammate' }, 'me')).toEqual({ account_id: '1', source: 'org_shared' });
    expect(describeServingAccount({ accountId: undefined, ownerUserId: undefined }, 'me')).toEqual({ account_id: null, source: 'lead_list_token' });
    expect(describeServingAccount(null, 'me')).toBeNull();
  });
});

describe('refusals and errors', () => {
  it('maps the handler\'s { success: false } to a fixed text, never HubSpot\'s raw body nor Emma\'s raw err.message', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ success: false, error: 'Request failed with status code 404', status: 404, hubspotError: { message: 'x' } }, /^HubSpot found nothing at that id \(HTTP 404\)/],
      [{ success: false, error: 'Request failed with status code 429', status: 429 }, /rate limit for this portal was reached \(HTTP 429\)/],
      [{ success: false, error: 'Request failed with status code 401', status: 401 }, /Reconnect HubSpot/],
      [{ success: false, error: 'Request failed with status code 502', status: 502, hubspotError: '<html>gateway</html>' }, /^HubSpot could not answer \(HTTP 502\)\. Try again later\.$/],
      [{ success: false, error: 'Your HubSpot connection is missing the required permissions. Please reconnect.', status: 403, hubspotError: { message: 'This oauth-token (abcdefghijklmnopqrstuvwxyz0123456789) does not have proper permissions!' } }, /^Your HubSpot connection is missing the required permissions/],
      [{ success: false, error: 'Request failed with status code 400', status: 400, hubspotError: { message: 'Invalid input JSON on line 1' } }, /^HubSpot refused the request \(HTTP 400\): Invalid input JSON on line 1$/],
      [{ success: false, error: 'HubSpot account not connected. Please connect your HubSpot account in Settings.', status: null }, /^No HubSpot account is connected\. Connect HubSpot in Settings/],
      [{ success: false, error: 'No HubSpot account connected. Please connect HubSpot in Settings.' }, /^No HubSpot account is connected\./],
      [{ success: false, error: `Multiple HubSpot accounts found: [Acme Secret Portal (ID: 1)\n, B (ID: 2)]. Specify account_id. token pat-na1-${'a'.repeat(36)}`, status: null }, /^Several HubSpot accounts are connected: pass account_id \(from list_connected_accounts\)\.$/],
      [{ success: false, error: 'HubSpot account "hub-9" not found. Please reconnect your account.', status: null }, /^That account_id is not one of your HubSpot accounts or one shared with your organization/],
      [{ success: false, error: 'Your HubSpot account needs to be reconnected. Go to Settings → Connected Accounts and reconnect HubSpot.', status: null }, /^The HubSpot sign-in needs to be renewed\. Reconnect HubSpot/],
      [{ success: false, error: 'timeout of 15000ms exceeded', status: null }, /^HubSpot did not answer in time\. Try again later\.$/],
      [{ success: false, error: 'No deal stage matches "Won ish". Use DEALS LIST_PIPELINES to see stage ids and labels.' }, /^No deal stage matches deal_stage\./],
      [{ success: false, error: "Cannot read properties of undefined (reading 'x') at /srv/app/dist/emma/impl/adsCrmApis.js:1700", status: null }, /^The HubSpot read failed\. Try again later\.$/],
      [{ success: false }, /^The HubSpot read failed\. Try again later\.$/],
    ];
    for (const [result, re] of cases) {
      mockHandle.mockResolvedValueOnce(result);
      const res = await post({ entity_type: 'WORKFLOW', action: 'LIST' });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(re);
      expect(res.body.message).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789|gateway|Acme|pat-na1|hub-9|Won ish|\/srv\/|Cannot read/);
    }
  });

  it('cleanHubspotText removes control characters and token-shaped runs, and cuts to 300 characters', () => {
    expect(cleanHubspotText(`a\u0000b\nc (${'x'.repeat(25)}) ${'y'.repeat(45)}`)).toBe('a b c (<redacted>) <redacted>');
    expect(cleanHubspotText('z'.repeat(20).concat(' ', 'w '.repeat(400))).length).toBeLessThanOrEqual(300);
    expect(cleanHubspotText(undefined)).toBe('');
    expect(refusalMessage({ status: 403 })).toMatch(/HubSpot denied access/);
  });

  it('a thrown error or a non-object answer is a fixed 500 that leaks nothing', async () => {
    mockHandle.mockRejectedValueOnce(new Error('ECONNREFUSED dynamodb.us-west-2 secret=abc'));
    let res = await post({ entity_type: 'WORKFLOW', action: 'LIST' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'The HubSpot read failed. Try again later.' });
    mockHandle.mockResolvedValueOnce(undefined);
    res = await post({ entity_type: 'WORKFLOW', action: 'LIST' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'The HubSpot read failed. Try again later.' });
  });
});

describe('through Emma\'s real handler (HubSpotService doubled)', () => {
  const contactIds = Array.from({ length: 250 }, (_, i) => String(i + 1));
  const svcFor = (ownerUserId: string, accountId = 'hub-1') => ({
    accountId,
    ownerUserId,
    portalId: accountId,
    getDealContactAssociations: jest.fn().mockResolvedValue(contactIds),
    batchReadContacts: jest.fn(async (ids: string[]) => ids.map((id) => ({ id, properties: { email: `c${id}@example.com` } }))),
  });

  it('DEALS GET_CONTACTS over MCP stops association paging past 100 ids, reads at most 100 contacts and says the list was cut; own account', async () => {
    const svc = svcFor('caller-1');
    mockCreate.mockResolvedValueOnce(svc);
    const res = await post({ entity_type: 'DEALS', action: 'GET_CONTACTS', deal_id: '777' });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith('caller-1', undefined, 'own');
    expect(svc.getDealContactAssociations.mock.calls).toStrictEqual([['777', { stopAfter: 100 }]]);
    expect(svc.batchReadContacts).toHaveBeenCalledTimes(1);
    expect(svc.batchReadContacts.mock.calls[0][0]).toHaveLength(100);
    expect(res.body.account).toEqual({ account_id: 'hub-1', source: 'own' });
    expect(res.body.result).toMatchObject({ deal_id: '777', contacts_cut: true });
    expect(res.body.result.contacts_total).toBeUndefined();
    expect(res.body.result.contacts).toHaveLength(100);
  });

  it('an account a teammate shared answers as org_shared (own lookup misses, then the shared one)', async () => {
    const svc = svcFor('teammate-9', 'hub-2');
    mockCreate.mockRejectedValueOnce(new Error('HubSpot account "hub-2" not found. Please reconnect your account.'));
    mockCreate.mockResolvedValueOnce(svc);
    const res = await post({ entity_type: 'DEALS', action: 'GET_CONTACTS', deal_id: '778', account_id: 'hub-2' });
    expect(mockCreate.mock.calls).toEqual([['caller-1', 'hub-2', 'own'], ['caller-1', 'hub-2', 'shared']]);
    expect(res.body.account).toEqual({ account_id: 'hub-2', source: 'org_shared' });
  });

  it('a deal with at most 100 contacts is not cut', async () => {
    const svc = svcFor('caller-1');
    svc.getDealContactAssociations.mockResolvedValueOnce(contactIds.slice(0, 100));
    mockCreate.mockResolvedValueOnce(svc);
    const res = await post({ entity_type: 'DEALS', action: 'GET_CONTACTS', deal_id: '780' });
    expect(res.body.result.contacts).toHaveLength(100);
    expect(res.body.result.contacts_cut).toBeUndefined();
  });

  it('Emma\'s own call (no options) is unchanged: association paging called with the deal id alone, every contact, no new fields', async () => {
    const svc = svcFor('caller-1');
    mockCreate.mockResolvedValueOnce(svc);
    const result = await realAds.handleHubspotApi('caller-1', { entity_type: 'DEALS', action: 'GET_CONTACTS', deal_id: '779' });
    expect(svc.getDealContactAssociations.mock.calls).toStrictEqual([['779']]);
    expect(svc.batchReadContacts.mock.calls[0][0]).toHaveLength(250);
    expect(result.contacts).toHaveLength(250);
    expect(Object.keys(result).sort()).toEqual(['contacts', 'deal_id', 'success']);
  });
});
