import axios from 'axios';
import {
  LinkedInProfile,
  LinkedInPost,
  LinkedInAclResponse,
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
      timeout: 15000, // 15 second timeout
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

      console.error(`LinkedIn API Error [${status}]: ${message}`, JSON.stringify(error.response?.data, null, 2));

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
   * Refresh an expired access token using the refresh token
   * @param refreshToken - The refresh token from initial OAuth
   * @param clientId - LinkedIn app client ID
   * @param clientSecret - LinkedIn app client secret
   * @returns New access token and expiry information
   */
  async refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  }> {
    try {
      const response = await axios.post(
        'https://www.linkedin.com/oauth/v2/accessToken',
        null,
        {
          params: {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 15000,
        }
      );

      console.log('[LinkedIn] Token refreshed successfully');
      const data = response.data as { access_token: string; expires_in: number; refresh_token?: string };
      return {
        access_token: data.access_token,
        expires_in: data.expires_in,
        refresh_token: data.refresh_token, // LinkedIn may issue a new refresh token
      };
    } catch (error: any) {
      console.error('[LinkedIn] Token refresh failed:', error.response?.data || error.message);
      throw new Error('LinkedIn token refresh failed. Please reconnect your account.');
    }
  }

  /**
   * Get current user profile using /v2/me endpoint
   * Note: We use /v2/me instead of /v2/userinfo because OpenID scopes
   * (openid, profile, email) cannot be used with Community Management API scopes
   */
  async getProfile(accessToken: string): Promise<LinkedInProfile> {
    return this.safeRequest(async () => {
      const response = await this.client.get<any>('/v2/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      // Transform /v2/me response to match LinkedInProfile interface
      const data = response.data;
      return {
        sub: data.id, // Member ID from /v2/me
        name: `${data.localizedFirstName || ''} ${data.localizedLastName || ''}`.trim(),
        given_name: data.localizedFirstName || '',
        family_name: data.localizedLastName || '',
        picture: '', // /v2/me doesn't include profile picture
        locale: '', // /v2/me doesn't include locale
        email: '', // Email requires separate API call or r_emailaddress scope
        email_verified: false,
      };
    });
  }

  /**
   * Get profile picture URL for the authenticated user
   * Uses /v2/me with profilePicture projection
   */
  async getProfilePicture(accessToken: string): Promise<string | null> {
    return this.safeRequest(async () => {
      try {
        const response = await this.client.get<any>('/v2/me', {
          params: {
            projection: '(id,profilePicture(displayImage~:playableStreams))'
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const displayImage = response.data?.profilePicture?.['displayImage~'];
        const elements = displayImage?.elements;

        if (elements && elements.length > 0) {
          // Get the largest image
          const largestImage = elements[elements.length - 1];
          return largestImage?.identifiers?.[0]?.identifier || null;
        }

        return null;
      } catch (error) {
        console.warn('[LinkedIn] Failed to fetch profile picture:', error);
        return null;
      }
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
   * Note: LinkedIn requires URL-encoded URNs and FINDER header
   */
  async getFollowerStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInFollowerStatistics[]> {
    return this.safeRequest(async () => {


      const encodedUrn = encodeURIComponent(organizationUrn);
      const queryString = `q=organizationalEntity&organizationalEntity=${encodedUrn}`;


      const response = await this.client.get<{ elements: LinkedInFollowerStatistics[] }>(
        `/rest/organizationalEntityFollowerStatistics?${queryString}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-RestLi-Method': 'FINDER'
          }
        }
      );

      return response.data.elements;
    });
  }



  /**
   * Analytics: Get page statistics for an organization urn:li:organization:{PAGE_URN_ID}
   * Note: LinkedIn requires URL-encoded URNs and FINDER header
   */
  async getPageStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInPageStatistics[]> {
    return this.safeRequest(async () => {


      const encodedUrn = encodeURIComponent(organizationUrn);
      const queryString = `q=organization&organization=${encodedUrn}`;


      const response = await this.client.get<{ elements: LinkedInPageStatistics[] }>(
        `/rest/organizationPageStatistics?${queryString}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-RestLi-Method': 'FINDER'
          }
        }
      );

      return response.data.elements;
    });
  }

  /**
   * Post Metrics: Get share statistics for an organization's entity or specific shares
   * Note: LinkedIn requires URL-encoded URNs and FINDER header
   */
  async getShareStatistics(
    accessToken: string,
    organizationUrn: string,
    shareUrns?: string[]
  ): Promise<LinkedInShareStatistics[]> {
    return this.safeRequest(async () => {


      // Build URL manually to ensure proper encoding
      const encodedOrgUrn = encodeURIComponent(organizationUrn);
      let queryString = `q=organizationalEntity&organizationalEntity=${encodedOrgUrn}`;

      if (shareUrns && shareUrns.length > 0) {
        const encodedShares = shareUrns.map(urn => encodeURIComponent(urn)).join(',');
        queryString += `&shares=List(${encodedShares})`;
      }



      const response = await this.client.get<{ elements: LinkedInShareStatistics[] }>(
        `/rest/organizationalEntityShareStatistics?${queryString}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-RestLi-Method': 'FINDER'
          }
        }
      );


      return response.data.elements;
    });
  }


  /**
   * List posts for a specific author (person or organization)
   * Note: LinkedIn Versioned Posts API requires X-RestLi-Method: FINDER header
   * and URL-encoded author URN (colons must be encoded)
   */
  async listPosts(accessToken: string, authorUrn: string, start: number = 0, count: number = 50): Promise<LinkedInPaginatedResponse<LinkedInPost>> {
    return this.safeRequest(async () => {


      // Count must be <= 100
      const safeCount = Math.min(count, 100);

      // Build URL manually to ensure proper encoding (axios doesn't encode colons by default)
      const encodedAuthor = encodeURIComponent(authorUrn);
      const queryString = `q=author&author=${encodedAuthor}&start=${start}&count=${safeCount}&sortBy=LAST_MODIFIED`;


      try {
        const response = await this.client.get<LinkedInPaginatedResponse<LinkedInPost>>(`/rest/posts?${queryString}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-RestLi-Method': 'FINDER'  // Required for finder endpoints
          },
        });

        return response.data;
      } catch (error: any) {
        // Log the actual request URL for debugging
        console.error('[LinkedIn] listPosts request failed. Config:', {
          url: error.config?.url,
          fullUrl: error.request?.path || 'unknown'
        });
        throw error;
      }
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

      const postUrn = response.headers['x-restli-id'] || (response.data as any).id;


      // LinkedIn Versioned API returns the URN in the x-restli-id header
      return postUrn;
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
    const [followerStats, pageStats, shareStats] = await Promise.all([
      this.getFollowerStatistics(accessToken, organizationUrn),
      this.getPageStatistics(accessToken, organizationUrn),
      this.getShareStatistics(accessToken, organizationUrn)
    ]);

    return {
      followerStatistics: followerStats,
      pageStatistics: pageStats,
      shareStatistics: shareStats
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
    // Defensive check: ensure orgUrn is a valid string
    if (!orgUrn || typeof orgUrn !== 'string') {
      throw new Error(`Invalid organization URN: ${orgUrn}`);
    }
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
   * Uses the networkSizes API as per LinkedIn docs:
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api#retrieve-organization-follower-count
   */
  async getOrganizationFollowerCount(accessToken: string, orgUrn: string): Promise<number> {
    try {
      // Format: GET /rest/networkSizes/{orgUrn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER
      // Note: For versions >= 202305, use COMPANY_FOLLOWED_BY_MEMBER (all caps)
      // URL-encode the URN to handle colons in the path
      const encodedUrn = encodeURIComponent(orgUrn);
      const response = await this.client.get(`/rest/networkSizes/${encodedUrn}`, {
        params: { edgeType: 'COMPANY_FOLLOWED_BY_MEMBER' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      return (response.data as any).firstDegreeSize || 0;
    } catch (error: any) {
      console.warn('[LinkedIn] Failed to get follower count:', error.response?.status, error.response?.data || error.message);
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

  /**
   * Get follower count for personal profile
   * Uses the memberFollowersCount API endpoint
   */
  async getPersonalFollowerCount(accessToken: string): Promise<number> {
    return this.safeRequest(async () => {
      const response = await this.client.get<{ elements: Array<{ memberFollowersCount: number }> }>(
        '/rest/memberFollowersCount',
        {
          params: { q: 'me' },
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      const followers = response.data.elements?.[0]?.memberFollowersCount || 0;
      return followers;
    });
  }

  /**
   * Get analytics for personal profile posts
   * - If postUrn is provided: Returns detailed metrics for that specific post
   * - If no postUrn: Returns aggregated metrics for a date range
   * 
   * @param accessToken - OAuth access token
   * @param options - Optional configuration
   * @param options.postUrn - Post URN for per-post analytics (e.g., "urn:li:share:123" or "urn:li:ugcPost:456")
   * @param options.startDate - Start date for aggregated analytics (defaults to 30 days ago)
   * @param options.endDate - End date for aggregated analytics (defaults to today)
   */
  async getPersonalPostAnalytics(
    accessToken: string,
    options?: {
      postUrn?: string;
      startDate?: Date;
      endDate?: Date;
    }
  ): Promise<{
    impression: number;
    members_reached: number;
    reaction?: number;
    comment?: number;
    reshare?: number;
  }> {
    return this.safeRequest(async () => {
      // If postUrn is provided, fetch per-post analytics
      if (options?.postUrn) {
        const postUrn = options.postUrn;

        // Determine entity type from URN
        let entityParam: string;
        if (postUrn.startsWith('urn:li:share:')) {
          entityParam = `(share:${encodeURIComponent(postUrn)})`;
        } else if (postUrn.startsWith('urn:li:ugcPost:')) {
          entityParam = `(ugc:${encodeURIComponent(postUrn)})`;
        } else {
          throw new Error('Invalid post URN format. Must be urn:li:share: or urn:li:ugcPost:');
        }

        const metrics = ['IMPRESSION', 'MEMBERS_REACHED', 'REACTION', 'COMMENT', 'RESHARE'];
        const analyticsData: any = {};

        for (const metric of metrics) {
          const url = `/rest/memberCreatorPostAnalytics?q=entity&entity=${entityParam}&queryType=${metric}&aggregation=TOTAL`;

          try {
            const response = await this.client.get<{ elements: Array<{ count: number }> }>(url, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });

            const totalCount = response.data.elements?.reduce((sum, el) => sum + (el.count || 0), 0) || 0;
            analyticsData[metric.toLowerCase()] = totalCount;
          } catch (error) {
            console.warn(`[LinkedIn] Failed to fetch ${metric} for post ${postUrn}:`, error);
            analyticsData[metric.toLowerCase()] = 0;
          }
        }

        return analyticsData;
      }

      // Otherwise, fetch aggregated analytics for date range
      const end = options?.endDate || new Date();
      const start = options?.startDate || new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      // Build date range parameter
      const dateRange = `(start:(day:${start.getDate()},month:${start.getMonth() + 1},year:${start.getFullYear()}),end:(day:${end.getDate()},month:${end.getMonth() + 1},year:${end.getFullYear()}))`;

      const metrics = ['IMPRESSION', 'MEMBERS_REACHED'];
      const analyticsData: any = {};

      for (const metric of metrics) {
        const url = `/rest/memberCreatorPostAnalytics?q=me&queryType=${metric}&aggregation=TOTAL&dateRange=${dateRange}`;

        try {
          const response = await this.client.get<{ elements: Array<{ count: number }> }>(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          const totalCount = response.data.elements?.reduce((sum, el) => sum + (el.count || 0), 0) || 0;
          analyticsData[metric.toLowerCase()] = totalCount;
        } catch (error) {
          console.warn(`[LinkedIn] Failed to fetch ${metric}:`, error);
          analyticsData[metric.toLowerCase()] = 0;
        }
      }

      return analyticsData;
    });
  }
}

export const linkedInService = new LinkedInService();