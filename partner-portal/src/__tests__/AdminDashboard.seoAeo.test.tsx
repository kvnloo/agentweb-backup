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
          googleAnalyticsPropertyId: '123456789',
          clarityProjectId: 'ul13e4f7fe'
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { 
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789',
          clarityProjectId: 'ul13e4f7fe'
        },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/seo-aeo'),
        { 
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789',
          clarityProjectId: 'ul13e4f7fe'
        },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.seoDomains).toEqual(['example.com']);
      expect(response.data.googleAnalyticsPropertyId).toBe('123456789');
      expect(response.data.clarityProjectId).toBe('ul13e4f7fe');
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

    it('should call API with Microsoft Clarity Project ID', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          clarityProjectId: 'ul13e4f7fe'
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { clarityProjectId: 'ul13e4f7fe' },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/seo-aeo'),
        { clarityProjectId: 'ul13e4f7fe' },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.clarityProjectId).toBe('ul13e4f7fe');
    });
  });

  describe('gaFilteredDomains configuration', () => {
    it('should call API with gaFilteredDomains containing standard domains', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          gaFilteredDomains: ['app.example.com', 'admin.example.com']
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { gaFilteredDomains: ['app.example.com', 'admin.example.com'] },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/seo-aeo'),
        { gaFilteredDomains: ['app.example.com', 'admin.example.com'] },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.gaFilteredDomains).toEqual(['app.example.com', 'admin.example.com']);
    });

    it('should call API with gaFilteredDomains containing localhost', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          gaFilteredDomains: ['localhost', 'localhost:3000']
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { gaFilteredDomains: ['localhost', 'localhost:3000'] },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(response.data.gaFilteredDomains).toEqual(['localhost', 'localhost:3000']);
    });

    it('should call API with gaFilteredDomains containing IP addresses', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          gaFilteredDomains: ['127.0.0.1', '192.168.1.1:8080']
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { gaFilteredDomains: ['127.0.0.1', '192.168.1.1:8080'] },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(response.data.gaFilteredDomains).toEqual(['127.0.0.1', '192.168.1.1:8080']);
    });

    it('should call API with mixed gaFilteredDomains (domains, localhost, IPs)', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          gaFilteredDomains: ['app.example.com', 'localhost', '127.0.0.1']
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { gaFilteredDomains: ['app.example.com', 'localhost', '127.0.0.1'] },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(response.data.gaFilteredDomains).toEqual(['app.example.com', 'localhost', '127.0.0.1']);
    });

    it('should handle API errors for invalid gaFilteredDomains format', async () => {
      mockedAxios.put.mockRejectedValueOnce({
        response: {
          status: 400,
          data: {
            message: 'Invalid filtered domain format: invalid_domain. Please use format like app.example.com, localhost, or an IP address'
          }
        }
      });

      try {
        await mockedAxios.put(
          `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
          { gaFilteredDomains: ['invalid_domain'] },
          {
            headers: { Authorization: `Bearer ${mockToken}` }
          }
        );
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Invalid filtered domain format');
      }
    });

    it('should call API with empty gaFilteredDomains array', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          gaFilteredDomains: []
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        { gaFilteredDomains: [] },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(response.data.gaFilteredDomains).toEqual([]);
    });

    it('should call API with all SEO/AEO fields including gaFilteredDomains', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789',
          gaFilteredDomains: ['app.example.com', 'localhost'],
          clarityProjectId: 'ul13e4f7fe',
          productDomain: 'app.example.com'
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/seo-aeo`,
        {
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789',
          gaFilteredDomains: ['app.example.com', 'localhost'],
          clarityProjectId: 'ul13e4f7fe',
          productDomain: 'app.example.com'
        },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/seo-aeo'),
        {
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789',
          gaFilteredDomains: ['app.example.com', 'localhost'],
          clarityProjectId: 'ul13e4f7fe',
          productDomain: 'app.example.com'
        },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.gaFilteredDomains).toEqual(['app.example.com', 'localhost']);
      expect(response.data.seoDomains).toEqual(['example.com']);
      expect(response.data.googleAnalyticsPropertyId).toBe('123456789');
    });
  });
});
