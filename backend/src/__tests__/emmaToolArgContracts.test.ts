const mockListContacts = jest.fn().mockResolvedValue({contacts:[],nextCursor:'next'});
const mockGetContactList = jest.fn().mockResolvedValue({listId:'17'});
jest.mock('../services/hubspotService', () => ({ HubSpotService: {
  create: jest.fn(async () => ({ listContacts: mockListContacts, getContactList: mockGetContactList })),
} }));
import { handleHubspotApi } from '../emma/impl/adsCrmApis';
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';
import { normalizeHubSpotArgs } from '../services/agentMode/crmToolArgs';
import { handleAttioApi } from '../services/agentMode/attioTools';
import { buildAutonomousReportWorkPlan } from '../scripts/seed-eng1880-autonomous-report-workplan';

const schema = { type: 'object', additionalProperties: false, properties: {
  entity_type: { type: 'string' }, action: { type: 'string' }, list_id: { type: 'string' },
  guid: { type: 'string' }, query: { type: 'string' }, count: { type: 'number' },
  object_type: { type: 'string' },
}, required: ['entity_type', 'action'] };
const run = (args: any, toolName = 'call_hubspot_api', inputSchema: any = schema) =>
  validateAndRepairToolArgs({ toolName, args, inputSchema, effect: 'read' });

describe('call_hubspot_api observed shapes (ENG-2792)', () => {
  const enumSchema = { ...schema, properties: { ...schema.properties, entity_type: { type: 'string',
    enum: ['CAMPAIGN', 'EMAIL', 'FORM', 'LANDING_PAGE', 'BLOG_POST', 'WORKFLOW', 'SOCIAL', 'CONTACT_LIST', 'CONTACTS'] } } };
  it.each([
    [{action:'get',entity_type:'contacts'}, {entity_type:'CONTACTS',action:'LIST'}],
    [{endpoint:'campaigns',action:'LIST'}, {entity_type:'CAMPAIGN',action:'LIST'}],
    [{method:'GET',endpoint:'/crm/v3/objects/contacts?limit=5'}, {entity_type:'CONTACTS',action:'LIST'}],
  ])('repairs %p', (raw, expected) => {
    const result = run(raw, 'call_hubspot_api', enumSchema);
    expect(result.status).not.toBe('invalid');
    expect(result.args).toEqual(expected);
  });
  it('leaves unknown endpoints and non-GET raw calls for the actionable error', () => {
    expect(run({endpoint:'/crm/v3/objects/deals'}, 'call_hubspot_api', enumSchema).status).toBe('invalid');
    expect(run({method:'POST',endpoint:'/crm/v3/objects/contacts'}, 'call_hubspot_api', enumSchema).status).toBe('invalid');
    expect(run({}, 'call_hubspot_api', enumSchema).status).toBe('invalid');
  });
  it('declared schema lists every entity the handler dispatches', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../emma/tools.ts'), 'utf8');
    const line = src.split('\n').find((l: string) => l.includes("'CONTACT_LIST'") && l.includes('entity_type:'));
    expect(line).toContain("'CONTACTS'");
  });
});

describe('production Emma argument contracts', () => {
  it('dispatches LIST_CONTACTS through the existing paginated contacts API', async () => {
    expect(await handleHubspotApi('user',{action:'LIST_CONTACTS',cursor:'prev'}))
      .toEqual({success:true,contacts:[],nextCursor:'next'});
    expect(mockListContacts).toHaveBeenCalledWith('prev');
  });
  it('normalizes direct HubSpot list calls too', async () => {
    expect(await handleHubspotApi('user',{entity_type:'CONTACT_LIST',action:'LIST',query:{listId:17,count:25}}))
      .toMatchObject({success:true,listId:'17'});
    expect(mockGetContactList).toHaveBeenCalledWith('17');
  });
  it.each([{query:{listId:'17'}}, {query:'listId=17'}, {query:'list_id=17'},
    {query:17}, {guid:17}, {list_id:'17'}, {listId:17}, {id:'17'}, {query:'guid=17'},
    {query:{listId:17,count:25}}])('repairs HubSpot list lookup %p before validation', alias => {
    const raw = {entity_type:'CONTACT_LIST',action:'GET',...alias};
    const result = run(raw);
    expect(result.status).not.toBe('rejected');
    expect(result.args).toMatchObject({list_id:'17',action:'GET'});
    expect(result.args).toEqual(normalizeHubSpotArgs(raw));
  });
  it('preserves explicit list ids, free text, and caller objects', () => {
    const raw = {entity_type:'CONTACT_LIST',action:'GET',list_id:'5',query:'guid=17'};
    expect(normalizeHubSpotArgs(raw)).toEqual(raw);
    const list = {entity_type:'CONTACT_LIST',action:'LIST',query:'newsletter 17'};
    expect(normalizeHubSpotArgs(list)).toEqual(list);
    const nested = {entity_type:'CONTACT_LIST',action:'GET',query:{listId:17,count:25}};
    normalizeHubSpotArgs(nested);
    expect(nested.query).toEqual({listId:17,count:25});
  });
  it('turns LIST with listId/count into GET without losing count', () => {
    expect(run({entity_type:'CONTACT_LIST',action:'LIST',query:{listId:'17',count:25}}).args)
      .toMatchObject({action:'GET',list_id:'17',count:25});
  });
  it.each(['GET', 'GET_METRICS'])('accepts campaign id for %s', action => {
    for (const alias of [{id:'campaign-uuid'}, {guid:'campaign-uuid'}]) {
      const result = run({entity_type:'CAMPAIGN', action,...alias});
      expect(result.status).not.toBe('rejected');
      expect(result.args).toMatchObject({guid:'campaign-uuid'});
    }
  });
  it('infers CONTACTS for LIST_CONTACTS', () => {
    expect(run({action:'LIST_CONTACTS'}).args).toEqual({entity_type:'CONTACTS',action:'LIST'});
  });
  it.each(['person','people','RECORDS'])('normalizes Attio %s list', entity_type => {
    const result = run({entity_type,action:'list'}, 'call_attio_api');
    expect(result.status).not.toBe('rejected');
    expect(result.args).toMatchObject({entity_type:'RECORDS',action:'LIST'});
  });
  it('infers Attio record search before required checks', () => {
    const result = run({action:'search_records',params:{query:'Joy Goel'}},'call_attio_api');
    expect(result.status).not.toBe('rejected');
    expect(result.args).toEqual({entity_type:'RECORDS',action:'SEARCH',query:'Joy Goel'});
  });
  it('accepts case-insensitive list-entry listing', () => {
    expect(run({entity_type:'list_entries',action:'list',list_id:'list-uuid'},'call_attio_api').args)
      .toMatchObject({entity_type:'LIST_ENTRIES',action:'LIST'});
  });
  it('returns actionable unsupported workspace error without connecting', async () => {
    const result = run({action:'get_workspace'},'call_attio_api');
    expect(result.status).not.toBe('rejected');
    expect(await handleAttioApi('user',result.args)).toMatchObject({success:false,error:expect.stringContaining('Valid: RECORDS')});
  });
  it.each(['client_id','client_email'])('accepts monitor alias %s', alias => {
    const result = run({[alias]:'juan@usehaven.ai'},'monitor_lead_volume', {
      type:'object',additionalProperties:false,properties:{client_name_or_email:{type:'string'}},required:['client_name_or_email'],
    });
    expect(result.status).not.toBe('rejected');
    expect(result.args).toEqual({client_name_or_email:'juan@usehaven.ai'});
  });
  it('defaults the private plan owner to the Phase B schedule owner', () => {
    const previous = process.env.SEED_OWNER_USER_ID;
    delete process.env.SEED_OWNER_USER_ID;
    try { expect(buildAutonomousReportWorkPlan()).toMatchObject({ownerId:'1743956381327',visibility:'private'}); }
    finally { if (previous !== undefined) process.env.SEED_OWNER_USER_ID = previous; }
  });
});
