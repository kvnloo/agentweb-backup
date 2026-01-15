
import { getLinkedInCredentials } from '../utils/secretsManager';

// Static configuration values (URLs, scopes, etc.)
export const INTEGRATION_CONFIG = {
  linkedin: {
    // Unified configuration for both personal and organization accounts
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/oauth/linkedin/callback`,
    scopes: [
      'r_basicprofile',
      
      // Personal Account Permissions
      'w_member_social',              // Create/modify posts on personal profile
      'r_member_postAnalytics',       // Retrieve personal post analytics
      'r_member_profileAnalytics',    // Retrieve personal profile analytics
      'w_member_social_feed',         // Manage personal post comments/reactions
      
      // Organization Account Permissions
      'r_organization_social',        // Read organization posts and data
      'rw_organization_admin',        // Manage organization pages
      'w_organization_social',        // Create/modify organization posts
      'r_organization_followers',     // Access follower data
      'r_organization_social_feed'    // Read organization engagement data
    ],
    // LinkedIn OAuth V2 Endpoints
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    profileUrl: 'https://api.linkedin.com/v2/userinfo'
  }
};

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

