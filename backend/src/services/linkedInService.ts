import axios from 'axios';
import {
  LinkedInProfile,
  LinkedInPost,
  LinkedInErrorResponse,
  LinkedInAclResponse,
  LinkedInOrganizationAcl,
  LinkedInFollowerStatistics,
  LinkedInPageStatistics,
  LinkedInShareStatistics,
  LinkedInPaginatedResponse
} from '../types/linkedIn';

export class LinkedInService {
  private client: ReturnType<typeof axios.create>;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.linkedin.com',
      headers: {
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202511',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Safe request wrapper to handle errors
   */
  private async safeRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error: any) {
      this.handleError(error);
      throw error; // unreachable
    }
  }

  private handleError(error: any): void {
    if (error.isAxiosError || error.response) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      
      console.error(`LinkedIn API Error [${status}]: ${message}`, error.response?.data);

      if (status === 401) {
        throw new Error('LinkedIn access token expired or invalid');
      }
      if (status === 403) {
        throw new Error('LinkedIn Permission Denied: You might not have administrator access to this organization or are missing required scopes (rw_organization_admin / r_organization_social)');
      }
      if (status === 429) {
        throw new Error('LinkedIn rate limit exceeded');
      }
      
      throw new Error(`LinkedIn Error: ${message}`);
    }
    throw error;
  }

  /**
   * Get current user profile
   */
  async getProfile(accessToken: string): Promise<LinkedInProfile> {
    return this.safeRequest(async () => {
      const response = await this.client.get<LinkedInProfile>('/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data;
    });
  }

  /**
   * Discovery: Get organizations where the user has an admin role
   */
  async getAdminOrganizations(accessToken: string): Promise<LinkedInAclResponse> {
    return this.safeRequest(async () => {
      const response = await this.client.get<LinkedInAclResponse>('/rest/organizationAcls', {
        params: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data;
    });
  }

  /**
   * Analytics: Get follower statistics for an organization
   */
  async getFollowerStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInFollowerStatistics[]> {
    return this.safeRequest(async () => {
      const response = await this.client.get<{ elements: LinkedInFollowerStatistics[] }>('/rest/organizationalEntityFollowerStatistics', {
        params: { q: 'organizationalEntity', organizationalEntity: organizationUrn },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data.elements;
    });
  }

  /**
   * Analytics: Get page statistics for an organization urn:li:organization:{PAGE_URN_ID}
   */
  async getPageStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInPageStatistics[]> {
    return this.safeRequest(async () => {
      const response = await this.client.get<{ elements: LinkedInPageStatistics[] }>('/rest/organizationPageStatistics', {
        params: { q: 'organization', organization: organizationUrn },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data.elements;
    });
  }

  /**
   * Post Metrics: Get share statistics for an organization's entity or specific shares
   */
  async getShareStatistics(
    accessToken: string,
    organizationUrn: string,
    shareUrns?: string[]
  ): Promise<LinkedInShareStatistics[]> {
    return this.safeRequest(async () => {
      const params: any = { q: 'organizationalEntity', organizationalEntity: organizationUrn };
      if (shareUrns && shareUrns.length > 0) {
        params.shares = `List(${shareUrns.join(',')})`;
      }

      const response = await this.client.get<{ elements: LinkedInShareStatistics[] }>(
        '/rest/organizationalEntityShareStatistics',
        { params, headers: { Authorization: `Bearer ${accessToken}` } }
      );

      return response.data.elements;
    });
  }
  /**
   * List posts for a specific author (person or organization)
   */
  async listPosts(accessToken: string, authorUrn: string, start: number = 0, count: number = 50): Promise<LinkedInPaginatedResponse<LinkedInPost>> {
    return this.safeRequest(async () => {
      const response = await this.client.get<LinkedInPaginatedResponse<LinkedInPost>>('/rest/posts', {
        params: { q: 'author', author: authorUrn, start, count },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data;
    });
  }

  /**
   * Create a post (Versioned Post API)
   * Handles both Personal and Organization posts based on authorUrn
   */
  async createPost(accessToken: string, authorUrn: string, text: string, imageUrns?: string[]): Promise<string> {
    return this.safeRequest(async () => {
      const payload: any = {
        author: authorUrn,
        commentary: text,
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        distribution: {
          feedDistribution: 'MAIN_FEED'
        }
      };

      // Add media content if images are provided
      if (imageUrns && imageUrns.length > 0) {
        if (imageUrns.length === 1) {
          // Single image - use 'image' content type
          payload.content = {
            media: {
              id: imageUrns[0]
            }
          };
        } else {
          // Multiple images (2-20) - use 'multiImage' content type
          payload.content = {
            multiImage: {
              images: imageUrns.map(urn => ({ id: urn }))
            }
          };
        }
      }

      const response = await this.client.post('/rest/posts', payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      // LinkedIn Versioned API returns the URN in the x-restli-id header
      return response.headers['x-restli-id'] || (response.data as any).id;
    });
  }

  /**
   * Initialize image upload with LinkedIn
   * Step 1 of the 3-step image upload process
   */
  async initializeImageUpload(accessToken: string, ownerUrn: string): Promise<{
    uploadUrl: string;
    imageUrn: string;
  }> {
    return this.safeRequest(async () => {
      const response = await this.client.post('/rest/images?action=initializeUpload', {
        initializeUploadRequest: {
          owner: ownerUrn
        }
      }, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const data = (response.data as any).value;
      return {
        uploadUrl: data.uploadUrl,
        imageUrn: data.image
      };
    });
  }

  /**
   * Upload image binary to LinkedIn's upload URL
   * Step 2 of the 3-step image upload process
   */
  async uploadImageBinary(uploadUrl: string, imageBuffer: Buffer, contentType: string): Promise<void> {
    await axios.put(uploadUrl, imageBuffer, {
      headers: {
        'Content-Type': contentType,
      },
    } as any);
  }

  /**
   * Download image from URL and upload to LinkedIn
   * Combines steps 1 & 2 for convenience
   */
  async uploadImageFromUrl(accessToken: string, ownerUrn: string, imageUrl: string): Promise<string> {
    return this.safeRequest(async () => {
      // Download image from URL (e.g., S3)
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const imageBuffer = Buffer.from(imageResponse.data as ArrayBuffer);
      const contentType = imageResponse.headers['content-type'] || 'image/png';

      // Step 1: Initialize upload
      const { uploadUrl, imageUrn } = await this.initializeImageUpload(accessToken, ownerUrn);

      // Step 2: Upload binary
      await this.uploadImageBinary(uploadUrl, imageBuffer, contentType);

      console.log(`[LinkedIn] Image uploaded successfully: ${imageUrn}`);
      return imageUrn;
    });
  }


  /**
   * Aggregated Analytics: Get follower, page, and share statistics for an organization
   */
  async getAggregatedMetrics(accessToken: string, organizationUrn: string): Promise<any> {
    const [followerStats, pageStats] = await Promise.all([
      this.getFollowerStatistics(accessToken, organizationUrn),
      this.getPageStatistics(accessToken, organizationUrn)
    ]);

    return {
      followerStatistics: followerStats,
      pageStatistics: pageStats
    };
  }

  /**
   * Get organization details by URN (for Connected Accounts)
   * @param accessToken - OAuth token with organization scopes
   * @param orgUrn - Organization URN (e.g., "urn:li:organization:123456")
   */
  async getOrganization(accessToken: string, orgUrn: string): Promise<{
    id: string;
    name: string;
    vanityName?: string;
    logoUrl?: string;
  }> {
    return this.safeRequest(async () => {
      const orgId = orgUrn.replace('urn:li:organization:', '');
      
      const response = await this.client.get(`/rest/organizations/${orgId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const data = response.data as any;
      return {
        id: data.id?.toString() || orgId,
        name: data.localizedName || data.name?.localized?.en_US || `Organization ${orgId}`,
        vanityName: data.vanityName,
        logoUrl: data.logoV2?.original || data.logoV2?.['cropped-mini'] || undefined,
      };
    });
  }

  /**
   * Get follower count for an organization (for Connected Accounts)
   * Uses the networkSizes endpoint
   */
  async getOrganizationFollowerCount(accessToken: string, orgUrn: string): Promise<number> {
    try {
      const response = await this.client.get(`/rest/networkSizes/${orgUrn}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { edgeType: 'CompanyFollowedByMember' }
      });
      return (response.data as any).firstDegreeSize || 0;
    } catch (error) {
      console.warn('[LinkedIn] Failed to get follower count:', error);
      return 0;
    }
  }

  /**
   * Verify if an access token is still valid by making an API call
   * Uses the lightweight userinfo endpoint for personal tokens
   * @returns Object with valid status, optional error message, and uncertain flag (Fix #6)
   */
  async verifyToken(accessToken: string): Promise<{ valid: boolean; error?: string; uncertain?: boolean }> {
    try {
      await axios.get('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000,
      });
      return { valid: true };
    } catch (error: any) {
      if (error.response?.status === 401) {
        return { valid: false, error: 'Token expired or revoked' };
      }
      if (error.response?.status === 403) {
        return { valid: false, error: 'Token permissions revoked' };
      }
      // Network error - return uncertain state
      console.warn('[LinkedIn verifyToken] Network error:', error.code || error.message);
      return { valid: true, uncertain: true, error: 'Network error - could not verify token' };
    }
  }
}

export const linkedInService = new LinkedInService();