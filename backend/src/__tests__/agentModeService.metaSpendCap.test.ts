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
import { toolResultError } from '../utils/toolResultError';

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

    it('names the requested campaign even though Meta returns only an id', async () => {
      // metaService.createCampaign asks the Graph API for `id` only, so this is the real
      // create response shape. It used to render as `Campaign "undefined" created
      // successfully` in production (session 5ac8aeef-db88-4ccc-85ca-347b13c99542).
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', spend_cap: '100000' });

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect(result.message).toContain('Capped campaign');
      expect(result.message).not.toContain('undefined');
    });

    it('reports the cap as NOT applied when the read-back shows no cap (the reported bug)', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new' });
      // Exactly what a raw Graph read returned for the two new campaigns: no spend_cap at all.
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new' });

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect(result.spend_cap_verified).toBe(false);
      expect(result.error).toBe('SPEND_CAP_NOT_APPLIED');
      expect(result.message).toMatch(/NOT applied/i);
      // The campaign id must survive so the caller can repair it with an UPDATE
      // instead of creating a duplicate campaign.
      expect(result.campaign).toEqual(expect.objectContaining({ id: 'camp_new' }));
      // CREATE keeps success:true deliberately: the campaign DOES exist, and a
      // success:false result is rewritten at the dispatch boundary into a bare error
      // string, which would hide the campaign id and invite a duplicate create.
      expect(result.success).toBe(true);
      expect(toolResultError(result)).toBeNull();
    }, 20000);

    it('reports the cap as unverified (never as applied) when the read-back itself fails', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', name: 'Capped campaign' });
      (metaService.getCampaign as jest.Mock).mockRejectedValue(new Error('Meta API Error: transient'));

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect(result.spend_cap_verified).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.message).toMatch(/could not be verified/i);
    }, 20000);

    it('does not cry wolf on read-after-write lag — a stale read is retried, not believed', async () => {
      // Meta's read-after-write is not instant. Believing the FIRST read would tell a user
      // their money stop is missing when it landed a second later.
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new' });
      (metaService.getCampaign as jest.Mock)
        .mockResolvedValueOnce({ id: 'camp_new' })                        // not propagated yet
        .mockResolvedValueOnce({ id: 'camp_new', spend_cap: '100000' });  // now visible

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect(metaService.getCampaign).toHaveBeenCalledTimes(2);
      expect(result.spend_cap_verified).toBe(true);
      expect(result.error).toBeUndefined();
    }, 20000);

    it('recovers when the read-back itself fails transiently', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new' });
      (metaService.getCampaign as jest.Mock)
        .mockRejectedValueOnce(new Error('Meta API Error: transient'))
        .mockResolvedValueOnce({ id: 'camp_new', spend_cap: '100000' });

      const result = await service.createMetaAdsCampaign('user123', createParams as any);

      expect(result.spend_cap_verified).toBe(true);
    }, 20000);

    it('spells out the currency equivalent so a cents/dollars slip is visible', async () => {
      // spend_cap is in cents while budget_amount in the same tool is in dollars; a model
      // passing 3000 for "$3,000" would otherwise get a confident "verified: 3000".
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_new', spend_cap: '3000' });

      const result = await service.createMetaAdsCampaign('user123', { ...createParams, spend_cap: 3000 } as any);

      expect(result.spend_cap_verified).toBe(true);
      expect(result.message).toContain('30.00');
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
      expect(result.error).toMatch(/^SPEND_CAP_NOT_APPLIED/);
      expect(result.message).toMatch(/NOT applied/i);
      expect(result.spend_cap_requested).toBe(300000);
      expect(result.spend_cap_applied).toBe(100000);
    }, 20000);

    it('carries the whole story in the reason the model actually sees', async () => {
      // A success:false result never reaches the model as JSON: the dispatch boundary
      // (utils/toolResultError → extractToolResultMessage) replaces it with ONE reason
      // string taken from `error` before `message`, and extractMinimalToolResult keeps
      // nothing for this tool. So the reason itself has to name the requested cap, the
      // campaign, and what to tell the user — a bare code told the model nothing.
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_1' });

      const result = await service.updateMetaAdsCampaign('user123', 'camp_1', { spend_cap: 300000 });

      const modelVisibleReason = toolResultError(result)?.message ?? '';
      expect(modelVisibleReason).toContain('SPEND_CAP_NOT_APPLIED');
      expect(modelVisibleReason).toContain('300000');
      expect(modelVisibleReason).toContain('camp_1');
      expect(modelVisibleReason).toMatch(/NO spend cap set/i);
      expect(modelVisibleReason).toMatch(/tell the user/i);
    }, 20000);

    it('does not claim success-with-cap when the read-back itself fails', async () => {
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
      (metaService.getCampaign as jest.Mock).mockRejectedValue(new Error('Meta API Error: transient'));

      const result = await service.updateMetaAdsCampaign('user123', 'camp_1', { spend_cap: 300000 });

      expect(result.spend_cap_verified).toBe(false);
      expect(result.message).toMatch(/could not be verified/i);
    }, 20000);

    it('leaves non-spend_cap updates untouched (no extra read-back)', async () => {
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });

      const result = await service.updateMetaAdsCampaign('user123', 'camp_1', { status: 'PAUSED' });

      expect(metaService.getCampaign).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Campaign updated successfully');
    });
  });
});
