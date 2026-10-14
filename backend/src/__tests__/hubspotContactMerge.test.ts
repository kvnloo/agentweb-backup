/**
 * ENG-2465: a HubSpot `contact.merge` webhook leaves a lead's stored hubspot_contact_id
 * pointing at the merged-away contact. Since ENG-2171 the push updates by that id, so a
 * dead id would fail every push. The id is re-pointed at the survivor.
 */
jest.mock('../services/db', () => ({
  crmDb: { getLeadByHubSpotContactId: jest.fn(), updateLead: jest.fn() },
}));

import { crmDb } from '../services/db';
import { parseHubSpotMergeEvent, repointMergedContactIds } from '../services/hubspotContactMerge';

const find = crmDb.getLeadByHubSpotContactId as jest.Mock;
const update = crmDb.updateLead as jest.Mock;

describe('parseHubSpotMergeEvent', () => {
  const base = { subscriptionType: 'contact.merge', portalId: 1, primaryObjectId: 200, mergedObjectIds: [101, 102], newObjectId: 200, numberOfPropertiesMoved: 3 };

  it('reads survivor and merged ids, normalising numbers to strings', () => {
    expect(parseHubSpotMergeEvent(base)).toEqual({ survivorId: '200', mergedIds: ['101', '102'] });
  });
  it('prefers newObjectId over primaryObjectId (the record that exists after the merge)', () => {
    expect(parseHubSpotMergeEvent({ ...base, primaryObjectId: 200, newObjectId: 300 })?.survivorId).toBe('300');
  });
  it('falls back to primaryObjectId when newObjectId is absent', () => {
    expect(parseHubSpotMergeEvent({ ...base, newObjectId: undefined })?.survivorId).toBe('200');
  });
  it('drops the survivor and duplicates from the merged ids', () => {
    expect(parseHubSpotMergeEvent({ ...base, mergedObjectIds: [200, 101, '101', ''] })?.mergedIds).toEqual(['101']);
  });
  it.each([
    ['another event type', { ...base, subscriptionType: 'contact.deletion' }],
    ['no survivor', { ...base, primaryObjectId: undefined, newObjectId: undefined }],
    ['no merged ids', { ...base, mergedObjectIds: [] }],
    ['merged ids not an array', { ...base, mergedObjectIds: '101' }],
    ['only the survivor listed', { ...base, mergedObjectIds: [200] }],
    ['a null event', null],
  ])('returns null for %s', (_n, ev) => {
    expect(parseHubSpotMergeEvent(ev as any)).toBeNull();
  });
});

describe('repointMergedContactIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    update.mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rewrites the stored id to the survivor and keeps every other syncMetadata field', async () => {
    find.mockImplementation(async (_l: string, id: string) =>
      id === '101' ? { leadId: 'l1', syncMetadata: { hubspot_contact_id: '101', hubspot_deal_id: 'D1', syncStatus: 'synced' } } : null);

    const r = await repointMergedContactIds('list_1', { survivorId: '200', mergedIds: ['101', '102'] });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('list_1', 'l1', {
      syncMetadata: { hubspot_contact_id: '200', hubspot_deal_id: 'D1', syncStatus: 'synced' },
    });
    expect(r).toEqual({ rewritten: 1, lookupFailed: 0 });
  });

  it('writes nothing when no lead holds the merged id (also what makes a redelivery a no-op)', async () => {
    find.mockResolvedValue(null);
    const r = await repointMergedContactIds('list_1', { survivorId: '200', mergedIds: ['101'] });
    expect(update).not.toHaveBeenCalled();
    expect(r).toEqual({ rewritten: 0, lookupFailed: 0 });
  });

  it('a lookup that throws (page cap, throttle) does not stop the remaining ids and never throws', async () => {
    find.mockImplementation(async (_l: string, id: string) => {
      if (id === '101') throw Object.assign(new Error('exhausted 20 pages'), { lookupExhausted: true });
      return { leadId: 'l2', syncMetadata: { hubspot_contact_id: '102' } };
    });

    const r = await repointMergedContactIds('list_1', { survivorId: '200', mergedIds: ['101', '102'] });

    expect(update).toHaveBeenCalledWith('list_1', 'l2', { syncMetadata: { hubspot_contact_id: '200' } });
    expect(r).toEqual({ rewritten: 1, lookupFailed: 1 });
  });

  it('a failed write is counted, does not throw, and does not stop the next id', async () => {
    find.mockImplementation(async (_l: string, id: string) => ({ leadId: `lead-${id}`, syncMetadata: { hubspot_contact_id: id } }));
    update.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded')).mockResolvedValue(undefined);

    const r = await repointMergedContactIds('list_1', { survivorId: '200', mergedIds: ['101', '102'] });

    expect(update).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ rewritten: 1, lookupFailed: 1 });
  });

  it('tolerates a lead with no syncMetadata object', async () => {
    find.mockResolvedValue({ leadId: 'l3' });
    await repointMergedContactIds('list_1', { survivorId: '200', mergedIds: ['101'] });
    expect(update).toHaveBeenCalledWith('list_1', 'l3', { syncMetadata: { hubspot_contact_id: '200' } });
  });
});
