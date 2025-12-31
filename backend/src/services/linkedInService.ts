
import axios from 'axios';
import type { AxiosInstance, AxiosError } from 'axios';
import { 
  LinkedInProfile, 
  LinkedInPost, 
  LinkedInErrorResponse, 
  LinkedInAclResponse,
  LinkedInOrganizationAcl,
  LinkedInFollowerStatistics,
  LinkedInPageStatistics,
  LinkedInShareStatistics
} from '../types/linkedIn';

export class LinkedInService {
  private client: AxiosInstance;

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
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<LinkedInErrorResponse>;
      const status = axiosError.response?.status;
      const message = axiosError.response?.data?.message || axiosError.message;
      
      console.error(`LinkedIn API Error [${status}]: ${message}`, axiosError.response?.data);

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
   * Get current user profile (OpenID Connect userinfo endpoint)
   * Note: This endpoint does NOT use the versioned REST API headers
   */
  async getProfile(accessToken: string): Promise<LinkedInProfile> {
    try {
      console.log('[LinkedIn getProfile] Fetching profile with token:', accessToken?.substring(0, 20) + '...');
      
      // Use direct axios call without versioned API headers for OIDC userinfo
      const response = await axios.get<LinkedInProfile>('https://api.linkedin.com/v2/userinfo', {
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000, // 10 second timeout
      });
      
      console.log('[LinkedIn getProfile] Success:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('[LinkedIn getProfile] Full raw error:', error);
      console.error('[LinkedIn getProfile] Error name:', error.name);
      console.error('[LinkedIn getProfile] Error code:', error.code);
      console.error('[LinkedIn getProfile] Error message:', error.message);
      console.error('[LinkedIn getProfile] Is Axios error:', axios.isAxiosError(error));
      
      if (axios.isAxiosError(error)) {
        console.error('[LinkedIn getProfile] Axios error details:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          config: error.config?.url,
        });
      }
      
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Discovery: Get organizations where the user has an admin role
   */
  async getAdminOrganizations(accessToken: string): Promise<string[]> {
    return this.safeRequest(async () => {
      const response = await this.client.get<LinkedInAclResponse>('/rest/organizationAcls', {
        params: { q: 'role', role: 'ADMINISTRATOR', state: 'APPROVED' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data.elements.map((acl: LinkedInOrganizationAcl) => acl.organization);
    });
  }

  /**
   * Analytics: Get follower statistics for an organization
   */
  async getFollowerStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInFollowerStatistics[]> {
    return this.safeRequest(async () => {
      const response = await this.client.get<{ elements: LinkedInFollowerStatistics[] }>('/rest/organizationalEntityFollowerStatistics', {
        params: { organizationalEntity: organizationUrn },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data.elements;
    });
  }

  /**
   * Analytics: Get page statistics for an organization
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
   * Post Metrics: Get share statistics for an organization's entity
   */
  async getShareStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInShareStatistics[]> {
    return this.safeRequest(async () => {
      const response = await this.client.get<{ elements: LinkedInShareStatistics[] }>('/rest/organizationalEntityShareStatistics', {
        params: { organizationalEntity: organizationUrn },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data.elements;
    });
  }

  /**
   * List posts for a specific author (person or organization)
   */
  async listPosts(accessToken: string, authorUrn: string): Promise<LinkedInPost[]> {
    return this.safeRequest(async () => {
      const response = await this.client.get<{ elements: LinkedInPost[] }>('/rest/posts', {
        params: { q: 'author', author: authorUrn },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data.elements;
    });
  }

  /**
   * Create a post (Versioned Post API)
   * Handles both Personal and Organization posts based on authorUrn
   */
  async createPost(accessToken: string, authorUrn: string, text: string): Promise<string> {
    return this.safeRequest(async () => {
      const payload: LinkedInPost = {
        author: authorUrn,
        commentary: text,
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        distribution: {
          feedDistribution: 'MAIN_FEED'
        }
      };

      const response = await this.client.post('/rest/posts', payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      // LinkedIn Versioned API returns the URN in the x-restli-id header
      return response.headers['x-restli-id'] || (response.data as any).id;
    });
  }

  /**
   * Verify if an access token is still valid
   * Uses the lightweight userinfo endpoint for personal tokens
   * @returns Object with valid status and optional error message
   */
  async verifyToken(accessToken: string): Promise<{ valid: boolean; error?: string }> {
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
      // Network error - assume valid (might be temporary issue)
      console.warn('[LinkedIn verifyToken] Network error, assuming valid:', error.code || error.message);
      return { valid: true };
    }
  }

  /**
   * Get organization details by URN
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
      // Extract numeric ID from URN
      const orgId = orgUrn.replace('urn:li:organization:', '');
      
      const response = await this.client.get(`/rest/organizations/${orgId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          projection: '(id,name,vanityName,logoV2)'
        }
      });

      const data = response.data;
      return {
        id: data.id || orgId,
        name: data.name?.localized?.en_US || data.localizedName || `Organization ${orgId}`,
        vanityName: data.vanityName,
        logoUrl: data.logoV2?.original || data.logoV2?.['cropped-mini'] || undefined,
      };
    });
  }

  /**
   * Get follower count for an organization
   * @param accessToken - OAuth token with organization scopes
   * @param orgUrn - Organization URN
   */
  async getOrganizationFollowerCount(accessToken: string, orgUrn: string): Promise<number> {
    try {
      const response = await this.client.get('/rest/networkSizes/' + orgUrn, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { edgeType: 'CompanyFollowedByMember' }
      });
      return response.data.firstDegreeSize || 0;
    } catch (error) {
      console.warn('[LinkedIn] Failed to get follower count:', error);
      return 0;
    }
  }
}

export const linkedInService = new LinkedInService();

