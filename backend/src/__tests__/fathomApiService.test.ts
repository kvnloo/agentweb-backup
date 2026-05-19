import { FathomApiService } from '../services/fathomApiService';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('FathomApiService', () => {
  let service: FathomApiService;
  const testApiKey = 'fv2_test_api_key_123';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FathomApiService(testApiKey);
  });

  describe('registerWebhook', () => {
    const destinationUrl = 'https://api.agentweb.pro/api/webhooks/fathom';

    it('should POST to Fathom webhooks endpoint with correct headers and body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'wh-abc-123' }),
      });

      const result = await service.registerWebhook(destinationUrl);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.fathom.ai/external/v1/webhooks',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${testApiKey}`,
            'Content-Type': 'application/json',
          }),
        })
      );

      // Verify body
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.destination_url).toBe(destinationUrl);
      expect(body.triggered_for).toEqual(['my_recordings', 'shared_team_recordings']);
      expect(body.include_transcript).toBe(true);
      expect(body.include_summary).toBe(true);
      expect(body.include_action_items).toBe(true);
      expect(body.include_crm_matches).toBe(true);

      expect(result).toEqual({ id: 'wh-abc-123' });
    });

    it('should throw when Fathom returns non-200 status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ error: 'Invalid destination URL' }),
      });

      await expect(service.registerWebhook(destinationUrl))
        .rejects.toThrow('Failed to register Fathom webhook: 422');
    });

    it('should throw when Fathom API is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(service.registerWebhook(destinationUrl))
        .rejects.toThrow('Network error');
    });
  });

  describe('deleteWebhook', () => {
    it('should DELETE the correct webhook endpoint with API key header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await service.deleteWebhook('wh-abc-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.fathom.ai/external/v1/webhooks/wh-abc-123',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${testApiKey}`,
          }),
        })
      );
    });

    it('should throw when deletion returns non-200 status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Webhook not found' }),
      });

      await expect(service.deleteWebhook('wh-nonexistent'))
        .rejects.toThrow('Failed to delete Fathom webhook: 404');
    });

    it('should throw when Fathom API is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(service.deleteWebhook('wh-abc-123'))
        .rejects.toThrow('Connection refused');
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid API key (200 response)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ teams: [{ id: 'team-1' }] }),
      });

      const result = await service.validateApiKey();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.fathom.ai/external/v1/teams',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${testApiKey}`,
          }),
        })
      );
    });

    it('should return false for invalid API key (401 response)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await service.validateApiKey();
      expect(result).toBe(false);
    });

    it('should return false for forbidden API key (403 response)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
      });

      const result = await service.validateApiKey();
      expect(result).toBe(false);
    });

    it('should return null when Fathom API is unreachable (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('DNS lookup failed'));

      const result = await service.validateApiKey();
      expect(result).toBeNull();
    });

    it('should return null for 5xx responses (Fathom server error, not auth failure)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const result = await service.validateApiKey();
      expect(result).toBeNull();
    });
  });
});
