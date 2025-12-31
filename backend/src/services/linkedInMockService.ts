
import {
  LinkedInProfile,
  LinkedInPost,
  LinkedInOrganizationAcl,
  LinkedInFollowerStatistics,
  LinkedInPageStatistics,
  LinkedInShareStatistics,
  LinkedInErrorResponse,
  LinkedInPaginatedResponse,
  LinkedInAclResponse
} from '../types/linkedIn';

// --- MOCK DATA ---

const MOCK_LINKEDIN_PROFILE: LinkedInProfile = {
  sub: 'vL_5f7bc92',
  name: 'Jane Smith',
  given_name: 'Jane',
  family_name: 'Smith',
  picture: 'https://media.licdn.com/dms/image/v2/D4E03AQG_Q8y8XvWQ/profile-displayphoto-shrink_800_800/0/123456789?e=1710000000&v=beta&t=abc',
  locale: 'en_US',
  email: 'jane.smith@example.com',
  email_verified: true
};

const MOCK_ADMIN_ORGANIZATIONS_ACL: LinkedInOrganizationAcl[] = [
  {
    role: 'ADMINISTRATOR',
    roleAssignee: 'urn:li:person:vL_5f7bc92',
    state: 'APPROVED',
    organizationTarget: 'urn:li:organization:12345'
  },
  {
    role: 'ADMINISTRATOR',
    roleAssignee: 'urn:li:person:vL_5f7bc92',
    state: 'APPROVED',
    organizationTarget: 'urn:li:organization:67890'
  }
];

const MOCK_FOLLOWER_STATISTICS: LinkedInFollowerStatistics[] = [
  {
    organizationalEntity: 'urn:li:organization:12345',
    followerCountsByStaffCountRange: [
      { followerCounts: { organicFollowerCount: 29, paidFollowerCount: 0 }, staffCountRange: 'SIZE_1' },
      { followerCounts: { organicFollowerCount: 6, paidFollowerCount: 0 }, staffCountRange: 'SIZE_2_TO_10' }
    ],
    followerCountsByFunction: [
      { followerCounts: { organicFollowerCount: 1662, paidFollowerCount: 0 }, function: 'urn:li:function:22' },
      { followerCounts: { organicFollowerCount: 674, paidFollowerCount: 0 }, function: 'urn:li:function:13' }
    ],
    followerCountsByAssociationType: [
      { followerCounts: { organicFollowerCount: 196, paidFollowerCount: 0 }, associationType: 'EMPLOYEE' }
    ],
    followerCountsBySeniority: [
      { followerCounts: { organicFollowerCount: 4, paidFollowerCount: 0 }, seniority: 'urn:li:seniority:2' },
      { followerCounts: { organicFollowerCount: 3, paidFollowerCount: 0 }, seniority: 'urn:li:seniority:3' }
    ],
    followerCountsByGeoCountry: [
      { geo: 'urn:li:geo:102713980', followerCounts: { organicFollowerCount: 66, paidFollowerCount: 0 } },
      { geo: 'urn:li:geo:103644278', followerCounts: { organicFollowerCount: 60, paidFollowerCount: 0 } }
    ],
    followerCountsByGeo: [
      { geo: 'urn:li:geo:90009626', followerCounts: { organicFollowerCount: 84, paidFollowerCount: 0 } },
      { geo: 'urn:li:geo:90009633', followerCounts: { organicFollowerCount: 74, paidFollowerCount: 0 } }
    ],
    followerCountsByIndustry: [
      { followerCounts: { organicFollowerCount: 33, paidFollowerCount: 0 }, industry: 'urn:li:industry:96' },
      { followerCounts: { organicFollowerCount: 15, paidFollowerCount: 0 }, industry: 'urn:li:industry:4' }
    ]
  }
];

const MOCK_PAGE_STATISTICS: LinkedInPageStatistics[] = [
  {
    organization: 'urn:li:organization:12345',
    pageStatisticsByGeoCountry: [
      {
        geo: 'urn:li:geo:103644278',
        pageStatistics: {
          views: {
            allDesktopPageViews: { pageViews: 1680 },
            allMobilePageViews: { pageViews: 16 },
            allPageViews: { pageViews: 1696 },
            overviewPageViews: { pageViews: 1693 }
          }
        }
      }
    ],
    pageStatisticsByFunction: [
      {
        function: 'urn:li:function:1',
        pageStatistics: {
          views: {
            allDesktopPageViews: { pageViews: 25 },
            allPageViews: { pageViews: 25 },
            overviewPageViews: { pageViews: 25 }
          }
        }
      }
    ],
    totalPageStatistics: {
      clicks: {
        desktopCustomButtonClickCounts: [],
        mobileCustomButtonClickCounts: []
      },
      views: {
        allDesktopPageViews: { pageViews: 17321 },
        allMobilePageViews: { pageViews: 465 },
        allPageViews: { pageViews: 17786 },
        overviewPageViews: { pageViews: 17781 }
      }
    }
  }
];

const MOCK_SHARE_STATISTICS: LinkedInShareStatistics[] = [
  {
    organizationalEntity: 'urn:li:organization:12345',
    share: 'urn:li:share:11223344',
    totalShareStatistics: {
      uniqueImpressionsCount: 9327,
      shareCount: 0,
      engagement: 0.0075,
      clickCount: 109,
      likeCount: 52,
      commentCount: 70,
      impressionCount: 14490
    }
  }
];

const MOCK_POSTS: LinkedInPost[] = [
  {
    id: 'urn:li:share:11223344',
    author: 'urn:li:organization:12345',
    commentary: 'We are thrilled to announce our latest product launch! Check it out at https://example.com #innovation #tech',
    visibility: 'PUBLIC',
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    createdAt: 1735624800000,
    lastModifiedAt: 1735624800000,
    distribution: {
      feedDistribution: 'MAIN_FEED'
    }
  },
  {
    id: 'urn:li:share:55667788',
    author: 'urn:li:organization:12345',
    commentary: 'Our team is growing! We are looking for talented developers to join us. #hiring #jobs',
    visibility: 'PUBLIC',
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    createdAt: 1735538400000,
    lastModifiedAt: 1735538400000,
    distribution: {
      feedDistribution: 'MAIN_FEED'
    }
  }
];

const MOCK_CREATED_POST_URN = 'urn:li:share:123456789';

// --- MOCK SERVICE ---

export class LinkedInMockService {
  /**
   * Get current user profile (Mock)
   */
  async getProfile(accessToken: string): Promise<LinkedInProfile> {
    return MOCK_LINKEDIN_PROFILE;
  }

  async getAdminOrganizations(accessToken: string): Promise<LinkedInAclResponse> {
    return {
      elements: MOCK_ADMIN_ORGANIZATIONS_ACL,
      paging: {
        start: 0,
        count: MOCK_ADMIN_ORGANIZATIONS_ACL.length,
        links: []
      }
    };
  }

  /**
   * Analytics: Get follower statistics for an organization (Mock)
   */
  async getFollowerStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInFollowerStatistics[]> {
    return MOCK_FOLLOWER_STATISTICS;
  }

  /**
   * Analytics: Get page statistics for an organization (Mock)
   */
  async getPageStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInPageStatistics[]> {
    return MOCK_PAGE_STATISTICS;
  }

  /**
   * Post Metrics: Get share statistics for an organization's entity (Mock)
   */
  async getShareStatistics(accessToken: string, organizationUrn: string, shareUrns?: string[]): Promise<LinkedInShareStatistics[]> {
    return MOCK_SHARE_STATISTICS;
  }

  /**
   * List posts for a specific author (person or organization) (Mock)
   */
  async listPosts(accessToken: string, authorUrn: string, start: number = 0, count: number = 50): Promise<LinkedInPaginatedResponse<LinkedInPost>> {
    return {
      elements: MOCK_POSTS.slice(start, start + count),
      paging: {
        start: start,
        count: MOCK_POSTS.slice(start, start + count).length,
        links: []
      }
    };
  }

  /**
   * Create a post (Mock)
   */
  async createPost(accessToken: string, authorUrn: string, text: string): Promise<string> {
    return MOCK_CREATED_POST_URN;
  }

  /**
   * Aggregated Analytics: Get follower, page, and share statistics for an organization (Mock)
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
   * Get organization details by URN (Mock - for Connected Accounts)
   */
  async getOrganization(accessToken: string, orgUrn: string): Promise<{
    id: string;
    name: string;
    vanityName?: string;
    logoUrl?: string;
  }> {
    const orgId = orgUrn.replace('urn:li:organization:', '');
    const mockOrgs: Record<string, any> = {
      '12345': { id: '12345', name: 'Tech Startup Inc', vanityName: 'techstartup', logoUrl: 'https://example.com/logo1.png' },
      '67890': { id: '67890', name: 'Acme Corporation', vanityName: 'acmecorp', logoUrl: 'https://example.com/logo2.png' },
    };
    return mockOrgs[orgId] || { id: orgId, name: `Organization ${orgId}` };
  }

  /**
   * Get follower count for an organization (Mock - for Connected Accounts)
   */
  async getOrganizationFollowerCount(accessToken: string, orgUrn: string): Promise<number> {
    const mockCounts: Record<string, number> = {
      'urn:li:organization:12345': 15000,
      'urn:li:organization:67890': 8500,
    };
    return mockCounts[orgUrn] || 0;
  }

  /**
   * Verify if an access token is still valid (Mock - always returns valid)
   */
  async verifyToken(accessToken: string): Promise<{ valid: boolean; error?: string }> {
    // Mock always returns valid for testing
    return { valid: true };
  }
}

export const linkedInService = new LinkedInMockService();