
import { getLinkedInPersonalCredentials, getLinkedInCompanyCredentials } from '../utils/secretsManager';

// Static configuration values (URLs, scopes, etc.)
export const INTEGRATION_CONFIG = {
  linkedin: {
    personal: {
      // Note: The redirect URI determines which route handles the OAuth callback
      redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/oauth/linkedin/callback`,
      scopes: [
        'openid',
        'profile',
        'email',
        'w_member_social'
      ],
    },
    organization: {
      redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/oauth/linkedin/org/callback`,
      scopes: [
        'r_organization_social',  // Required to read organization ACLs and details
        'rw_organization_admin',
        'w_organization_social',
      ],
    },
    // LinkedIn OAuth V2 Endpoints (shared)
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
 * Fetches LinkedIn Personal OAuth configuration from AWS Secrets Manager.
 * Credentials are stored at dev/AgentWeb/LinkedIn/Company (or prod/... for production)
 */
export async function getLinkedInConfig(): Promise<LinkedInConfig> {
  // Fetch credentials from AWS Secrets Manager
  const credentials = await getLinkedInPersonalCredentials();

  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.linkedin.personal.redirectUri,
    scopes: INTEGRATION_CONFIG.linkedin.personal.scopes,
    authorizationUrl: INTEGRATION_CONFIG.linkedin.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.linkedin.tokenUrl,
    profileUrl: INTEGRATION_CONFIG.linkedin.profileUrl
  };
}

/**
 * Fetches LinkedIn Organization App OAuth configuration from AWS Secrets Manager.
 * This is a separate app with organization-level scopes for managing company pages.
 * Credentials are stored at dev/AgentWeb/LinkedIn/OrganizationApp
 */
export async function getLinkedInOrgConfig(): Promise<LinkedInConfig> {
  const credentials = await getLinkedInCompanyCredentials();

  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.linkedin.organization.redirectUri,
    scopes: INTEGRATION_CONFIG.linkedin.organization.scopes,
    authorizationUrl: INTEGRATION_CONFIG.linkedin.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.linkedin.tokenUrl,
  };
}

