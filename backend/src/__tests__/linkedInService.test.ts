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
    put: jest.fn(),
    post: jest.fn(),
    __esModule: true,
    default: {
      create: mockCreate,
      isAxiosError: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
      post: jest.fn(),
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
        timeout: 15000,
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
      const mockResponse = {
        id: 'user123',
        localizedFirstName: 'John',
        localizedLastName: 'Doe',
      };
      
      const expectedProfile = {
        sub: 'user123',
        name: 'John Doe',
        given_name: 'John',
        family_name: 'Doe',
        picture: '',
        locale: '',
        email: '',
        email_verified: false,
      };

      mockClient.get.mockResolvedValue({ data: mockResponse });

      const result = await service.getProfile('test-access-token');

      expect(mockClient.get).toHaveBeenCalledWith('/v2/me', {
        headers: { Authorization: 'Bearer test-access-token' },
      });
      expect(result).toEqual(expectedProfile);
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

    it('should handle empty organizations list', async () => {
      const mockResponse = { elements: [] };
      mockClient.get.mockResolvedValue({ data: mockResponse });

      const result = await service.getAdminOrganizations('test-token');

      expect(result.elements).toEqual([]);
    });

    it('should handle multiple organizations', async () => {
      const mockResponse = {
        elements: [
          { organizationTarget: 'urn:li:organization:123', role: 'ADMINISTRATOR' },
          { organizationTarget: 'urn:li:organization:456', role: 'ADMINISTRATOR' },
        ],
      };
      mockClient.get.mockResolvedValue({ data: mockResponse });

      const result = await service.getAdminOrganizations('test-token');

      expect(result.elements).toHaveLength(2);
    });
  });

  describe('getFollowerStatistics', () => {
    it('should fetch follower statistics for organization with proper URL encoding', async () => {
      const mockStats = [{ followerCount: 1000 }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      const result = await service.getFollowerStatistics('token', 'urn:li:organization:123');

      // Verify the URL is properly encoded and FINDER header is set
      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('organizationalEntityFollowerStatistics');
      expect(callArgs[1].headers['X-RestLi-Method']).toBe('FINDER');
      expect(callArgs[1].headers.Authorization).toBe('Bearer token');
      expect(result).toEqual(mockStats);
    });

    it('should handle URL encoding of organization URN with special characters', async () => {
      const mockStats = [{ followerCount: 500 }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      await service.getFollowerStatistics('token', 'urn:li:organization:123456');

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain(encodeURIComponent('urn:li:organization:123456'));
    });
  });

  describe('getPageStatistics', () => {
    it('should fetch page statistics for organization with FINDER header', async () => {
      const mockStats = [{ pageViews: 5000 }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      const result = await service.getPageStatistics('token', 'urn:li:organization:456');

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('organizationPageStatistics');
      expect(callArgs[1].headers['X-RestLi-Method']).toBe('FINDER');
      expect(callArgs[1].headers.Authorization).toBe('Bearer token');
      expect(result).toEqual(mockStats);
    });

    it('should properly encode organization URN in query string', async () => {
      const mockStats = [{ pageViews: 3000 }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      await service.getPageStatistics('token', 'urn:li:organization:789');

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain(encodeURIComponent('urn:li:organization:789'));
    });
  });

  describe('getShareStatistics', () => {
    it('should fetch share statistics without specific shares', async () => {
      const mockStats = [{ share: 'urn:li:share:123', totalShareStatistics: { likeCount: 50 } }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      const result = await service.getShareStatistics('token', 'urn:li:organization:123');

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('/rest/organizationalEntityShareStatistics');
      expect(callArgs[0]).toContain(encodeURIComponent('urn:li:organization:123'));
      expect(callArgs[1].headers['X-RestLi-Method']).toBe('FINDER');
      expect(callArgs[1].headers.Authorization).toBe('Bearer token');
      expect(result).toEqual(mockStats);
    });

    it('should include share URNs when provided', async () => {
      const mockStats = [{ share: 'urn:li:share:123' }];
      mockClient.get.mockResolvedValue({ data: { elements: mockStats } });

      await service.getShareStatistics('token', 'urn:li:organization:123', ['urn:li:share:1', 'urn:li:share:2']);

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('/rest/organizationalEntityShareStatistics');
      expect(callArgs[0]).toContain(encodeURIComponent('urn:li:organization:123'));
      expect(callArgs[0]).toContain('shares=List');
      expect(callArgs[1].headers['X-RestLi-Method']).toBe('FINDER');
    });
  });

  describe('listPosts', () => {
    it('should list posts for author with pagination', async () => {
      const mockPosts = { elements: [{ id: 'post1' }, { id: 'post2' }] };
      mockClient.get.mockResolvedValue({ data: mockPosts });

      const result = await service.listPosts('token', 'urn:li:person:123', 0, 10);

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('/rest/posts');
      expect(callArgs[0]).toContain(encodeURIComponent('urn:li:person:123'));
      expect(callArgs[0]).toContain('start=0');
      expect(callArgs[0]).toContain('count=10');
      expect(callArgs[1].headers['X-RestLi-Method']).toBe('FINDER');
      expect(callArgs[1].headers.Authorization).toBe('Bearer token');
      expect(result).toEqual(mockPosts);
    });

    it('should use default pagination values', async () => {
      mockClient.get.mockResolvedValue({ data: { elements: [] } });

      await service.listPosts('token', 'urn:li:organization:123');

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('/rest/posts');
      expect(callArgs[0]).toContain(encodeURIComponent('urn:li:organization:123'));
      expect(callArgs[0]).toContain('start=0');
      expect(callArgs[0]).toContain('count=50');
      expect(callArgs[1].headers['X-RestLi-Method']).toBe('FINDER');
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

    it('should create a post for company page', async () => {
      mockClient.post.mockResolvedValue({
        data: {},
        headers: { 'x-restli-id': 'urn:li:share:789' },
      });

      const result = await service.createPost('token', 'urn:li:organization:123', 'Company post');

      expect(mockClient.post).toHaveBeenCalledWith(
        '/rest/posts',
        {
          author: 'urn:li:organization:123',
          commentary: 'Company post',
          visibility: 'PUBLIC',
          lifecycleState: 'PUBLISHED',
          distribution: { feedDistribution: 'MAIN_FEED' },
        },
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:share:789');
    });

    it('should create a post with single image for company page', async () => {
      mockClient.post.mockResolvedValue({
        data: {},
        headers: { 'x-restli-id': 'urn:li:share:111' },
      });

      const result = await service.createPost('token', 'urn:li:organization:123', 'Post with image', ['urn:li:image:abc']);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/rest/posts',
        {
          author: 'urn:li:organization:123',
          commentary: 'Post with image',
          visibility: 'PUBLIC',
          lifecycleState: 'PUBLISHED',
          distribution: { feedDistribution: 'MAIN_FEED' },
          content: {
            media: {
              id: 'urn:li:image:abc'
            }
          }
        },
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:share:111');
    });

    it('should create a post with multiple images for company page', async () => {
      mockClient.post.mockResolvedValue({
        data: {},
        headers: { 'x-restli-id': 'urn:li:share:222' },
      });

      const result = await service.createPost('token', 'urn:li:organization:123', 'Post with images', ['urn:li:image:1', 'urn:li:image:2']);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/rest/posts',
        expect.objectContaining({
          content: {
            multiImage: {
              images: [{ id: 'urn:li:image:1' }, { id: 'urn:li:image:2' }]
            }
          }
        }),
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:share:222');
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
    it('should aggregate follower, page, and share statistics', async () => {
      const followerStats = [{ followerCount: 100 }];
      const pageStats = [{ pageViews: 500 }];
      const shareStats = [{ share: 'urn:li:share:123', totalShareStatistics: { likeCount: 50 } }];
      
      mockClient.get
        .mockResolvedValueOnce({ data: { elements: followerStats } })
        .mockResolvedValueOnce({ data: { elements: pageStats } })
        .mockResolvedValueOnce({ data: { elements: shareStats } });

      const result = await service.getAggregatedMetrics('token', 'urn:li:organization:123');

      expect(result).toEqual({
        followerStatistics: followerStats,
        pageStatistics: pageStats,
        shareStatistics: shareStats,
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
    it('should return follower count from networkSizes endpoint with proper URL encoding', async () => {
      mockClient.get.mockResolvedValue({
        data: { firstDegreeSize: 2500 },
      });

      const result = await service.getOrganizationFollowerCount('token', 'urn:li:organization:123');

      const callArgs = mockClient.get.mock.calls[0];
      expect(callArgs[0]).toContain('networkSizes');
      expect(callArgs[0]).toContain(encodeURIComponent('urn:li:organization:123'));
      expect(callArgs[1].params.edgeType).toBe('COMPANY_FOLLOWED_BY_MEMBER');
      expect(callArgs[1].headers.Authorization).toBe('Bearer token');
      expect(result).toBe(2500);
    });

    it('should return 0 on error and not throw', async () => {
      mockClient.get.mockRejectedValue(new Error('Network error'));

      const result = await service.getOrganizationFollowerCount('token', 'urn:li:organization:123');

      expect(result).toBe(0);
    });

    it('should handle 403 permission errors gracefully', async () => {
      const axiosError = {
        response: { status: 403, data: { message: 'Permission denied' } },
        isAxiosError: true,
      };
      mockClient.get.mockRejectedValue(axiosError);

      const result = await service.getOrganizationFollowerCount('token', 'urn:li:organization:123');

      expect(result).toBe(0);
    });
  });

  describe('initializeImageUpload', () => {
    it('should initialize image upload for company page', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          value: {
            uploadUrl: 'https://upload.linkedin.com/image/upload',
            image: 'urn:li:image:123456'
          }
        }
      });

      const result = await service.initializeImageUpload('token', 'urn:li:organization:123');

      expect(mockClient.post).toHaveBeenCalledWith(
        '/rest/images?action=initializeUpload',
        {
          initializeUploadRequest: {
            owner: 'urn:li:organization:123'
          }
        },
        {
          headers: { Authorization: 'Bearer token' }
        }
      );
      expect(result.uploadUrl).toBe('https://upload.linkedin.com/image/upload');
      expect(result.imageUrn).toBe('urn:li:image:123456');
    });
  });

  describe('uploadImageFromUrl', () => {
    beforeEach(() => {
      // Mock axios.get for downloading image
      (axios.get as jest.Mock).mockResolvedValue({
        data: Buffer.from('fake-image-data'),
        headers: { 'content-type': 'image/png' }
      });
      // Mock axios.put for uploading image
      (axios.put as jest.Mock).mockResolvedValue({});
    });

    it('should upload image from URL for company page', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          value: {
            uploadUrl: 'https://upload.linkedin.com/image/upload',
            image: 'urn:li:image:789'
          }
        }
      });

      const result = await service.uploadImageFromUrl('token', 'urn:li:organization:123', 'https://example.com/image.png');

      expect(axios.get).toHaveBeenCalledWith('https://example.com/image.png', {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      expect(mockClient.post).toHaveBeenCalled();
      expect(axios.put).toHaveBeenCalledWith(
        'https://upload.linkedin.com/image/upload',
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'image/png'
          })
        })
      );
      expect(result).toBe('urn:li:image:789');
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

  // ============================================
  // Personal Account Analytics Tests
  // ============================================
  describe('getPersonalFollowerCount', () => {
    it('should return follower count from memberFollowersCount endpoint', async () => {
      mockClient.get.mockResolvedValue({
        data: { elements: [{ memberFollowersCount: 1500 }] },
      });

      const result = await service.getPersonalFollowerCount('token');

      expect(mockClient.get).toHaveBeenCalledWith('/rest/memberFollowersCount', {
        params: { q: 'me' },
        headers: { Authorization: 'Bearer token' },
      });
      expect(result).toBe(1500);
    });

    it('should return 0 when elements array is empty', async () => {
      mockClient.get.mockResolvedValue({
        data: { elements: [] },
      });

      const result = await service.getPersonalFollowerCount('token');

      expect(result).toBe(0);
    });

    it('should return 0 when memberFollowersCount is undefined', async () => {
      mockClient.get.mockResolvedValue({
        data: { elements: [{}] },
      });

      const result = await service.getPersonalFollowerCount('token');

      expect(result).toBe(0);
    });

    it('should throw error on API failure', async () => {
      const axiosError = {
        response: { status: 401, data: { message: 'Unauthorized' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.get.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(service.getPersonalFollowerCount('invalid-token')).rejects.toThrow(
        'LinkedIn access token expired or invalid'
      );
    });
  });

  describe('getPersonalPostAnalytics', () => {
    describe('per-post analytics', () => {
      it('should fetch analytics for a specific share post URN', async () => {
        // Mock responses for each metric
        mockClient.get
          .mockResolvedValueOnce({ data: { elements: [{ count: 100 }] } }) // IMPRESSION
          .mockResolvedValueOnce({ data: { elements: [{ count: 80 }] } })  // MEMBERS_REACHED
          .mockResolvedValueOnce({ data: { elements: [{ count: 25 }] } })  // REACTION
          .mockResolvedValueOnce({ data: { elements: [{ count: 10 }] } })  // COMMENT
          .mockResolvedValueOnce({ data: { elements: [{ count: 5 }] } });  // RESHARE

        const result = await service.getPersonalPostAnalytics('token', {
          postUrn: 'urn:li:share:123456',
        });

        expect(mockClient.get).toHaveBeenCalledTimes(5);
        expect(result).toEqual({
          impression: 100,
          members_reached: 80,
          reaction: 25,
          comment: 10,
          reshare: 5,
        });
      });

      it('should fetch analytics for a UGC post URN', async () => {
        mockClient.get
          .mockResolvedValueOnce({ data: { elements: [{ count: 50 }] } })
          .mockResolvedValueOnce({ data: { elements: [{ count: 40 }] } })
          .mockResolvedValueOnce({ data: { elements: [{ count: 15 }] } })
          .mockResolvedValueOnce({ data: { elements: [{ count: 5 }] } })
          .mockResolvedValueOnce({ data: { elements: [{ count: 2 }] } });

        const result = await service.getPersonalPostAnalytics('token', {
          postUrn: 'urn:li:ugcPost:789',
        });

        expect(result.impression).toBe(50);
        expect(result.reaction).toBe(15);
      });

      it('should throw error for invalid post URN format', async () => {
        await expect(
          service.getPersonalPostAnalytics('token', {
            postUrn: 'invalid:urn:format',
          })
        ).rejects.toThrow('Invalid post URN format');
      });

      it('should return 0 for metrics that fail to fetch', async () => {
        mockClient.get
          .mockResolvedValueOnce({ data: { elements: [{ count: 100 }] } }) // IMPRESSION success
          .mockRejectedValueOnce(new Error('API error')) // MEMBERS_REACHED fails
          .mockResolvedValueOnce({ data: { elements: [] } }) // REACTION empty
          .mockResolvedValueOnce({ data: { elements: [{ count: 5 }] } }) // COMMENT success
          .mockRejectedValueOnce(new Error('Rate limit')); // RESHARE fails

        const result = await service.getPersonalPostAnalytics('token', {
          postUrn: 'urn:li:share:123',
        });

        expect(result.impression).toBe(100);
        expect(result.members_reached).toBe(0); // Error fallback
        expect(result.reaction).toBe(0); // Empty elements
        expect(result.comment).toBe(5);
        expect(result.reshare).toBe(0); // Error fallback
      });
    });

    describe('aggregated analytics', () => {
      it('should fetch aggregated analytics with default date range (30 days)', async () => {
        mockClient.get
          .mockResolvedValueOnce({ data: { elements: [{ count: 5000 }] } }) // IMPRESSION
          .mockResolvedValueOnce({ data: { elements: [{ count: 3000 }] } }); // MEMBERS_REACHED

        const result = await service.getPersonalPostAnalytics('token');

        expect(mockClient.get).toHaveBeenCalledTimes(2);
        expect(result.impression).toBe(5000);
        expect(result.members_reached).toBe(3000);
      });

      it('should fetch aggregated analytics with custom date range', async () => {
        mockClient.get
          .mockResolvedValueOnce({ data: { elements: [{ count: 1000 }] } })
          .mockResolvedValueOnce({ data: { elements: [{ count: 800 }] } });

        const startDate = new Date('2025-01-01');
        const endDate = new Date('2025-01-15');

        const result = await service.getPersonalPostAnalytics('token', {
          startDate,
          endDate,
        });

        // Verify the URL contains the date range
        const callArgs = mockClient.get.mock.calls[0];
        expect(callArgs[0]).toContain('dateRange');
        expect(result.impression).toBe(1000);
      });

      it('should aggregate multiple elements in response', async () => {
        mockClient.get
          .mockResolvedValueOnce({
            data: { elements: [{ count: 100 }, { count: 200 }, { count: 300 }] },
          })
          .mockResolvedValueOnce({
            data: { elements: [{ count: 50 }, { count: 150 }] },
          });

        const result = await service.getPersonalPostAnalytics('token');

        expect(result.impression).toBe(600); // 100 + 200 + 300
        expect(result.members_reached).toBe(200); // 50 + 150
      });

      it('should return 0 for missing elements', async () => {
        mockClient.get
          .mockResolvedValueOnce({ data: {} }) // No elements property
          .mockResolvedValueOnce({ data: { elements: null } }); // Null elements

        const result = await service.getPersonalPostAnalytics('token');

        expect(result.impression).toBe(0);
        expect(result.members_reached).toBe(0);
      });
    });
  });

  describe('createComment', () => {
    it('should create a comment on a post with correct payload', async () => {
      mockClient.post.mockResolvedValue({
        data: { commentUrn: 'urn:li:comment:(urn:li:share:123,456)' },
        headers: { 'x-restli-id': 'urn:li:comment:(urn:li:share:123,456)' },
      });

      const result = await service.createComment('token', 'urn:li:share:123', 'urn:li:person:abc', 'Great post!');

      expect(mockClient.post).toHaveBeenCalledWith(
        `/rest/socialActions/${encodeURIComponent('urn:li:share:123')}/comments`,
        {
          actor: 'urn:li:person:abc',
          object: 'urn:li:share:123',
          message: {
            text: 'Great post!'
          }
        },
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:comment:(urn:li:share:123,456)');
    });

    it('should create a comment on behalf of organization', async () => {
      mockClient.post.mockResolvedValue({
        data: { commentUrn: 'urn:li:comment:(urn:li:ugcPost:789,101)' },
        headers: { 'x-restli-id': 'urn:li:comment:(urn:li:ugcPost:789,101)' },
      });

      const result = await service.createComment('token', 'urn:li:ugcPost:789', 'urn:li:organization:123', 'Insightful!');

      expect(mockClient.post).toHaveBeenCalledWith(
        `/rest/socialActions/${encodeURIComponent('urn:li:ugcPost:789')}/comments`,
        {
          actor: 'urn:li:organization:123',
          object: 'urn:li:ugcPost:789',
          message: {
            text: 'Insightful!'
          }
        },
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:comment:(urn:li:ugcPost:789,101)');
    });

    it('should return commentUrn from response body if header not present', async () => {
      mockClient.post.mockResolvedValue({
        data: { commentUrn: 'urn:li:comment:(urn:li:share:111,222)' },
        headers: {},
      });

      const result = await service.createComment('token', 'urn:li:share:111', 'urn:li:person:xyz', 'Comment text');

      expect(result).toBe('urn:li:comment:(urn:li:share:111,222)');
    });

    it('should handle 401 error for expired token', async () => {
      const axiosError = {
        response: { status: 401, data: { message: 'Unauthorized' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.post.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(
        service.createComment('expired-token', 'urn:li:share:123', 'urn:li:person:abc', 'Comment')
      ).rejects.toThrow('LinkedIn access token expired or invalid');
    });

    it('should handle 403 error for permission denied', async () => {
      const axiosError = {
        response: { status: 403, data: { message: 'Permission denied' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.post.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(
        service.createComment('token', 'urn:li:share:123', 'urn:li:person:abc', 'Comment')
      ).rejects.toThrow('LinkedIn Permission Denied');
    });

    it('should handle 429 rate limit error', async () => {
      const axiosError = {
        response: { status: 429, data: { message: 'Too Many Requests' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.post.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(
        service.createComment('token', 'urn:li:share:123', 'urn:li:person:abc', 'Comment')
      ).rejects.toThrow('LinkedIn rate limit exceeded');
    });
  });

  describe('createReaction', () => {
    it('should create a LIKE reaction on a post', async () => {
      mockClient.post.mockResolvedValue({
        data: { id: 'urn:li:reaction:(urn:li:person:abc,urn:li:share:123)' },
        headers: { 'x-restli-id': 'urn:li:reaction:(urn:li:person:abc,urn:li:share:123)' },
      });

      const result = await service.createReaction('token', 'urn:li:share:123', 'urn:li:person:abc', 'LIKE');

      expect(mockClient.post).toHaveBeenCalledWith(
        `/rest/reactions?actor=${encodeURIComponent('urn:li:person:abc')}`,
        {
          root: 'urn:li:share:123',
          reactionType: 'LIKE'
        },
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:reaction:(urn:li:person:abc,urn:li:share:123)');
    });

    it('should create a PRAISE reaction on behalf of organization', async () => {
      mockClient.post.mockResolvedValue({
        data: { id: 'urn:li:reaction:(urn:li:organization:123,urn:li:ugcPost:789)' },
        headers: { 'x-restli-id': 'urn:li:reaction:(urn:li:organization:123,urn:li:ugcPost:789)' },
      });

      const result = await service.createReaction('token', 'urn:li:ugcPost:789', 'urn:li:organization:123', 'PRAISE');

      expect(mockClient.post).toHaveBeenCalledWith(
        `/rest/reactions?actor=${encodeURIComponent('urn:li:organization:123')}`,
        {
          root: 'urn:li:ugcPost:789',
          reactionType: 'PRAISE'
        },
        { headers: { Authorization: 'Bearer token' } }
      );
      expect(result).toBe('urn:li:reaction:(urn:li:organization:123,urn:li:ugcPost:789)');
    });

    it('should support all reaction types', async () => {
      const reactionTypes = ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'] as const;

      for (const reactionType of reactionTypes) {
        mockClient.post.mockResolvedValue({
          data: { id: `urn:li:reaction:(urn:li:person:abc,urn:li:share:123)` },
          headers: { 'x-restli-id': `urn:li:reaction:(urn:li:person:abc,urn:li:share:123)` },
        });

        const result = await service.createReaction('token', 'urn:li:share:123', 'urn:li:person:abc', reactionType);

        expect(mockClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            reactionType: reactionType
          }),
          expect.any(Object)
        );
        expect(result).toBeTruthy();
      }
    });

    it('should use LIKE as default reaction type', async () => {
      mockClient.post.mockResolvedValue({
        data: { id: 'urn:li:reaction:(urn:li:person:abc,urn:li:share:123)' },
        headers: { 'x-restli-id': 'urn:li:reaction:(urn:li:person:abc,urn:li:share:123)' },
      });

      await service.createReaction('token', 'urn:li:share:123', 'urn:li:person:abc');

      expect(mockClient.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          reactionType: 'LIKE'
        }),
        expect.any(Object)
      );
    });

    it('should return id from response body if header not present', async () => {
      mockClient.post.mockResolvedValue({
        data: { id: 'urn:li:reaction:(urn:li:person:xyz,urn:li:share:111)' },
        headers: {},
      });

      const result = await service.createReaction('token', 'urn:li:share:111', 'urn:li:person:xyz', 'EMPATHY');

      expect(result).toBe('urn:li:reaction:(urn:li:person:xyz,urn:li:share:111)');
    });

    it('should handle 401 error for expired token', async () => {
      const axiosError = {
        response: { status: 401, data: { message: 'Unauthorized' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.post.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(
        service.createReaction('expired-token', 'urn:li:share:123', 'urn:li:person:abc', 'LIKE')
      ).rejects.toThrow('LinkedIn access token expired or invalid');
    });

    it('should handle 403 error for permission denied', async () => {
      const axiosError = {
        response: { status: 403, data: { message: 'Permission denied' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.post.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(
        service.createReaction('token', 'urn:li:share:123', 'urn:li:person:abc', 'INTEREST')
      ).rejects.toThrow('LinkedIn Permission Denied');
    });

    it('should handle 429 rate limit error', async () => {
      const axiosError = {
        response: { status: 429, data: { message: 'Too Many Requests' } },
        isAxiosError: true,
        message: 'Request failed',
      };
      mockClient.post.mockRejectedValue(axiosError);
      ((axios as any).isAxiosError as jest.Mock).mockReturnValue(true);

      await expect(
        service.createReaction('token', 'urn:li:share:123', 'urn:li:person:abc', 'LIKE')
      ).rejects.toThrow('LinkedIn rate limit exceeded');
    });
  });
});
