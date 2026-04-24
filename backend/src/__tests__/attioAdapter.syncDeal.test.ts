process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/attioService', () => ({
    AttioService: {
        create: jest.fn(),
        fromToken: jest.fn(),
    },
}));

jest.mock('../services/db', () => ({
    crmDb: {
        updateLead: jest.fn().mockResolvedValue(undefined),
    },
}));

import { AttioAdapter } from '../services/adapters/attioAdapter';
import { AttioService } from '../services/attioService';
import { crmDb } from '../services/db';

const mockSvc = {
    loadAttributeTypes: jest.fn().mockResolvedValue(new Map()),
    getDealStages: jest.fn().mockResolvedValue([{ title: 'Open' }]),
    getFirstWorkspaceMemberEmail: jest.fn().mockResolvedValue('owner@example.com'),
    findCompanyByName: jest.fn().mockResolvedValue(null),
    ensurePersonAttribute: jest.fn().mockResolvedValue('custom_slug'),
    upsertPersonByValues: jest.fn().mockResolvedValue({ recordId: 'person-1', isNew: false }),
    createPersonByValues: jest.fn().mockResolvedValue('person-1'),
    findDealsByPersonId: jest.fn().mockResolvedValue([]),
    createDeal: jest.fn().mockResolvedValue('deal-new'),
    updateDeal: jest.fn().mockResolvedValue(undefined),
    ensureStatusOption: jest.fn().mockImplementation((_obj: string, _attr: string, val: string) => Promise.resolve(val)),
};

(AttioService.fromToken as jest.Mock).mockReturnValue(mockSvc);

const baseConfig: any = {
    provider: 'attio',
    listId: 'list-1',
    listName: 'Test List',
    contactFieldMapping: [{ crmProperty: 'email_addresses', agentwebField: 'email', enabled: true, direction: 'push' }],
    dealFieldMapping: [{ crmProperty: 'stage', agentwebField: 'status', enabled: true, direction: 'push' }],
    customFieldMapping: [],
};

const baseAuth: any = { type: 'token', apiKey: 'test-key' };

const makeLead = (overrides: any = {}) => ({
    leadId: 'lead-1',
    listId: 'list-1',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'Lead',
    syncMetadata: {},
    customFields: {},
    ...overrides,
});

describe('AttioAdapter syncDeal', () => {
    let adapter: AttioAdapter;

    beforeEach(() => {
        jest.clearAllMocks();
        (AttioService.fromToken as jest.Mock).mockReturnValue(mockSvc);
        adapter = new AttioAdapter();
    });

    it('first sync: creates deal and saves deal_id to DB', async () => {
        const lead = makeLead();
        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.findDealsByPersonId).toHaveBeenCalledWith('person-1');
        expect(mockSvc.createDeal).toHaveBeenCalledTimes(1);
        expect(crmDb.updateLead).toHaveBeenCalledWith(
            'list-1',
            'lead-1',
            expect.objectContaining({ syncMetadata: expect.objectContaining({ attio_deal_id: 'deal-new' }) })
        );
    });

    it('resync: updates existing deal when attio_deal_id is in syncMetadata', async () => {
        const lead = makeLead({ syncMetadata: { attio_deal_id: 'deal-existing' } });
        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.findDealsByPersonId).not.toHaveBeenCalled();
        expect(mockSvc.updateDeal).toHaveBeenCalledWith('deal-existing', expect.any(Object));
        expect(mockSvc.createDeal).not.toHaveBeenCalled();
    });

    it('CRM recovery: no deal in DB but findDealsByPersonId returns one — updates instead of creating duplicate', async () => {
        mockSvc.findDealsByPersonId.mockResolvedValueOnce([{ recordId: 'deal-recovered' }]);
        const lead = makeLead(); // no attio_deal_id in DB

        await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(mockSvc.findDealsByPersonId).toHaveBeenCalledWith('person-1');
        expect(mockSvc.updateDeal).toHaveBeenCalledWith('deal-recovered', expect.any(Object));
        expect(mockSvc.createDeal).not.toHaveBeenCalled();
        // Persist the recovered deal ID to DB
        expect(crmDb.updateLead).toHaveBeenCalledWith(
            'list-1',
            'lead-1',
            expect.objectContaining({ syncMetadata: expect.objectContaining({ attio_deal_id: 'deal-recovered' }) })
        );
    });

    it('deal failure is non-fatal: person success counted even if deal sync throws', async () => {
        mockSvc.createDeal.mockRejectedValueOnce(new Error('deal API error'));
        const lead = makeLead();

        const result = await adapter.pushLeads(baseAuth, [lead], baseConfig);

        // Person was synced — successCount should be 1
        expect(result.successCount).toBe(1);
        expect(result.errorCount).toBe(0);
    });

    it('person failure: error is counted and deal sync is skipped', async () => {
        mockSvc.upsertPersonByValues.mockRejectedValueOnce(new Error('person API error'));
        const lead = makeLead();

        const result = await adapter.pushLeads(baseAuth, [lead], baseConfig);

        expect(result.errorCount).toBe(1);
        expect(result.successCount).toBe(0);
        expect(mockSvc.createDeal).not.toHaveBeenCalled();
    });
});
