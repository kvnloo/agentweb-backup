
import { LeadService } from '../LeadService';
import { crmDb } from '../../db';
import { brandService } from '../BrandService';
import { marketStrategyService } from '../MarketStrategyService';
import { llmClientFactory } from '../../llm/LLMClientFactory';
import { settingsService } from '../../settingsService';

// Mock dependencies
jest.mock('../../db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    createLeadList: jest.fn(),
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
    getLeadEngagements: jest.fn()
  }
}));

jest.mock('../BrandService', () => ({
  brandService: {
    readBrandGuidelines: jest.fn()
  }
}));

jest.mock('../MarketStrategyService', () => ({
  marketStrategyService: {
    readMarketStrategy: jest.fn()
  }
}));

jest.mock('../../llm/LLMClientFactory', () => ({
  llmClientFactory: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-mock'),
    callLLM: jest.fn()
  }
}));

jest.mock('../../settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

describe('LeadService', () => {
  let service: LeadService;

  beforeEach(() => {
    service = new LeadService();
    jest.clearAllMocks();
  });

  describe('getLeadLists', () => {
    it('should return lead lists', async () => {
      (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue(['list1', 'list2']);
      const result = await service.getLeadLists('user1');
      expect(result.success).toBe(true);
      expect(result.lists).toEqual(['list1', 'list2']);
    });
  });

  describe('addLeadsToList', () => {
    it('should add new leads', async () => {
      const listId = 'list1';
      const userId = 'user1';
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ id: listId, userId });
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null); // New lead

      const leads = [{ email: 'test@example.com', firstName: 'Test' }];
      const result = await service.addLeadsToList(listId, leads, userId);

      expect(result.success).toBe(true);
      expect(result.results.added).toBe(1);
      expect(crmDb.createLead).toHaveBeenCalledWith(listId, leads[0]);
    });
  });

  describe('updateEmailDraftForLead', () => {
    it('should generate email draft', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Write an email';

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ id: listId, userId });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({ id: leadId, firstName: 'John' });
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      
      (brandService.readBrandGuidelines as jest.Mock).mockResolvedValue({ exists: false });
      (marketStrategyService.readMarketStrategy as jest.Mock).mockResolvedValue({ exists: false });
      
      (llmClientFactory.callLLM as jest.Mock).mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Hello',
              textContent: 'Body content'
            })
          }
        }]
      });

      const result = await service.updateEmailDraftForLead(listId, leadId, instruction, sessionId, userId, 'text');

      expect(result.success).toBe(true);
      expect(result.draft.subject).toBe('Hello');
      expect(crmDb.updateLead).toHaveBeenCalled();
      expect(llmClientFactory.callLLM).toHaveBeenCalled();
    });
  });
});
