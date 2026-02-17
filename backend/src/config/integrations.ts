import { getLinkedInCredentials, getMetaCredentials } from '../utils/secretsManager';

// Graph API version for Auth/Token exchange - decoupled from SDK version
const META_GRAPH_VERSION = 'v24.0';

// LinkedIn account type for OAuth
export type LinkedInAccountType = 'personal' | 'company';

// Static configuration values (URLs, scopes, etc.)
export const INTEGRATION_CONFIG = {
  linkedin: {
    // Unified configuration for both personal and organization accounts
    redirectUri: 'https://22c9-111-93-215-130.ngrok-free.app/api/oauth/meta/callback',
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
  },

  meta: {
    redirectUri: 'https://2016-2409-40c1-6-e38d-af4a-12cb-c1b3-b6c.ngrok-free.app/api/oauth/meta/callback',
    // All scopes for unified OAuth - user can connect ad accounts AND/OR pages
    scopes: [
      'ads_management',
      'ads_read',
      'business_management',
      'pages_show_list',
      'pages_read_engagement'
    ],
    authorizationUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`,
    apiBaseUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}`
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

import { MetaConfig } from '../types/meta';

/**
 * Fetches Meta OAuth configuration from AWS Secrets Manager.
 * Credentials are stored at dev/AgentWeb/Meta (or prod/... for production)
 */
export async function getMetaConfig(): Promise<MetaConfig> {
  // Fetch credentials from AWS Secrets Manager
  const credentials = await getMetaCredentials();

  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.meta.redirectUri,
    scopes: INTEGRATION_CONFIG.meta.scopes,
    authorizationUrl: INTEGRATION_CONFIG.meta.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.meta.tokenUrl,
    apiBaseUrl: INTEGRATION_CONFIG.meta.apiBaseUrl
  };
}

