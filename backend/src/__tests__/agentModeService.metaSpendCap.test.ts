// ENG-1018 — a campaign spend cap is the hard money stop, and it used to be
// possible to request one, be told "Campaign updated/created successfully", and
// have no cap at all:
//   1. CREATE dropped spend_cap before it reached Meta (createCampaign's literal
//      key allow-list), yet still reported plain success.
//   2. UPDATE did apply it, but nothing could read it back.
// These assertions pin the agentMode half: spend_cap is written on CREATE and
// UPDATE, and every spend_cap write is verified with an independent read-back so
// a dropped cap is reported loudly instead of as plain success.

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      createCampaign: jest.fn(),
      updateCampaign: jest.fn(),
      getCampaign: jest.fn(),
      listCampaigns: jest.fn(),
    }
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

const mockUser = {
  id: 'user123',
  connected_accounts: [
    {
      platform: 'meta',
      account_id: '123456789',
      account_name: 'Test Business',
      config: {
        account_type: 'ad_account',
        access_token: 'mock-access-token',
        ad_account_id: '123456789'
      }
    }
  ]
};

describe('AgentModeService - campaign spend_cap write + verify (ENG-1018)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
  });

  describe('CREATE', () => {
    const createParams = {
      name: 'Capped campaign',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: ['NONE'],
      spend_cap: 100000,
    };

    it('forwards spend_cap to Meta and confirms it by reading the campaign back', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', name: 'Capped campaign' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', spend_cap: '100000' });

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect((metaService.createCampaign as jest.Mock).mock.calls[0][2]).toEqual(
        expect.objectContaining({ spend_cap: 100000 })
      );
      expect(metaService.getCampaign).toHaveBeenCalledWith('123456789', 'mock-access-token', 'camp_new');
      expect(result.success).toBe(true);
      expect(result.spend_cap_verified).toBe(true);
      expect(result.spend_cap).toBe(100000);
    });

    it('reports the cap as NOT applied when the read-back shows no cap (the reported bug)', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', name: 'Capped campaign' });
      // Exactly what a raw Graph read returned for the two new campaigns: no spend_cap at all.
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new' });

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect(result.spend_cap_verified).toBe(false);
      expect(result.error).toBe('SPEND_CAP_NOT_APPLIED');
      expect(result.message).toMatch(/NOT applied/i);
      // The campaign id must survive so the caller can repair it with an UPDATE
      // instead of creating a duplicate campaign.
      expect(result.campaign).toEqual(expect.objectContaining({ id: 'camp_new' }));
    });

    it('reports the cap as unverified (never as applied) when the read-back itself fails', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', name: 'Capped campaign' });
      (metaService.getCampaign as jest.Mock).mockRejectedValue(new Error('Meta API Error: transient'));

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect(result.spend_cap_verified).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.message).toMatch(/could not be verified/i);
    });

    it('does not read anything back when no spend cap was requested', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', name: 'Plain campaign' });

      const result = await service.createMetaAdsCampaign('user123', {
        name: 'Plain campaign',
        objective: 'OUTCOME_TRAFFIC',
        special_ad_categories: ['NONE'],
      } as any);

      expect(metaService.getCampaign).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.spend_cap_verified).toBeUndefined();
    });
  });

  describe('UPDATE', () => {
    it('confirms an applied spend_cap by reading the campaign back', async () => {
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_1', spend_cap: '300000' });

      const result = await service.updateMetaAdsCampaign('user123', 'camp_1', { spend_cap: 300000 });

      expect((metaService.updateCampaign as jest.Mock).mock.calls[0][2]).toEqual(
        expect.objectContaining({ spend_cap: 300000 })
      );
      expect(result.success).toBe(true);
      expect(result.spend_cap_verified).toBe(true);
      expect(result.spend_cap).toBe(300000);
    });

    it('fails loudly when the read-back shows a different cap than requested', async () => {
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_1', spend_cap: '100000' });

      const result = await service.updateMetaAdsCampaign('user123', 'camp_1', { spend_cap: 300000 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('SPEND_CAP_NOT_APPLIED');
      expect(result.message).toMatch(/NOT applied/i);
    });

    it('does not claim success-with-cap when the read-back itself fails', async () => {
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
      (metaService.getCampaign as jest.Mock).mockRejectedValue(new Error('Meta API Error: transient'));

      const result = await service.updateMetaAdsCampaign('user123', 'camp_1', { spend_cap: 300000 });

      expect(result.spend_cap_verified).toBe(false);
      expect(result.message).toMatch(/could not be verified/i);
    });

    it('leaves non-spend_cap updates untouched (no extra read-back)', async () => {
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });

      const result = await service.updateMetaAdsCampaign('user123', 'camp_1', { status: 'PAUSED' });

      expect(metaService.getCampaign).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Campaign updated successfully');
    });
  });
});
