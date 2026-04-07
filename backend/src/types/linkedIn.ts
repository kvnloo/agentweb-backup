export interface LinkedInProfile {
  sub: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
  email: string;
  email_verified: boolean;
}

export interface LinkedInErrorResponse {
  message?: string;
  status?: number;
  serviceErrorCode?: number;
  code?: string;
  requestId?: string;
}

export interface LinkedInPost {
  id?: string;
  author: string;
  commentary: string;
  visibility: 'PUBLIC' | 'CONNECTIONS';
  lifecycleState: 'PUBLISHED' | 'DRAFT';
  isReshareDisabledByAuthor?: boolean;
  createdAt?: number;
  lastModifiedAt?: number;
  distribution?: {
    feedDistribution: 'MAIN_FEED' | 'NONE';
    targetEntities?: any[];
    thirdPartyDistributionChannels?: any[];
  };
  content?: {
    article?: {
      source: string;
      thumbnail?: string;
      title?: string;
      description?: string;
    };
    media?: {
      id: string;
      altText?: string;
    };
    image?: {
      id: string;
      altText?: string;
    };
    video?: {
      id: string;
      altText?: string;
    };
  };
}

export interface LinkedInOrganizationAcl {
  role: 'ADMINISTRATOR' | 'DIRECT_SPONSORED_CONTENT_POSTER' | 'ANALYST';
  roleContext?: string;
  roleAssignee?: string;
  state: 'APPROVED' | 'REQUESTED';
  organization?: string;  // LinkedIn API returns this field
  organizationTarget?: string;  // Some versions may use this
}

export interface LinkedInPaginatedResponse<T> {
  paging?: {
    start: number;
    count: number;
    links?: {
      rel: string;
      href: string;
    }[];
  };
  elements: T[];
}

export interface LinkedInAclResponse extends LinkedInPaginatedResponse<LinkedInOrganizationAcl> {}

export interface FollowerCount {
  organicFollowerCount: number;
  paidFollowerCount: number;
}

export interface LinkedInFollowerStatistics {
  organizationalEntity: string;
  followerCountsByStaffCountRange?: Array<{
    followerCounts: FollowerCount;
    staffCountRange: string;
  }>;
  followerCountsByFunction?: Array<{
    followerCounts: FollowerCount;
    function: string;
  }>;
  followerCountsByAssociationType?: Array<{
    followerCounts: FollowerCount;
    associationType: string;
  }>;
  followerCountsBySeniority?: Array<{
    followerCounts: FollowerCount;
    seniority: string;
  }>;
  followerCountsByGeoCountry?: Array<{
    followerCounts: FollowerCount;
    geo: string;
  }>;
  followerCountsByGeo?: Array<{
    followerCounts: FollowerCount;
    geo: string;
  }>;
  followerCountsByIndustry?: Array<{
    followerCounts: FollowerCount;
    industry: string;
  }>;
}

export interface FollowerGains {
  organicFollowerGain: number;
  paidFollowerGain: number;
}

export interface LinkedInFollowerGainStatistics {
  organizationalEntity: string;
  timeRange?: { start: number; end: number };
  followerGains: FollowerGains;
}

export type LinkedInFollowerStatisticsResult =
  | LinkedInFollowerStatistics[]
  | LinkedInFollowerGainStatistics[];

export interface AggregatedMetrics {
  totalFollowerCount: number;
  followerStatistics: LinkedInFollowerStatistics[];
  followerGains?: LinkedInFollowerGainStatistics[];
  pageStatistics: any[];
  shareStatistics: any[];
}

export interface PageViewMetric {
  pageViews: number;
  uniquePageViews?: number;
}

export interface PageStatisticsViews {
  allDesktopPageViews?: PageViewMetric;
  allMobilePageViews?: PageViewMetric;
  allPageViews: PageViewMetric;
  careersPageViews?: PageViewMetric;
  desktopCareersPageViews?: PageViewMetric;
  desktopJobsPageViews?: PageViewMetric;
  desktopLifeAtPageViews?: PageViewMetric;
  desktopOverviewPageViews?: PageViewMetric;
  jobsPageViews?: PageViewMetric;
  lifeAtPageViews?: PageViewMetric;
  mobileCareersPageViews?: PageViewMetric;
  mobileJobsPageViews?: PageViewMetric;
  mobileLifeAtPageViews?: PageViewMetric;
  mobileOverviewPageViews?: PageViewMetric;
  overviewPageViews?: PageViewMetric;
}

export interface LinkedInPageStatistics {
  organization: string;
  pageStatisticsByGeoCountry?: Array<{
    geo: string;
    pageStatistics: { views: PageStatisticsViews };
  }>;
  pageStatisticsByFunction?: Array<{
    function: string;
    pageStatistics: { views: PageStatisticsViews };
  }>;
  pageStatisticsByIndustryV2?: Array<{
    industryV2: string;
    pageStatistics: { views: PageStatisticsViews };
  }>;
  pageStatisticsByGeo?: Array<{
    geo: string;
    pageStatistics: { views: PageStatisticsViews };
  }>;
  pageStatisticsBySeniority?: Array<{
    seniority: string;
    pageStatistics: { views: PageStatisticsViews };
  }>;
  pageStatisticsByStaffCountRange?: Array<{
    staffCountRange: string;
    pageStatistics: { views: PageStatisticsViews };
  }>;
  totalPageStatistics: {
    clicks?: {
      desktopCustomButtonClickCounts: any[];
      mobileCustomButtonClickCounts: any[];
    };
    views: PageStatisticsViews;
  };
}
export interface LinkedInShareStatistics {
  organizationalEntity: string;
  share?: string;
  totalShareStatistics: {
    uniqueImpressionsCount: number;
    shareCount: number;
    engagement: number;
    clickCount: number;
    likeCount: number;
    commentCount: number;
    impressionCount: number;
  };
}