
import { getLinkedInCredentials, getInstagramCredentials } from '../utils/secretsManager';

// LinkedIn account type for OAuth
export type LinkedInAccountType = 'personal' | 'company';

// Static configuration values (URLs, scopes, etc.)
export const INTEGRATION_CONFIG = {
  instagram: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/instagram/callback`,
    scopes: [
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_insights',
      'pages_show_list',
      'pages_read_engagement',
      'business_management'
    ],
    authorizationUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
  },
  linkedin: {
    // Unified configuration for both personal and organization accounts
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/oauth/linkedin/callback`,
    // Combined scopes (legacy - for unified flow)
    scopes: [
      'r_basicprofile',
      'w_member_social',
      'r_member_postAnalytics',
      'r_member_profileAnalytics',
      'w_member_social_feed',
      'r_organization_social',
      'rw_organization_admin',
      'w_organization_social',
      'r_organization_followers',
      'r_organization_social_feed'
    ],
    
    // LinkedIn OAuth V2 Endpoints
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    profileUrl: 'https://api.linkedin.com/v2/userinfo'
  }
};

/**
 * Get scopes for a specific LinkedIn account type
 */
export function getLinkedInScopesForType(type: LinkedInAccountType): string[] {
  return INTEGRATION_CONFIG.linkedin.scopes;
}

// LinkedIn configuration interface
export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  profileUrl?: string;
}

/**
 * Fetches LinkedIn Unified OAuth configuration from AWS Secrets Manager.
 * This single app handles both personal and organization accounts.
 * Credentials are stored at dev/AgentWeb/LinkedIn/Company (or prod/... for production)
 */
export async function getLinkedInConfig(): Promise<LinkedInConfig> {
  // Fetch credentials from AWS Secrets Manager
  const credentials = await getLinkedInCredentials();

  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.linkedin.redirectUri,
    scopes: INTEGRATION_CONFIG.linkedin.scopes,
    authorizationUrl: INTEGRATION_CONFIG.linkedin.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.linkedin.tokenUrl,
    profileUrl: INTEGRATION_CONFIG.linkedin.profileUrl
  };
}

// Instagram configuration interface
export interface InstagramOAuthConfig {
  appId: string;
  appSecret: string;
  configId: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  webhookVerifyToken: string;
}

/**
 * Fetches Instagram OAuth configuration from AWS Secrets Manager.
 * Instagram uses Meta's Graph API, so credentials are a Facebook/Meta App.
 * Credentials are stored at dev/AgentWeb/Instagram (or prod/... for production)
 */
export async function getInstagramConfig(): Promise<InstagramOAuthConfig> {
  const credentials = await getInstagramCredentials();

  return {
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    configId: credentials.configId,
    webhookVerifyToken: credentials.webhookVerifyToken,
    redirectUri: INTEGRATION_CONFIG.instagram.redirectUri,
    scopes: INTEGRATION_CONFIG.instagram.scopes,
    authorizationUrl: INTEGRATION_CONFIG.instagram.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.instagram.tokenUrl,
  };
}

