
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
  author: string;
  commentary: string;
  visibility: 'PUBLIC' | 'CONNECTIONS';
  lifecycleState: 'PUBLISHED' | 'DRAFT';
  isReshareDisabledByAuthor?: boolean;
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
  };
}

export interface LinkedInOrganizationAcl {
  role: 'ADMINISTRATOR' | 'DIRECT_SPONSORED_CONTENT_POSTER' | 'ANALYST';
  roleContext: string;
  state: 'APPROVED' | 'REQUESTED';
  organization: string;
}

export interface LinkedInAclResponse {
  elements: LinkedInOrganizationAcl[];
}

export interface LinkedInFollowerStatistics {
  organizationalEntity: string;
  followerCountsByCountry?: any[];
  followerCountsBySeniority?: any[];
  followerCountsByIndustry?: any[];
}

export interface LinkedInPageStatistics {
  organization: string;
  totalPageStatistics: {
    views: {
      allPageViews: {
        pageViews: number;
        uniquePageViews: number;
      };
    };
  };
}

export interface LinkedInShareStatistics {
  organizationalEntity: string;
  totalShareStatistics: {
    uniqueImpressionsCount: number;
    shareCount: number;
    engagement: number;
    clickCount: number;
    likeCount: number;
    commentCount: number;
  };
}

