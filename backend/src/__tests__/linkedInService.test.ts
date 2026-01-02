/**
 * Unit tests for LinkedInService
 * Tests cover: API calls, error handling, token verification
 */

// Mock axios before any imports
jest.mock('axios', () => {
  const mockCreate = jest.fn().mockReturnValue({
    get: jest.fn(),
    post: jest.fn(),
  });
  return {
    create: mockCreate,
    isAxiosError: jest.fn(),
    get: jest.fn(),
    __esModule: true,
    default: {
      create: mockCreate,
      isAxiosError: jest.fn(),
      get: jest.fn(),
    },
  };
});

import axios from 'axios';
import { LinkedInService } from '../services/linkedInService';

describe('LinkedInService', () => {
  let service: LinkedInService;
  let mockClient: {
    get: jest.Mock;
    post: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create a fresh instance for each test
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
    };
    (axios.create as jest.Mock).mockReturnValue(mockClient);
    
    service = new LinkedInService();
  });

  describe('constructor', () => {
    it('should create axios client with correct base URL and headers', () => {
      expect(axios.create).toHaveBeenCalledWith({
        baseURL: 'https://api.linkedin.com',
        headers: {
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202511',
          'Content-Type': 'application/json',
        },
      });
    });
  });

  describe('getProfile', () => {
    it('should fetch user profile with correct authorization header', async () => {
      const mockProfile = {
        sub: 'user123',
        name: 'John Doe',
        email: 'john@example.com',
        picture: 'https://example.com/photo.jpg',
      };
      mockClient.get.mockResolvedValue({ data: mockProfile });

      const result = await service.getProfile('test-access-token');

      expect(mockClient.get).toHaveBeenCalledWith('/v2/userinfo', {
        headers: { Authorization: 'Bearer test-access-token' },
      });
      expect(result).toEqual(mockProfile);
    });

    it('should throw error with message for 401 response', async () => {
      const axiosError = {
        response: { status: 401, data: { message: 'Unauthorized' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.get.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(service.getProfile('expired-token')).rejects.toThrow(
        'LinkedIn access token expired or invalid'
      );
    });

    it('should throw error for 403 response with permission message', async () => {
      const axiosError = {
        response: { status: 403, data: { message: 'Forbidden' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.get.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(service.getProfile('limited-token')).rejects.toThrow(
        'LinkedIn Permission Denied'
      );
    });

    it('should throw error for 429 rate limit response', async () => {
      const axiosError = {
        response: { status: 429, data: { message: 'Too Many Requests' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.get.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(service.getProfile('token')).rejects.toThrow(
        'LinkedIn rate limit exceeded'
      );
    });
  });

  describe('getAdminOrganizations', () => {
    it('should fetch admin organizations with correct params', async () => {
      const mockResponse = {
        elements: [
          { organizationTarget: 'urn:li:organization:123', role: 'ADMINISTRATOR' },
        ],
      };
      mockClient.get.mockResolvedValue({ data: mockResponse });

      const result = await service.getAdminOrganizations('test-token');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/organizationAcls', {
        params: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' },
        headers: { Authorization: 'Bearer test-token' },
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getFollowerStatistics', () => {
    it('should fetch follower statistics for organization', async () => {
      const mockStats = [{ followerCount: 1000 }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      const result = await service.getFollowerStatistics('token', 'urn:li:organization:123');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/organizationalEntityFollowerStatistics', {
        params: { q: 'organizationalEntity', organizationalEntity: 'urn:li:organization:123' },
        headers: { Authorization: 'Bearer token' },
      });
      expect(result).toEqual(mockStats);
    });
  });

  describe('getPageStatistics', () => {
    it('should fetch page statistics for organization', async () => {
      const mockStats = [{ pageViews: 5000 }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      const result = await service.getPageStatistics('token', 'urn:li:organization:456');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/organizationPageStatistics', {
        params: { q: 'organization', organization: 'urn:li:organization:456' },
        headers: { Authorization: 'Bearer token' },
      });
      expect(result).toEqual(mockStats);
    });
  });

  describe('getShareStatistics', () => {
    it('should fetch share statistics without specific shares', async () => {
      const mockStats = [{ share: 'urn:li:share:123', totalShareStatistics: { likeCount: 50 } }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      const result = await service.getShareStatistics('token', 'urn:li:organization:123');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/organizationalEntityShareStatistics', {
        params: { q: 'organizationalEntity', organizationalEntity: 'urn:li:organization:123' },
        headers: { Authorization: 'Bearer token' },
      });
      expect(result).toEqual(mockStats);
    });

    it('should include share URNs when provided', async () => {
      const mockStats = [{ share: 'urn:li:share:123' }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      await service.getShareStatistics('token', 'urn:li:organization:123', ['urn:li:share:1', 'urn:li:share:2']);

      expect(mockClient.get).toHaveBeenCalledWith('/rest/organizationalEntityShareStatistics', {
        params: {
          q: 'organizationalEntity',
          organizationalEntity: 'urn:li:organization:123',
          shares: 'List(urn:li:share:1,urn:li:share:2)',
        },
        headers: { Authorization: 'Bearer token' },
      });
    });
  });

  describe('listPosts', () => {
    it('should list posts for author with pagination', async () => {
      const mockPosts = { elements: [{ id: 'post1' }, { id: 'post2' }] };
      mockClient.get.mockResolvedValue({ data: mockPosts });

      const result = await service.listPosts('token', 'urn:li:person:123', 0, 10);

      expect(mockClient.get).toHaveBeenCalledWith('/rest/posts', {
        params: { q: 'author', author: 'urn:li:person:123', start: 0, count: 10 },
        headers: { Authorization: 'Bearer token' },
      });
      expect(result).toEqual(mockPosts);
    });

    it('should use default pagination values', async () => {
      mockClient.get.mockResolvedValue({ data: { elements: [] } });

      await service.listPosts('token', 'urn:li:organization:123');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/posts', {
        params: { q: 'author', author: 'urn:li:organization:123', start: 0, count: 50 },
        headers: { Authorization: 'Bearer token' },
      });
    });
  });

  describe('createPost', () => {
    it('should create a post with correct payload', async () => {
      mockClient.post.mockResolvedValue({
        data: {},
        headers: { 'x-restli-id': 'urn:li:share:123456' },
      });

      const result = await service.createPost('token', 'urn:li:person:123', 'Hello LinkedIn!');

      expect(mockClient.post).toHaveBeenCalledWith(
        '/rest/posts',
        {
          author: 'urn:li:person:123',
          commentary: 'Hello LinkedIn!',
          visibility: 'PUBLIC',
          lifecycleState: 'PUBLISHED',
          distribution: { feedDistribution: 'MAIN_FEED' },
        },
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:share:123456');
    });

    it('should return id from response body if header not present', async () => {
      mockClient.post.mockResolvedValue({
        data: { id: 'urn:li:share:789' },
        headers: {},
      });

      const result = await service.createPost('token', 'urn:li:organization:123', 'Company post');

      expect(result).toBe('urn:li:share:789');
    });
  });

  describe('getAggregatedMetrics', () => {
    it('should aggregate follower and page statistics', async () => {
      const followerStats = [{ followerCount: 100 }];
      const pageStats = [{ pageViews: 500 }];
      
      mockClient.get
        .mockResolvedValueOnce({ data: { elements: followerStats } })
        .mockResolvedValueOnce({ data: { elements: pageStats } });

      const result = await service.getAggregatedMetrics('token', 'urn:li:organization:123');

      expect(result).toEqual({
        followerStatistics: followerStats,
        pageStatistics: pageStats,
      });
    });
  });

  describe('getOrganization', () => {
    it('should fetch organization details', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          id: 123456,
          localizedName: 'Acme Corp',
          vanityName: 'acme-corp',
          logoV2: { original: 'https://example.com/logo.png' },
        },
      });

      const result = await service.getOrganization('token', 'urn:li:organization:123456');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/organizations/123456', {
        headers: { Authorization: 'Bearer token' },
      });
      expect(result).toEqual({
        id: '123456',
        name: 'Acme Corp',
        vanityName: 'acme-corp',
        logoUrl: 'https://example.com/logo.png',
      });
    });

    it('should handle missing optional fields gracefully', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          id: 789,
          name: { localized: { en_US: 'Fallback Name' } },
        },
      });

      const result = await service.getOrganization('token', 'urn:li:organization:789');

      expect(result.name).toBe('Fallback Name');
    });
  });

  describe('getOrganizationFollowerCount', () => {
    it('should return follower count from networkSizes endpoint', async () => {
      mockClient.get.mockResolvedValue({
        data: { firstDegreeSize: 2500 },
      });

      const result = await service.getOrganizationFollowerCount('token', 'urn:li:organization:123');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/networkSizes/urn:li:organization:123', {
        headers: { Authorization: 'Bearer token' },
        params: { edgeType: 'CompanyFollowedByMember' },
      });
      expect(result).toBe(2500);
    });

    it('should return 0 on error and not throw', async () => {
      mockClient.get.mockRejectedValue(new Error('Network error'));

      const result = await service.getOrganizationFollowerCount('token', 'urn:li:organization:123');

      expect(result).toBe(0);
    });
  });

  describe('verifyToken', () => {
    it('should return valid: true for successful request', async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: { sub: 'user123' } });

      const result = await service.verifyToken('valid-token');

      expect(axios.get).toHaveBeenCalledWith('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: 'Bearer valid-token' },
        timeout: 5000,
      });
      expect(result).toEqual({ valid: true });
    });

    it('should return valid: false with error for 401 response', async () => {
      (axios.get as jest.Mock).mockRejectedValue({
        response: { status: 401 },
      });

      const result = await service.verifyToken('expired-token');

      expect(result).toEqual({ valid: false, error: 'Token expired or revoked' });
    });

    it('should return valid: false with error for 403 response', async () => {
      (axios.get as jest.Mock).mockRejectedValue({
        response: { status: 403 },
      });

      const result = await service.verifyToken('revoked-token');

      expect(result).toEqual({ valid: false, error: 'Token permissions revoked' });
    });

    it('should return valid: true with uncertain flag on network error', async () => {
      (axios.get as jest.Mock).mockRejectedValue({
        code: 'ECONNREFUSED',
        message: 'Connection refused',
      });

      const result = await service.verifyToken('token');

      expect(result).toEqual({ valid: true, uncertain: true, error: 'Network error - could not verify token' });
    });
  });
});
