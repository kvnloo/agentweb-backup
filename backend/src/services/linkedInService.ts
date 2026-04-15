import axios from 'axios';
import {
  LinkedInProfile,
  LinkedInPost,
  LinkedInAclResponse,
  LinkedInFollowerStatistics,
  LinkedInFollowerGainStatistics,
  LinkedInFollowerStatisticsResult,
  AggregatedMetrics,
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
      const errorCode = error.response?.data?.error;
      const errorDescription = error.response?.data?.error_description || '';

      console.error(`LinkedIn API Error [${status}]: ${message}`, JSON.stringify(error.response?.data, null, 2));

      // Detect deactivated app (invalid_client error from OAuth)
      if (
        errorCode === 'invalid_client' ||
        errorDescription.includes('client') ||
        message?.includes('invalid_client')
      ) {
        throw new Error('The LinkedIn app used for authentication has been deactivated. Please reconnect your personal account with the new app.');
      }

      if (status === 401) {
        throw new Error('LinkedIn access token expired or invalid');
      }
      if (status === 403) {
        // Use actual LinkedIn error message - different APIs have different scope requirements
        const linkedInMessage = error.response?.data?.message || message || 'Access denied';
        throw new Error(`LinkedIn Permission Denied: ${linkedInMessage}`);
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
      
      // Detect deactivated app (invalid_client error)
      const errorCode = error.response?.data?.error;
      const errorDescription = error.response?.data?.error_description || '';
      if (
        errorCode === 'invalid_client' ||
        errorDescription.includes('client') ||
        errorDescription.includes('revoked') ||
        errorDescription.includes('invalid')
      ) {
        throw new Error('The LinkedIn app used for authentication has been deactivated. Please reconnect your personal account with the new app.');
      }
      
      throw new Error('LinkedIn token refresh failed. Please reconnect your account.');
    }
  }

  /**
   * Resolve a LinkedIn media URN to an actual downloadable URL
   * LinkedIn returns URNs like urn:li:digitalmediaAsset:xxx which need to be
   * converted to urn:li:image:xxx and resolved via the Images API
   */
  async resolveImageUrl(accessToken: string, mediaUrn: string): Promise<string | null> {
    if (!mediaUrn) return null;
    
    // If it's already an HTTPS URL, return as-is
    if (mediaUrn.startsWith('https://')) {
      return mediaUrn;
    }
    
    // Convert digitalmediaAsset URN to image URN if needed
    let imageUrn = mediaUrn;
    if (mediaUrn.includes('digitalmediaAsset')) {
      imageUrn = mediaUrn.replace('digitalmediaAsset', 'image');
    }
    
    // If not a valid URN format, return null
    if (!imageUrn.startsWith('urn:li:image:')) {
      console.warn('[LinkedIn] Cannot resolve non-image URN:', mediaUrn);
      return null;
    }
    
    try {
      const encodedUrn = encodeURIComponent(imageUrn);
      const response = await this.client.get(`/rest/images/${encodedUrn}`, {
        params: { fields: 'downloadUrl' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      
      return (response.data as any)?.downloadUrl || null;
    } catch (error: any) {
      console.warn('[LinkedIn] Failed to resolve image URL:', error.message);
      return null;
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
   * Discovery: Get detailed organization info for all admin organizations
   * Including logo, name, and follower count
   */
  async getAdminOrganizationDetails(accessToken: string): Promise<Array<{
    urn: string;
    id: string;
    name: string;
    vanityName?: string;
    logoUrl?: string;
    followerCount: number;
  }>> {
    try {
      const aclResponse = await this.getAdminOrganizations(accessToken);
      
      const orgUrns = aclResponse.elements
        .map(acl => (acl as any).organization || acl.organizationTarget)
        .filter((urn): urn is string => urn != null && typeof urn === 'string' && urn.length > 0);

      // Get details for each organization with retry logic
      const organizations = await Promise.all(
        orgUrns.map(async (orgUrn: string) => {
          const maxRetries = 2;
          let lastError: any;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const [orgDetails, followerCount] = await Promise.all([
                this.getOrganization(accessToken, orgUrn),
                this.getOrganizationFollowerCount(accessToken, orgUrn)
              ]);
              
              return {
                urn: orgUrn,
                id: orgDetails.id,
                name: orgDetails.name,
                vanityName: orgDetails.vanityName,
                logoUrl: orgDetails.logoUrl,
                followerCount,
              };
            } catch (err: any) {
              lastError = err;
              console.warn(`[LinkedInService] Attempt ${attempt}/${maxRetries} failed for org ${orgUrn}:`, err.message);
              
              // Wait before retry (exponential backoff)
              if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
              }
            }
          }
          
          // All retries exhausted - throw the error
          throw new Error(`Failed to fetch organization details for ${orgUrn} after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
        })
      );
      
      return organizations;
    } catch (error: any) {
      console.warn('[LinkedInService] Failed to fetch admin organizations:', error.message);
      return [];
    }
  }

  /**
   * Analytics: Get follower statistics for an organization
   * Note: LinkedIn requires URL-encoded URNs and FINDER header
   */
  async getFollowerStatistics(accessToken: string, organizationUrn: string, startDate?: Date, endDate?: Date): Promise<LinkedInFollowerStatisticsResult> {
    return this.safeRequest(async () => {
      const encodedUrn = encodeURIComponent(organizationUrn);
      let queryString = `q=organizationalEntity&organizationalEntity=${encodedUrn}`;

      if (startDate && endDate) {
        const start = startDate.getTime();
        const end = endDate.getTime();
        queryString += `&timeIntervals=(timeRange:(start:${start},end:${end}),timeGranularityType:DAY)`;
      }

      const response = await this.client.get<{ elements: LinkedInFollowerStatisticsResult }>(
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
  async getPageStatistics(accessToken: string, organizationUrn: string, startDate?: Date, endDate?: Date): Promise<LinkedInPageStatistics[]> {
    return this.safeRequest(async () => {
      const encodedUrn = encodeURIComponent(organizationUrn);
      let queryString = `q=organization&organization=${encodedUrn}`;

      if (startDate && endDate) {
        const start = startDate.getTime();
        const end = endDate.getTime();
        queryString += `&timeIntervals=(timeRange:(start:${start},end:${end}),timeGranularityType:DAY)`;
      }

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
    shareUrns?: string[],
    startDate?: Date,
    endDate?: Date
  ): Promise<LinkedInShareStatistics[]> {
    return this.safeRequest(async () => {

      // Build URL manually to ensure proper encoding
      const encodedOrgUrn = encodeURIComponent(organizationUrn);
      let queryString = `q=organizationalEntity&organizationalEntity=${encodedOrgUrn}`;

      if (shareUrns && shareUrns.length > 0) {
        const encodedShares = shareUrns.map(urn => encodeURIComponent(urn)).join(',');
        queryString += `&shares=List(${encodedShares})`;
      }

      if (startDate && endDate) {
        const start = startDate.getTime();
        const end = endDate.getTime();
        queryString += `&timeIntervals=(timeRange:(start:${start},end:${end}),timeGranularityType:DAY)`;
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
   * Get social metadata for an activity URN.
   * Works with urn:li:activity:... URNs — returns reaction/comment counts.
   * This is the only LinkedIn API that accepts activity URNs directly.
   */
  async getActivityMetadata(accessToken: string, activityUrn: string): Promise<{
    exists: boolean;
    likeCount: number;
    commentCount: number;
  }> {
    const encodedUrn = encodeURIComponent(activityUrn);
    try {
      const response = await this.client.get(`/rest/socialMetadata/${encodedUrn}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = response.data as any;
      // Sum all reaction types
      let likeCount = 0;
      if (data.reactionSummaries) {
        for (const key of Object.keys(data.reactionSummaries)) {
          likeCount += data.reactionSummaries[key]?.count ?? 0;
        }
      }
      const commentCount = data.commentSummary?.count ?? 0;
      return { exists: true, likeCount, commentCount };
    } catch (error: any) {
      if (error.response?.status === 404) {
        return { exists: false, likeCount: 0, commentCount: 0 };
      }
      this.handleError(error);
      return { exists: false, likeCount: 0, commentCount: 0 };
    }
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
  /**
   * Escape reserved characters for LinkedIn's 'little' text format.
   * The commentary field uses 'little' format where these characters are reserved:
   * | { } @ [ ] ( ) < > # \ * _ ~
   * Unescaped reserved chars cause LinkedIn to silently truncate the post text.
   * We preserve # unescaped so hashtags (#word) work as HashtagElements.
   */
  private escapeLinkedInLittle(text: string): string {
    // Backslash must be escaped first to avoid double-escaping
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/@/g, '\\@')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/</g, '\\<')
      .replace(/>/g, '\\>')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/~/g, '\\~');
  }

  /**
   * Extract a human-readable title from a URL path as fallback when OG metadata can't be fetched
   */
  private titleFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Get last meaningful path segment (ignore trailing slash)
      const segments = parsed.pathname.split('/').filter(Boolean);
      const slug = segments[segments.length - 1] || parsed.hostname;
      // Convert slug to title: replace hyphens/underscores with spaces, strip trailing date patterns, title case
      return slug
        .replace(/[-_]/g, ' ')
        .replace(/\s+\d{4}\s*\d{0,2}\s*\d{0,2}\s*$/, '') // strip trailing dates like "2026 02 12"
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim() || parsed.hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  /**
   * Fetch Open Graph metadata from a URL for link previews.
   * Uses facebookexternalhit UA (most widely whitelisted social crawler).
   * Falls back to readable title extracted from URL path for bot-protected sites.
   */
  private async fetchOgMetadata(url: string): Promise<{ title: string; description?: string; image?: string }> {
    const parseOg = (html: string) => {
      const getMetaContent = (property: string): string | undefined => {
        const regex = new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
        const match = html.match(regex);
        if (match) return match[1];
        const regex2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
        const match2 = html.match(regex2);
        return match2?.[1];
      };
      return {
        title: getMetaContent('og:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim(),
        description: getMetaContent('og:description'),
        image: getMetaContent('og:image'),
      };
    };

    // Try HTTP fetch with social crawler and browser UAs
    const userAgents = [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ];

    for (const ua of userAgents) {
      try {
        const response = await axios.get(url, {
          timeout: 10000,
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        const html = typeof response.data === 'string' ? response.data : '';
        const og = parseOg(html);
        if (og.title) {
          return { title: og.title, description: og.description, image: og.image };
        }
      } catch {
        // Will try next UA or fall through to browser fallback
      }
    }

    // Fallback: use headless browser to bypass bot protection (DataDome, Cloudflare, etc.)
    try {
      const puppeteer = await import('puppeteer-core');
      const chromePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
        '/usr/bin/google-chrome-stable',  // Linux (google-chrome)
        '/usr/bin/google-chrome',         // Linux (alt)
        '/usr/bin/chromium-browser',      // Linux (chromium)
        '/usr/bin/chromium',              // Linux (snap/alt)
      ];
      let executablePath: string | undefined;
      const fs = await import('fs');
      for (const p of chromePaths) {
        if (fs.existsSync(p)) { executablePath = p; break; }
      }
      if (executablePath) {
        const browser = await puppeteer.default.launch({
          executablePath,
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        });
        try {
          const page = await browser.newPage();
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          const og = await page.evaluate(() => {
            const getMeta = (prop: string) => {
              const el = document.querySelector(`meta[property="${prop}"]`);
              return el?.getAttribute('content') || undefined;
            };
            return {
              title: getMeta('og:title') || document.title || undefined,
              description: getMeta('og:description'),
              image: getMeta('og:image'),
            };
          });
          if (og.title) {
            return { title: og.title, description: og.description, image: og.image };
          }
        } finally {
          await browser.close();
        }
      }
    } catch (error) {
      console.error('[LinkedIn] Headless browser OG fetch failed:', error instanceof Error ? error.message : error);
    }

    // Final fallback: derive a readable title from the URL path
    return { title: this.titleFromUrl(url) };
  }

  async createPost(accessToken: string, authorUrn: string, text: string, imageUrns?: string[]): Promise<string> {
    return this.safeRequest(async () => {
      console.log('[LinkedIn] createPost called for author:', authorUrn);

      const payload: any = {
        author: authorUrn,
        commentary: this.escapeLinkedInLittle(text),
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
      } else {
        // No images - check if text contains a URL and add article content for link preview
        const urlMatch = text.match(/https?:\/\/[^\s)}\]]+/);
        if (urlMatch) {
          const articleUrl = urlMatch[0];
          console.log('[LinkedIn] Fetching OG metadata for:', articleUrl);
          // Race OG fetch against a timeout so it never blocks post creation for too long
          const ogPromise = this.fetchOgMetadata(articleUrl);
          let timeoutId: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<{ title: string; description?: string; image?: string }>((resolve) => {
            timeoutId = setTimeout(() => {
              console.log('[LinkedIn] OG metadata fetch timed out, using URL-derived title');
              resolve({ title: this.titleFromUrl(articleUrl) });
            }, 12000);
          });
          const og = await Promise.race([ogPromise, timeoutPromise]);
          clearTimeout(timeoutId!);
          console.log('[LinkedIn] OG metadata result - title:', og.title, ', hasImage:', !!og.image);
          const article: any = {
            source: articleUrl,
            title: og.title,
          };
          if (og.description) {
            article.description = og.description;
          }
          if (og.image) {
            try {
              const thumbnailUrn = await this.uploadImageFromUrl(accessToken, authorUrn, og.image);
              article.thumbnail = thumbnailUrn;
            } catch (err) {
              console.error('[LinkedIn] Failed to upload article thumbnail:', err instanceof Error ? err.message : err);
            }
          }
          payload.content = { article };
        }
      }



      console.log('[LinkedIn] Sending post to LinkedIn API - commentary length:', payload.commentary?.length, ', hasArticle:', !!payload.content?.article);
      const response = await this.client.post('/rest/posts', payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const postUrn = response.headers['x-restli-id'] || (response.data as any).id;
      console.log('[LinkedIn] Post created successfully:', postUrn);
      // Log if LinkedIn returned any response body (may contain modified content)
      if (response.data && Object.keys(response.data).length > 0) {
        const respCommentary = (response.data as any).commentary;
        if (respCommentary && respCommentary.length !== payload.commentary?.length) {
          console.error('[LinkedIn] WARNING: Response commentary length differs! Sent:', payload.commentary?.length, 'Received:', respCommentary.length);
        }
      }

      // LinkedIn Versioned API returns the URN in the x-restli-id header
      return postUrn;
    });
  }

  /**
   * Repost (reshare) an existing LinkedIn post, optionally with added commentary.
   * @param accessToken - OAuth access token
   * @param authorUrn - URN of the entity doing the repost (person or organization)
   * @param originalPostUrn - URN of the post to reshare (e.g., "urn:li:share:123" or "urn:li:ugcPost:456")
   * @param commentary - Optional text to add alongside the repost
   * @returns Repost URN
   */
  async createRepost(accessToken: string, authorUrn: string, originalPostUrn: string, commentary?: string): Promise<string> {
    return this.safeRequest(async () => {
      console.log('[LinkedIn] createRepost called for author:', authorUrn, 'original:', originalPostUrn);

      const payload: any = {
        author: authorUrn,
        reshareContext: { parent: originalPostUrn },
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        distribution: {
          feedDistribution: 'MAIN_FEED'
        }
      };

      if (commentary) {
        payload.commentary = this.escapeLinkedInLittle(commentary);
      }

      const response = await this.client.post('/rest/posts', payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const repostUrn = response.headers['x-restli-id'] || (response.data as any).id;
      console.log('[LinkedIn] Repost created successfully:', repostUrn);
      return repostUrn;
    });
  }

  /**
   * Create a comment on a LinkedIn post
   * @param accessToken - OAuth access token
   * @param postUrn - URN of the post to comment on (e.g., "urn:li:ugcPost:123" or "urn:li:share:456")
   * @param actorUrn - URN of the entity making the comment (person or organization)
   * @param commentText - The comment text content
   * @returns Comment URN
   */
  async createComment(
    accessToken: string,
    postUrn: string,
    actorUrn: string,
    commentText: string,
    parentCommentUrn?: string
  ): Promise<string> {
    return this.safeRequest(async () => {
      // URL-encode the post URN for the path
      const encodedPostUrn = encodeURIComponent(postUrn);

      const payload: any = {
        actor: actorUrn,
        object: postUrn,
        message: {
          text: commentText
        }
      };

      // Add parentComment for nested replies
      if (parentCommentUrn) {
        payload.parentComment = parentCommentUrn;
      }

      const response = await this.client.post(
        `/rest/socialActions/${encodedPostUrn}/comments`,
        payload,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      // LinkedIn returns the comment URN in the x-restli-id header or in the response body
      const commentUrn = response.headers['x-restli-id'] || (response.data as any).commentUrn;
      console.log(`[LinkedIn] Comment created successfully: ${commentUrn}`);
      return commentUrn;
    });
  }

  /**
   * Get comments on a LinkedIn post
   * @param accessToken - OAuth access token
   * @param postUrn - URN of the post (e.g., "urn:li:ugcPost:123" or "urn:li:share:456")
   * @returns Array of comments with URN, actor, text, and timestamp
   */
  async getComments(
    accessToken: string,
    postUrn: string
  ): Promise<Array<{ commentUrn: string; actorUrn: string; text: string; createdAt: number }>> {
    return this.safeRequest(async () => {
      const encodedPostUrn = encodeURIComponent(postUrn);

      const response = await this.client.get(
        `/rest/socialActions/${encodedPostUrn}/comments`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      const elements = (response.data as any)?.elements || [];
      return elements.map((el: any) => ({
        commentUrn: el.$URN || (el.id ? `urn:li:comment:(${postUrn},${el.id})` : ''),
        actorUrn: el.actor || '',
        text: el.message?.text || '',
        createdAt: el.created?.time || 0
      }));
    });
  }

  /**
   * Create a reaction (like) on a LinkedIn post
   * @param accessToken - OAuth access token
   * @param postUrn - URN of the post to react to (e.g., "urn:li:ugcPost:123" or "urn:li:share:456")
   * @param actorUrn - URN of the entity making the reaction (person or organization)
   * @param reactionType - Type of reaction (LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION, ENTERTAINMENT)
   * @returns Reaction URN
   */
  async createReaction(
    accessToken: string,
    postUrn: string,
    actorUrn: string,
    reactionType: 'LIKE' | 'PRAISE' | 'EMPATHY' | 'INTEREST' | 'APPRECIATION' | 'ENTERTAINMENT' = 'LIKE'
  ): Promise<string> {
    return this.safeRequest(async () => {
      // URL-encode the actor URN for the query parameter
      const encodedActorUrn = encodeURIComponent(actorUrn);

      const response = await this.client.post(
        `/rest/reactions?actor=${encodedActorUrn}`,
        {
          root: postUrn,  // Note: NOT encoded in body
          reactionType: reactionType
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      // LinkedIn returns the reaction URN in the x-restli-id header
      const reactionUrn = response.headers['x-restli-id'] || (response.data as any).id;
      console.log(`[LinkedIn] Reaction (${reactionType}) created successfully: ${reactionUrn}`);
      return reactionUrn;
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
  async getAggregatedMetrics(accessToken: string, organizationUrn: string, startDate?: Date, endDate?: Date): Promise<AggregatedMetrics> {
    const [followerCount, followerStats, pageStats, shareStats] = await Promise.all([
      this.getOrganizationFollowerCount(accessToken, organizationUrn),
      this.getFollowerStatistics(accessToken, organizationUrn, startDate, endDate),
      this.getPageStatistics(accessToken, organizationUrn, startDate, endDate),
      this.getShareStatistics(accessToken, organizationUrn, undefined, startDate, endDate)
    ]);

    const isGainResult = (stats: LinkedInFollowerStatisticsResult): stats is LinkedInFollowerGainStatistics[] =>
      stats.length > 0 && 'followerGains' in stats[0];

    const isGain = isGainResult(followerStats);

    return {
      totalFollowerCount: followerCount,
      followerStatistics: isGain ? [] : followerStats as LinkedInFollowerStatistics[],
      followerGains: isGain ? followerStats : undefined,
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
      
      // Get the logo URN and resolve it to an actual URL
      const logoUrn = data.logoV2?.original || data.logoV2?.['cropped-mini'];
      let logoUrl: string | undefined;
      
      if (logoUrn) {
        try {
          const resolvedUrl = await this.resolveImageUrl(accessToken, logoUrn);
          logoUrl = resolvedUrl || undefined;
        } catch (error: any) {
          console.warn(`[LinkedIn] Failed to resolve logo for org ${orgId}:`, error.message);
        }
      }
      
      return {
        id: data.id?.toString() || orgId,
        name: data.localizedName || data.name?.localized?.en_US || `Organization ${orgId}`,
        vanityName: data.vanityName,
        logoUrl,
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
    /** Errors encountered while fetching individual metrics */
    metricErrors?: { metric: string; error: string; status?: number }[];
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
        const metricErrors: { metric: string; error: string; status?: number }[] = [];

        for (const metric of metrics) {
          const url = `/rest/memberCreatorPostAnalytics?q=entity&entity=${entityParam}&queryType=${metric}&aggregation=TOTAL`;

          try {
            const response = await this.client.get<{ elements: Array<{ count: number }> }>(url, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });

            const totalCount = response.data.elements?.reduce((sum, el) => sum + (el.count || 0), 0) || 0;
            analyticsData[metric.toLowerCase()] = totalCount;
          } catch (error: any) {
            const status = error?.response?.status;
            const rawMessage = error?.response?.data?.message || error?.message || 'Unknown error';
            
            // Provide clearer error messages based on status code
            let errorMessage: string;
            if (status === 403) {
              errorMessage = 'Permission denied: Your LinkedIn account needs analytics permissions. Please reconnect your account.';
            } else if (status === 401) {
              errorMessage = 'Access token expired or invalid. Please reconnect your LinkedIn account.';
            } else if (status === 500) {
              errorMessage = 'LinkedIn server error. This post may have been deleted or is no longer available.';
            } else if (status === 429) {
              errorMessage = 'Rate limit exceeded. Please try again later.';
            } else {
              errorMessage = rawMessage;
            }
            
            console.warn(`[LinkedIn] Failed to fetch ${metric} for post ${postUrn}: [${status}] ${errorMessage}`);
            analyticsData[metric.toLowerCase()] = 0;
            metricErrors.push({ metric, error: errorMessage, status });
          }
        }

        // Include errors in response if any occurred
        if (metricErrors.length > 0) {
          analyticsData.metricErrors = metricErrors;
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
        } catch (error: any) {
          const status = error?.response?.status;
          const msg = error?.message || '';
          const responseData = JSON.stringify(error?.response?.data || {});
          
          // Rethrow permission errors so they can be handled by the adapter to prompt reconnection
          // Check status codes and common error messages
          if (
            status === 403 || 
            status === 401 || 
            msg.includes('Access Denied') || 
            msg.includes('Forbidden') || 
            msg.includes('Unauthorized') ||
            responseData.includes('Access Denied') ||
            responseData.includes('serviceErrorCode":100') // LinkedIn common access denied code
          ) {
            console.warn(`[LinkedIn] Permission error for ${metric}:`, msg);
            throw error;
          }
          
          console.warn(`[LinkedIn] Failed to fetch ${metric}:`, msg);
          analyticsData[metric.toLowerCase()] = 0;
        }
      }

      return analyticsData;
    });
  }
}

export const linkedInService = new LinkedInService();