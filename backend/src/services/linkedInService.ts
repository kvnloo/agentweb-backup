
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
}

export const linkedInService = new LinkedInService();
