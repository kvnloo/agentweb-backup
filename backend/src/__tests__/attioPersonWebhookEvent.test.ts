/**
 * Unit tests for applyAttioPersonEvent() — the shared record.* (People)
 * webhook event handler used by both crmWebhook.ts's per-list endpoint and
 * webhooks.ts's shared OAuth endpoint (ENG-1380).
 *
 * Covers the echo-suppression fix specifically: AgentWeb's own OAuth-app
 * writes carry actor.type: 'app' with actor.id equal to our own Attio
 * app's client_id (live-verified against a real connected workspace,
 * NOT actor.type: 'api-token' as the original, never-matching check
 * assumed) — so only an 'app'-typed actor matching OUR OWN client_id is
 * suppressed; any other 'app' actor (a different third-party integration
 * writing into the same workspace) must still be processed.
 */

const mockGetLeadByEmail = jest.fn();
const mockGetLeadByAttioRecordId = jest.fn();
const mockCreateLead = jest.fn();
const mockUpdateLead = jest.fn();
const mockDeleteLead = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadByEmail: (...a: any[]) => mockGetLeadByEmail(...a),
    getLeadByAttioRecordId: (...a: any[]) => mockGetLeadByAttioRecordId(...a),
    createLead: (...a: any[]) => mockCreateLead(...a),
    updateLead: (...a: any[]) => mockUpdateLead(...a),
    deleteLead: (...a: any[]) => mockDeleteLead(...a),
  },
}));

const mockGetAttioConfig = jest.fn();
jest.mock('../config/integrations', () => ({
  getAttioConfig: (...a: any[]) => mockGetAttioConfig(...a),
}));

import { applyAttioPersonEvent } from '../utils/attioPersonWebhookEvent';

const OUR_CLIENT_ID = 'our-app-client-id';

// Mirrors DEFAULT_ATTIO_CONTACT_MAPPING (externalCrmSyncService.ts) — real
// default mapping, including linkedin's push-only direction (the exact gap
// this file's tests below prove is now respected by the webhook path too).
const DEFAULT_CONTACT_MAPPING = [
  { agentwebField: 'email', crmProperty: 'email_addresses', direction: 'both', enabled: true },
  { agentwebField: 'firstName', crmProperty: 'first_name', direction: 'both', enabled: true },
  { agentwebField: 'lastName', crmProperty: 'last_name', direction: 'both', enabled: true },
  { agentwebField: 'phone', crmProperty: 'phone_numbers', direction: 'both', enabled: true },
  { agentwebField: 'title', crmProperty: 'job_title', direction: 'both', enabled: true },
  { agentwebField: 'company', crmProperty: 'company', direction: 'both', enabled: true },
  { agentwebField: 'linkedin', crmProperty: 'linkedin', direction: 'push', enabled: true },
];

const baseConfig: any = {
  deleteOnPull: true,
  contactFieldMapping: DEFAULT_CONTACT_MAPPING,
  customFieldMapping: [],
};

const makeSvc = (
  personValues: Record<string, any>,
  objectSlugsById: Record<string, string> = {},
  opts: { attrTypes?: Record<string, string>; companies?: Record<string, any> } = {},
) => ({
  getPersonValues: jest.fn().mockResolvedValue(personValues),
  getObjectSlug: jest.fn((id: string) => Promise.resolve(objectSlugsById[id] ?? null)),
  loadAttributeTypes: jest.fn().mockResolvedValue(new Map(
    Object.entries(opts.attrTypes ?? { email_addresses: 'email_address', phone_numbers: 'phone_number' })
      .map(([slug, type]) => [`object:people:${slug}`, type])
  )),
  getCompanyById: jest.fn((id: string) => Promise.resolve(opts.companies?.[id] ?? null)),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAttioConfig.mockResolvedValue({ clientId: OUR_CLIENT_ID });
});

describe('applyAttioPersonEvent', () => {
  it('ignores an event with an irrelevant event_type', async () => {
    const svc = makeSvc({});
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.merged',
      id: { record_id: 'rec-1' },
    });
    expect(svc.getPersonValues).not.toHaveBeenCalled();
  });

  it('ignores Company object events when a slug is directly present on the payload', async () => {
    const svc = makeSvc({});
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1' },
      data: { object: { slug: 'companies' } },
    });
    expect(svc.getPersonValues).not.toHaveBeenCalled();
    expect(svc.getObjectSlug).not.toHaveBeenCalled(); // direct slug short-circuits the lookup
  });

  // Live-caught bug (ENG-1380): real Attio deliveries never carry object.slug
  // directly — only id.object_id, a UUID — so the filter must resolve it via
  // AttioService.getObjectSlug before it can do anything at all.
  it('resolves object_id to a slug via AttioService.getObjectSlug and ignores Company events (real payload shape)', async () => {
    const svc = makeSvc({}, { 'company-object-uuid': 'companies' });
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1', object_id: 'company-object-uuid' },
    });
    expect(svc.getObjectSlug).toHaveBeenCalledWith('company-object-uuid');
    expect(svc.getPersonValues).not.toHaveBeenCalled();
  });

  it('processes a People event resolved via object_id (real payload shape)', async () => {
    const svc = makeSvc(
      { email_addresses: [{ email_address: 'a@b.com' }] },
      { 'people-object-uuid': 'people' },
    );
    mockGetLeadByEmail.mockResolvedValue(null);
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1', object_id: 'people-object-uuid' },
    });
    expect(svc.getObjectSlug).toHaveBeenCalledWith('people-object-uuid');
    expect(mockCreateLead).toHaveBeenCalled();
  });

  it('does not fail when getObjectSlug resolution fails — proceeds unfiltered rather than dropping the event', async () => {
    const svc = makeSvc({ email_addresses: [{ email_address: 'a@b.com' }] });
    svc.getObjectSlug = jest.fn().mockRejectedValue(new Error('network error'));
    mockGetLeadByEmail.mockResolvedValue(null);
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1', object_id: 'some-uuid' },
    });
    expect(mockCreateLead).toHaveBeenCalled();
  });

  it('skips a self-authored event (actor.type=app, actor.id === our own client_id)', async () => {
    const svc = makeSvc({});
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1' },
      actor: { type: 'app', id: OUR_CLIENT_ID },
    });
    expect(svc.getPersonValues).not.toHaveBeenCalled();
  });

  it('does NOT skip an app-authored event from a different app (not our own client_id)', async () => {
    const svc = makeSvc({ email_addresses: [{ email_address: 'a@b.com' }] });
    mockGetLeadByEmail.mockResolvedValue(null);
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1' },
      actor: { type: 'app', id: 'some-other-apps-client-id' },
    });
    expect(svc.getPersonValues).toHaveBeenCalled();
    expect(mockCreateLead).toHaveBeenCalled();
  });

  it('does NOT skip an api-token-authored event (the original, never-matching assumption)', async () => {
    const svc = makeSvc({ email_addresses: [{ email_address: 'a@b.com' }] });
    mockGetLeadByEmail.mockResolvedValue(null);
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1' },
      actor: { type: 'api-token' },
    });
    expect(svc.getPersonValues).toHaveBeenCalled();
    expect(mockCreateLead).toHaveBeenCalled();
  });

  it('creates a new lead when no matching lead exists', async () => {
    const svc = makeSvc({
      email_addresses: [{ email_address: 'new@example.com' }],
      name: [{ first_name: 'Ada', last_name: 'Lovelace' }],
      phone_numbers: [{ original_phone_number: '+15551234567' }],
      job_title: [{ value: 'Engineer' }],
    });
    mockGetLeadByEmail.mockResolvedValue(null);

    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.created',
      id: { record_id: 'rec-1' },
    });

    expect(mockCreateLead).toHaveBeenCalledWith('list-1', expect.objectContaining({
      email: 'new@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+15551234567',
      title: 'Engineer',
      syncMetadata: { attio_record_id: 'rec-1' },
    }));
  });

  // Live-caught gap (ENG-1380): the webhook handler used to hardcode a
  // firstName/lastName/phone/title/linkedin-only field list and ignore the
  // list's actual field mapping — company and every custom field were
  // silently never synced by auto-pull, only by a manual Pull. These tests
  // prove the fix: webhook auto-pull now covers the same fields, respecting
  // the same enabled/direction config, as pullContacts's manual pull.
  it('syncs company via the associated Attio company record (webhook parity with manual pull)', async () => {
    const svc = makeSvc(
      {
        email_addresses: [{ email_address: 'new@example.com' }],
        company: [{ target_record_id: 'comp-1' }],
      },
      {},
      { companies: { 'comp-1': { name: 'Acme Corp' } } },
    );
    mockGetLeadByEmail.mockResolvedValue(null);

    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.created',
      id: { record_id: 'rec-1' },
    });

    expect(svc.getCompanyById).toHaveBeenCalledWith('comp-1');
    expect(mockCreateLead).toHaveBeenCalledWith('list-1', expect.objectContaining({
      email: 'new@example.com',
      company: 'Acme Corp',
    }));
  });

  it('does NOT sync linkedin via webhook — the default mapping marks it push-only, same as manual pull respects', async () => {
    const svc = makeSvc({
      email_addresses: [{ email_address: 'new@example.com' }],
      linkedin: [{ value: 'https://linkedin.com/in/test' }],
    });
    mockGetLeadByEmail.mockResolvedValue(null);

    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.created',
      id: { record_id: 'rec-1' },
    });

    const createdLead = mockCreateLead.mock.calls[0][1];
    expect(createdLead.linkedin).toBeUndefined();
  });

  it('respects a disabled contact field mapping — skips a field even though Attio has a value', async () => {
    const config = {
      ...baseConfig,
      contactFieldMapping: DEFAULT_CONTACT_MAPPING.map(m => m.agentwebField === 'title' ? { ...m, enabled: false } : m),
    };
    const svc = makeSvc({
      email_addresses: [{ email_address: 'new@example.com' }],
      job_title: [{ value: 'Engineer' }],
    });
    mockGetLeadByEmail.mockResolvedValue(null);

    await applyAttioPersonEvent('list-1', config, svc as any, {
      event_type: 'record.created',
      id: { record_id: 'rec-1' },
    });

    const createdLead = mockCreateLead.mock.calls[0][1];
    expect(createdLead.title).toBeUndefined();
  });

  // Live-caught gap: a contactFieldMapping targeting a non-native agentwebField
  // used to write straight to leadData[agentwebField], which
  // crmDb.createLead/updateLead silently drop (fixed whitelist of top-level
  // lead columns). Mirrors attioAdapter.ts pullContacts's identical fix.
  it('routes a non-native contactFieldMapping agentwebField to customFields via webhook auto-pull', async () => {
    const config = {
      ...baseConfig,
      contactFieldMapping: [
        ...DEFAULT_CONTACT_MAPPING,
        { agentwebField: 'jobLevel', crmProperty: 'job_level', direction: 'both', enabled: true },
      ],
    };
    const svc = makeSvc(
      {
        email_addresses: [{ email_address: 'new@example.com' }],
        job_level: [{ value: 'Senior' }],
      },
    );
    mockGetLeadByEmail.mockResolvedValue(null);

    await applyAttioPersonEvent('list-1', config, svc as any, {
      event_type: 'record.created',
      id: { record_id: 'rec-1' },
    });

    const createdLead = mockCreateLead.mock.calls[0][1];
    expect(createdLead.jobLevel).toBeUndefined();
    expect(createdLead.customFields.jobLevel).toBe('Senior');
  });

  it('syncs enabled custom fields on create', async () => {
    const config = {
      ...baseConfig,
      customFieldMapping: [{ agentwebField: 'favoriteColor', crmProperty: 'favorite_color', direction: 'both', enabled: true }],
    };
    const svc = makeSvc(
      {
        email_addresses: [{ email_address: 'new@example.com' }],
        favorite_color: [{ value: 'blue' }],
      },
    );

    mockGetLeadByEmail.mockResolvedValue(null);

    await applyAttioPersonEvent('list-1', config, svc as any, {
      event_type: 'record.created',
      id: { record_id: 'rec-1' },
    });

    expect(mockCreateLead).toHaveBeenCalledWith('list-1', expect.objectContaining({
      customFields: { favoriteColor: 'blue' },
    }));
  });

  it('merges enabled custom fields into an existing lead\'s customFields on update, rather than overwriting them', async () => {
    const config = {
      ...baseConfig,
      customFieldMapping: [{ agentwebField: 'favoriteColor', crmProperty: 'favorite_color', direction: 'both', enabled: true }],
    };
    const svc = makeSvc({
      email_addresses: [{ email_address: 'existing@example.com' }],
      favorite_color: [{ value: 'green' }],
    });
    mockGetLeadByEmail.mockResolvedValue({ leadId: 'lead-1', customFields: { otherField: 'kept' } });

    await applyAttioPersonEvent('list-1', config, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1' },
    });

    expect(mockUpdateLead).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({
      customFields: { otherField: 'kept', favoriteColor: 'green' },
    }));
  });

  it('skips creation when the record has no email', async () => {
    const svc = makeSvc({ name: [{ first_name: 'No', last_name: 'Email' }] });
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.created',
      id: { record_id: 'rec-1' },
    });
    expect(mockCreateLead).not.toHaveBeenCalled();
  });

  it('updates an existing lead matched by email', async () => {
    const svc = makeSvc({
      email_addresses: [{ email_address: 'existing@example.com' }],
      name: [{ first_name: 'Updated', last_name: 'Name' }],
    });
    mockGetLeadByEmail.mockResolvedValue({ leadId: 'lead-1' });

    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1' },
    });

    expect(mockUpdateLead).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({
      firstName: 'Updated',
      lastName: 'Name',
    }));
  });

  it('ignores deletion when deleteOnPull is disabled', async () => {
    const svc = makeSvc({});
    await applyAttioPersonEvent('list-1', { ...baseConfig, deleteOnPull: false }, svc as any, {
      event_type: 'record.deleted',
      id: { record_id: 'rec-1' },
    });
    expect(svc.getPersonValues).not.toHaveBeenCalled();
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it('deletes the matching lead on record.deleted when deleteOnPull is enabled', async () => {
    const svc = makeSvc({});
    mockGetLeadByAttioRecordId.mockResolvedValue({ leadId: 'lead-2' });

    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.deleted',
      id: { record_id: 'rec-1' },
    });

    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'lead-2');
  });

  it('record.deleted no-ops (does not throw) when no lead matches the deleted record', async () => {
    const svc = makeSvc({});
    mockGetLeadByAttioRecordId.mockResolvedValue(null);

    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.deleted',
      id: { record_id: 'rec-1' },
    });

    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  // Live-caught bug (ENG-1380): a deleted record can no longer be fetched
  // from Attio (getPersonValues 404s), so the lead must be found by its
  // already-stamped attio_record_id, never by re-fetching the record's
  // current values. Confirms the fix doesn't depend on svc.getPersonValues
  // succeeding — it must not even be called for a deletion.
  it('never calls svc.getPersonValues for a deletion — the deleted record is unfetchable', async () => {
    const svc = makeSvc({});
    mockGetLeadByAttioRecordId.mockResolvedValue({ leadId: 'lead-2' });

    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.deleted',
      id: { record_id: 'rec-1' },
    });

    expect(svc.getPersonValues).not.toHaveBeenCalled();
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'lead-2');
  });
});
