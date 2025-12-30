
import { 
  LinkedInProfile, 
  LinkedInPost, 
  LinkedInOrganizationAcl,
  LinkedInFollowerStatistics,
  LinkedInPageStatistics,
  LinkedInShareStatistics,
  LinkedInErrorResponse
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
    roleContext: 'urn:li:organization:12345',
    state: 'APPROVED',
    organization: 'urn:li:organization:12345'
  },
  {
    role: 'ADMINISTRATOR',
    roleContext: 'urn:li:organization:67890',
    state: 'APPROVED',
    organization: 'urn:li:organization:67890'
  }
];

const MOCK_FOLLOWER_STATISTICS: LinkedInFollowerStatistics[] = [
  {
    organizationalEntity: 'urn:li:organization:12345',
    followerCountsByCountry: [
      { country: 'urn:li:country:us', followerCount: 1540 },
      { country: 'urn:li:country:in', followerCount: 890 },
      { country: 'urn:li:country:ca', followerCount: 230 }
    ],
    followerCountsBySeniority: [
      { seniority: 'urn:li:seniority:5', followerCount: 450 },
      { seniority: 'urn:li:seniority:4', followerCount: 780 }
    ],
    followerCountsByIndustry: [
      { industry: 'urn:li:industry:47', followerCount: 1200 },
      { industry: 'urn:li:industry:96', followerCount: 340 }
    ]
  }
];

const MOCK_PAGE_STATISTICS: LinkedInPageStatistics[] = [
  {
    organization: 'urn:li:organization:12345',
    totalPageStatistics: {
      views: {
        allPageViews: {
          pageViews: 2450,
          uniquePageViews: 1120
        }
      }
    }
  }
];

const MOCK_SHARE_STATISTICS: LinkedInShareStatistics[] = [
  {
    organizationalEntity: 'urn:li:organization:12345',
    totalShareStatistics: {
      uniqueImpressionsCount: 12500,
      shareCount: 84,
      engagement: 0.1245,
      clickCount: 450,
      likeCount: 890,
      commentCount: 42
    }
  }
];

const MOCK_POSTS: LinkedInPost[] = [
  {
    author: 'urn:li:organization:12345',
    commentary: 'We are thrilled to announce our latest product launch! Check it out at https://example.com #innovation #tech',
    visibility: 'PUBLIC',
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    distribution: {
      feedDistribution: 'MAIN_FEED'
    }
  },
  {
    author: 'urn:li:organization:12345',
    commentary: 'Our team is growing! We are looking for talented developers to join us. #hiring #jobs',
    visibility: 'PUBLIC',
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
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

  /**
   * Discovery: Get organizations where the user has an admin role (Mock)
   */
  async getAdminOrganizations(accessToken: string): Promise<string[]> {
    return MOCK_ADMIN_ORGANIZATIONS_ACL.map(acl => acl.organization);
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
  async getShareStatistics(accessToken: string, organizationUrn: string): Promise<LinkedInShareStatistics[]> {
    return MOCK_SHARE_STATISTICS;
  }

  /**
   * List posts for a specific author (person or organization) (Mock)
   */
  async listPosts(accessToken: string, authorUrn: string): Promise<LinkedInPost[]> {
    return MOCK_POSTS;
  }

  /**
   * Create a post (Mock)
   */
  async createPost(accessToken: string, authorUrn: string, text: string): Promise<string> {
    return MOCK_CREATED_POST_URN;
  }
}

export const linkedInService = new LinkedInMockService();
