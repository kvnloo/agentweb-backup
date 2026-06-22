import {
  resolveSyncStatus,
  getHubspotConnection,
  getMappedAgentwebFields,
  mappedFieldChanged,
  buildSyncedMetadata,
  buildFailedMetadata,
} from '../utils/leadSyncStatus';

describe('getHubspotConnection', () => {
  it('returns connected=false when no hubspot config on list', () => {
    expect(getHubspotConnection({}).connected).toBe(false);
    expect(getHubspotConnection({ externalCrmSyncConfigs: {} }).connected).toBe(false);
  });

  it('returns connected=true with an OAuth accountId', () => {
    const list = { externalCrmSyncConfigs: { hubspot: { accountId: 'acc1', autoSyncEnabled: true } } };
    const c = getHubspotConnection(list);
    expect(c.connected).toBe(true);
    expect(c.autoSyncEnabled).toBe(true);
    expect(c.config).toBeTruthy();
  });

  it('returns connected=true with a manual apiKeyEncrypted', () => {
    const list = { externalCrmSyncConfigs: { hubspot: { apiKeyEncrypted: 'enc' } } };
    expect(getHubspotConnection(list).connected).toBe(true);
    expect(getHubspotConnection(list).autoSyncEnabled).toBe(false);
  });
});

describe('resolveSyncStatus', () => {
  it('returns null when not connected', () => {
    expect(resolveSyncStatus({ syncMetadata: { syncStatus: 'synced' } }, false)).toBeNull();
  });

  it('returns the persisted status when present', () => {
    expect(resolveSyncStatus({ syncMetadata: { syncStatus: 'update_pending' } }, true)).toBe('update_pending');
    expect(resolveSyncStatus({ syncMetadata: { syncStatus: 'sync_failed' } }, true)).toBe('sync_failed');
  });

  it('derives synced for a legacy lead with a hubspot_contact_id and no status', () => {
    expect(resolveSyncStatus({ syncMetadata: { hubspot_contact_id: '123' } }, true)).toBe('synced');
  });

  it('derives sync_pending for a connected lead never pushed', () => {
    expect(resolveSyncStatus({ syncMetadata: {} }, true)).toBe('sync_pending');
    expect(resolveSyncStatus({}, true)).toBe('sync_pending');
  });
});

describe('getMappedAgentwebFields', () => {
  it('collects enabled push/both agentwebFields across contact, deal, custom mappings', () => {
    const config = {
      contactFieldMapping: [
        { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
        { agentwebField: 'phone', crmProperty: 'phone', direction: 'pull', enabled: true }, // pull-only excluded
        { agentwebField: 'title', crmProperty: 'jobtitle', direction: 'push', enabled: false }, // disabled excluded
      ],
      dealFieldMapping: [
        { agentwebField: 'dealValue', crmProperty: 'amount', direction: 'both', enabled: true },
      ],
      customFieldMapping: [
        { agentwebField: 'notes', crmProperty: 'notes', direction: 'both', enabled: true },
      ],
    };
    const fields = getMappedAgentwebFields(config);
    expect(fields.has('email')).toBe(true);
    expect(fields.has('dealValue')).toBe(true);
    expect(fields.has('notes')).toBe(true);
    expect(fields.has('phone')).toBe(false);
    expect(fields.has('title')).toBe(false);
  });

  it('falls back to a default field set when config has no enabled mappings', () => {
    const fields = getMappedAgentwebFields({ contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [] });
    expect(fields.has('email')).toBe(true);
    expect(fields.has('firstName')).toBe(true);
  });
});

describe('mappedFieldChanged', () => {
  const mapped = new Set(['email', 'company', 'notes']);

  it('true when a mapped standard field value changes', () => {
    expect(mappedFieldChanged({ company: 'Acme' }, { company: 'Beta' }, mapped)).toBe(true);
  });

  it('false when only an unmapped field changes', () => {
    expect(mappedFieldChanged({ priority: 'Low' }, { priority: 'High' }, mapped)).toBe(false);
  });

  it('false when a mapped field is present but unchanged', () => {
    expect(mappedFieldChanged({ company: 'Acme' }, { company: 'Acme' }, mapped)).toBe(false);
  });

  it('treats null/undefined/empty-string as equal (no spurious change)', () => {
    expect(mappedFieldChanged({ company: '' }, { company: null }, mapped)).toBe(false);
    expect(mappedFieldChanged({}, { company: undefined }, mapped)).toBe(false);
  });

  it('true when a mapped custom field value changes', () => {
    expect(mappedFieldChanged(
      { customFields: { notes: 'old' } },
      { customFields: { notes: 'new' } },
      mapped,
    )).toBe(true);
  });
});

describe('buildSyncedMetadata / buildFailedMetadata', () => {
  it('buildSyncedMetadata sets contact id + synced + lastSyncedAt and clears syncError', () => {
    const out = buildSyncedMetadata(
      { hubspot_deal_id: 'd1', syncError: 'old error' }, 'c1', '2026-06-22T00:00:00.000Z',
    );
    expect(out).toEqual({
      hubspot_deal_id: 'd1',
      hubspot_contact_id: 'c1',
      syncStatus: 'synced',
      lastSyncedAt: '2026-06-22T00:00:00.000Z',
    });
    expect('syncError' in out).toBe(false);
  });

  it('buildFailedMetadata sets sync_failed + error and preserves existing ids', () => {
    const out = buildFailedMetadata({ hubspot_contact_id: 'c1' }, 'boom');
    expect(out).toEqual({ hubspot_contact_id: 'c1', syncStatus: 'sync_failed', syncError: 'boom' });
  });

  it('builders tolerate undefined existing metadata', () => {
    expect(buildSyncedMetadata(undefined, 'c1', 'now').hubspot_contact_id).toBe('c1');
    expect(buildFailedMetadata(undefined, 'e').syncStatus).toBe('sync_failed');
  });
});
