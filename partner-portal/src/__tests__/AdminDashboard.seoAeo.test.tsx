// Unit tests for SEO/AEO configuration functionality in AdminDashboard

import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AdminDashboard - SEO/AEO Configuration', () => {
  const mockToken = 'test-token';
  const mockUserId = 'user1';

  describe('SEO/AEO configuration API calls', () => {
    it('should call API with correct endpoint and payload for SEO domains', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: { 
          userId: mockUserId,
          seoDomains: ['example.com', 'another.com']
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { seoDomains: ['example.com', 'another.com'] },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/seo-aeo'),
        { seoDomains: ['example.com', 'another.com'] },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.seoDomains).toEqual(['example.com', 'another.com']);
    });

    it('should call API with correct endpoint and payload for Google Analytics Property ID', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: { 
          userId: mockUserId,
          googleAnalyticsPropertyId: '123456789'
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { googleAnalyticsPropertyId: '123456789' },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/seo-aeo'),
        { googleAnalyticsPropertyId: '123456789' },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.googleAnalyticsPropertyId).toBe('123456789');
    });

    it('should call API with both SEO domains and GA Property ID', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: { 
          userId: mockUserId,
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789'
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { 
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789'
        },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/seo-aeo'),
        { 
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789'
        },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.seoDomains).toEqual(['example.com']);
      expect(response.data.googleAnalyticsPropertyId).toBe('123456789');
    });

    it('should handle API errors for invalid GA Property ID format', async () => {
      mockedAxios.put.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { 
            message: 'Invalid Google Analytics Property ID format: G-XXXXXXXXXX. Please enter the numeric Property ID (e.g., 123456789).'
          }
        }
      });

      try {
        await mockedAxios.put(
          `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
          { googleAnalyticsPropertyId: 'G-XXXXXXXXXX' },
          {
            headers: { Authorization: `Bearer ${mockToken}` }
          }
        );
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Invalid Google Analytics Property ID format');
      }
    });

    it('should handle API errors for invalid domain format', async () => {
      mockedAxios.put.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { 
            message: 'Invalid domain format: invalid-domain. Please use format like example.com'
          }
        }
      });

      try {
        await mockedAxios.put(
          `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
          { seoDomains: ['invalid-domain'] },
          {
            headers: { Authorization: `Bearer ${mockToken}` }
          }
        );
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Invalid domain format');
      }
    });

    it('should handle clearing GA Property ID with empty string', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: { 
          userId: mockUserId,
          googleAnalyticsPropertyId: null
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { googleAnalyticsPropertyId: '' },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(response.data.googleAnalyticsPropertyId).toBeNull();
    });
  });
});
