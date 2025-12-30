
import { getLinkedInCredentials } from '../utils/secretsManager';

// Static configuration values (URLs, scopes, etc.)
export const INTEGRATION_CONFIG = {
  linkedin: {
    // Note: The redirect URI determines which route handles the OAuth callback
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/oauth/linkedin/callback`,
    scopes: [
      'openid',
      'profile',
      'email',
      'w_member_social'
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
  profileUrl: string;
}

/**
 * Fetches LinkedIn OAuth configuration from AWS Secrets Manager.
 * Credentials are stored at dev/AgentWeb/LinkedIn/Company (or prod/... for production)
 */
export async function getLinkedInConfig(): Promise<LinkedInConfig> {
  // Fetch credentials from AWS Secrets Manager
  const credentials = await getLinkedInCredentials();

  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    ...INTEGRATION_CONFIG.linkedin
  };
}
