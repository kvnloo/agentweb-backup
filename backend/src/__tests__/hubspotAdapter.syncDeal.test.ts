process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/hubspotService', () => ({
    HubSpotService: {
        create: jest.fn(),
        fromToken: jest.fn(),
    },
}));

jest.mock('../services/db', () => ({
    crmDb: {
        updateLead: jest.fn().mockResolvedValue(undefined),
    },
}));

import { HubspotAdapter } from '../services/adapters/hubspotAdapter';
import { HubSpotService } from '../services/hubspotService';
import { crmDb } from '../services/db';

const mockSvc = {
    ensureContactProperty: jest.fn().mockResolvedValue('prop'),
    ensureDealProperty: jest.fn().mockResolvedValue('prop'),
    upsertContact: jest.fn().mockResolvedValue({ contactId: 'contact-111', isNew: false }),
    createDeal: jest.fn().mockResolvedValue('deal-new'),
    updateDeal: jest.fn().mockResolvedValue(undefined),
    associateContactToDeal: jest.fn().mockResolvedValue(undefined),
    getContactDealAssociations: jest.fn().mockResolvedValue([]),
    init: jest.fn().mockResolvedValue(undefined),
};

(HubSpotService.fromToken as jest.Mock).mockResolvedValue(mockSvc);

const baseConfig: any = {
    provider: 'hubspot',
    listId: 'list-1',
    contactFieldMapping: [{ crmProperty: 'email', agentwebField: 'email', enabled: true, direction: 'push' }],
    dealFieldMapping: [{ crmProperty: 'dealname', agentwebField: 'name', enabled: true, direction: 'push' }],
    customFieldMapping: [],
    externalPipelineId: 'pipeline-1',
};

const baseAuth: any = { type: 'token', apiKey: 'test-key' };

const makeLead = (overrides: any = {}) => ({
    leadId: 'lead-1',
    listId: 'list-1',
    email: 'test@example.com',
    name: 'Test Lead',
    syncMetadata: {},
    customFields: {},
    ...overrides,
});

describe('HubspotAdapter syncDeal — contact association', () => {
    let adapter: HubspotAdapter;

    beforeEach(() => {
        jest.clearAllMocks();
        (HubSpotService.fromToken as jest.Mock).mockResolvedValue(mockSvc);
        adapter = new HubspotAdapter();
    });

    it('first sync: creates deal and associates contact', async () => {
        const lead = makeLead(); // no hubspot_deal_id
        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.createDeal).toHaveBeenCalledTimes(1);
        expect(mockSvc.associateContactToDeal).toHaveBeenCalledWith('contact-111', 'deal-new');
    });

    it('resync: updates deal and re-associates contact', async () => {
        const lead = makeLead({ syncMetadata: { hubspot_deal_id: 'deal-existing' } });
        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.updateDeal).toHaveBeenCalledWith('deal-existing', expect.any(Object));
        expect(mockSvc.associateContactToDeal).toHaveBeenCalledWith('contact-111', 'deal-existing');
        expect(mockSvc.createDeal).not.toHaveBeenCalled();
    });

    it('resync: re-associates even when contact ID changes (new upsert result)', async () => {
        mockSvc.upsertContact.mockResolvedValueOnce({ contactId: 'contact-new-222', isNew: true });
        const lead = makeLead({ syncMetadata: { hubspot_deal_id: 'deal-existing' } });
        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.updateDeal).toHaveBeenCalledWith('deal-existing', expect.any(Object));
        expect(mockSvc.associateContactToDeal).toHaveBeenCalledWith('contact-new-222', 'deal-existing');
    });

    it('resync fallback: if updateDeal fails, creates new deal and associates', async () => {
        mockSvc.updateDeal.mockRejectedValueOnce(new Error('deal not found'));
        const lead = makeLead({ syncMetadata: { hubspot_deal_id: 'deal-gone' } });
        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.createDeal).toHaveBeenCalledTimes(1);
        expect(mockSvc.associateContactToDeal).toHaveBeenCalledWith('contact-111', 'deal-new');
    });

    it('CRM recovery: no deal in DB but deal found via getContactDealAssociations — updates instead of creating duplicate', async () => {
        mockSvc.getContactDealAssociations.mockResolvedValueOnce(['deal-recovered']);
        const lead = makeLead(); // no hubspot_deal_id in DB
        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.getContactDealAssociations).toHaveBeenCalledWith('contact-111');
        expect(mockSvc.updateDeal).toHaveBeenCalledWith('deal-recovered', expect.any(Object));
        expect(mockSvc.createDeal).not.toHaveBeenCalled();
        expect(mockSvc.associateContactToDeal).toHaveBeenCalledWith('contact-111', 'deal-recovered');
    });

    it('first sync: if associateContactToDeal fails, error is recorded and deal_id not saved', async () => {
        mockSvc.associateContactToDeal.mockRejectedValueOnce(new Error('association failed'));
        const lead = makeLead();
        const result = await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(result.errorCount).toBe(1);
        expect(crmDb.updateLead).not.toHaveBeenCalledWith(
            expect.anything(), expect.anything(),
            expect.objectContaining({ syncMetadata: expect.objectContaining({ hubspot_deal_id: expect.anything() }) })
        );
    });
});
