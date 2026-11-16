// ENG-2278 (ENG-2046 A1b) — campaign and ad-set budget writes are read back and
// reported CONFIRMED / MISMATCH / UNCONFIRMED, mirroring the ENG-1018 spend-cap
// read-back. Unconfirmed is never success-with-budget and never a failed write.

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
      updateCampaign: jest.fn(),
      getCampaign: jest.fn(),
      updateAdSet: jest.fn(),
      getAdSet: jest.fn(),
      getAdAccountCurrency: jest.fn().mockResolvedValue('USD'),
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
      config: { account_type: 'ad_account', access_token: 'mock-access-token', ad_account_id: '123456789' }
    }
  ]
};

describe('AgentModeService - Meta budget write read-back (ENG-2278)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
    (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });
    (metaService.getAdAccountCurrency as jest.Mock).mockResolvedValue('USD');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('ad set budget update', () => {
    it('reports CONFIRMED only when the read-back matches (major units converted to cents)', async () => {
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'as_1', daily_budget: '5000' });
      const result = await service.updateMetaAdsAdSet('user123', 'as_1', { daily_budget: 50 });
      expect(metaService.updateAdSet).toHaveBeenCalledWith('mock-access-token', 'as_1', expect.objectContaining({ daily_budget: 5000 }), '123456789');
      expect(result.success).toBe(true);
      expect(result.budget_verification).toBe('CONFIRMED');
      expect(result.budget_applied).toEqual({ daily_budget: 5000 });
      expect(result.error).toBeUndefined();
    });

    it('reports MISMATCH with intended vs applied values', async () => {
      jest.useFakeTimers();
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'as_1', lifetime_budget: '50' });
      const p = service.updateMetaAdsAdSet('user123', 'as_1', { lifetime_budget: 50 });
      await jest.advanceTimersByTimeAsync(15000);
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.budget_verification).toBe('MISMATCH');
      expect(result.error).toBe('BUDGET_MISMATCH');
      expect(result.budget_requested).toEqual({ lifetime_budget: 5000 });
      expect(result.budget_applied).toEqual({ lifetime_budget: 50 });
      expect(result.message).toMatch(/requested lifetime_budget=5000/);
      expect(result.message).toMatch(/Meta has lifetime_budget=50 /);
    });

    it('reports UNCONFIRMED (not success-with-budget, not failure) when the read-back fails', async () => {
      jest.useFakeTimers();
      (metaService.getAdSet as jest.Mock).mockRejectedValue(new Error('Meta unreachable'));
      const p = service.updateMetaAdsAdSet('user123', 'as_1', { daily_budget: 20 });
      await jest.advanceTimersByTimeAsync(15000);
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.budget_verification).toBe('UNCONFIRMED');
      expect(result.error).toBe('BUDGET_UNCONFIRMED');
      expect(result.message).toMatch(/could NOT be confirmed/);
      expect(result.message).toMatch(/Meta unreachable/);
      expect(metaService.updateAdSet).toHaveBeenCalledTimes(1); // write never re-sent
    });

    it('retries a lagging read instead of reporting a mismatch', async () => {
      jest.useFakeTimers();
      (metaService.getAdSet as jest.Mock)
        .mockResolvedValueOnce({ id: 'as_1', daily_budget: '1000' })
        .mockResolvedValueOnce({ id: 'as_1', daily_budget: '2000' });
      const p = service.updateMetaAdsAdSet('user123', 'as_1', { daily_budget: 20 });
      await jest.advanceTimersByTimeAsync(15000);
      const result = await p;
      expect(result.budget_verification).toBe('CONFIRMED');
    });

    // ENG-3065: a status-only update is read back once for status; no budget verdict is added.
    it('adds no budget verdict to non-budget updates', async () => {
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'as_1', status: 'PAUSED' });
      const result = await service.updateMetaAdsAdSet('user123', 'as_1', { status: 'PAUSED' });
      expect(result).toEqual({ success: true, message: 'Ad set updated successfully' });
      expect(metaService.getAdSet).toHaveBeenCalledTimes(1);
    });
  });

  describe('campaign budget update', () => {
    it('reports CONFIRMED for budget_amount converted to daily_budget cents', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'c_1', daily_budget: '7500' });
      const result = await service.updateMetaAdsCampaign('user123', 'c_1', { budget_amount: 75 });
      expect(result.success).toBe(true);
      expect(result.budget_verification).toBe('CONFIRMED');
    });

    it('reports UNCONFIRMED when the field is absent on every read', async () => {
      jest.useFakeTimers();
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'c_1' });
      const p = service.updateMetaAdsCampaign('user123', 'c_1', { daily_budget: 7500 });
      await jest.advanceTimersByTimeAsync(15000);
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.budget_verification).toBe('UNCONFIRMED');
      expect(result.error).toBe('BUDGET_UNCONFIRMED');
    });

    it('keeps the spend-cap verdict and adds the budget verdict alongside it', async () => {
      jest.useFakeTimers();
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'c_1', daily_budget: '100', spend_cap: '300000' });
      const p = service.updateMetaAdsCampaign('user123', 'c_1', { daily_budget: 75, spend_cap: 3000 });
      await jest.advanceTimersByTimeAsync(15000);
      const result = await p;
      expect(result.spend_cap_verified).toBe(true);
      expect(result.budget_verification).toBe('MISMATCH');
      expect(result.error).toBe('BUDGET_MISMATCH');
    });

    // ENG-3065: a status-only update is read back once for status; no budget verdict is added.
    it('adds no budget verdict to a status-only update', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'c_1', status: 'PAUSED' });
      const result = await service.updateMetaAdsCampaign('user123', 'c_1', { status: 'PAUSED' });
      expect(result).toEqual({ success: true, message: 'Campaign updated successfully' });
      expect(metaService.getCampaign).toHaveBeenCalledTimes(1);
    });
  });
});
