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

const baseConfig: any = { deleteOnPull: true };

const makeSvc = (personValues: Record<string, any>) => ({
  getPersonValues: jest.fn().mockResolvedValue(personValues),
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

  it('ignores Company object events (People only, matching HubSpot\'s own scope)', async () => {
    const svc = makeSvc({});
    await applyAttioPersonEvent('list-1', baseConfig, svc as any, {
      event_type: 'record.updated',
      id: { record_id: 'rec-1' },
      data: { object: { slug: 'companies' } },
    });
    expect(svc.getPersonValues).not.toHaveBeenCalled();
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
