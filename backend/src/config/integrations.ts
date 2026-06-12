import { getLinkedInCredentials, getLinkedInAdsSecrets, getMetaCredentials, getGmailCredentials, getYouTubeCredentials, getFathomCredentials, getClickUpCredentials, getHubSpotCredentials, getAttioCredentials, getGoogleAdsCredentials } from '../utils/secretsManager';
import { MetaConfig } from '../types/meta';

// Graph API version for Auth/Token exchange - decoupled from SDK version
const META_GRAPH_VERSION = process.env.META_API_VERSION || 'v25.0';
// Instagram Business Login API version — separate from Facebook Graph API version
// because graph.instagram.com only supports specific versions (v21.0+)
const META_INSTAGRAM_VERSION = process.env.META_INSTAGRAM_API_VERSION || 'v25.0';

export type MetaFlowType = 'marketing' | 'instagram';

// LinkedIn account type for OAuth
export type LinkedInAccountType = 'personal' | 'company';

// Static configuration values (URLs, scopes, etc.)
export const INTEGRATION_CONFIG = {
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
  },

  meta: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/oauth/meta/callback`,
    instagramRedirectUri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/oauth/instagram/callback`,

    // Flow 1: Marketing API — Facebook + Instagram ads
    marketingScopes: [
      'ads_management',
      'ads_read',
      'pages_show_list',
      // Required for /me/accounts (page listing) and page reads. Removed in Mar 2026
      // (db9ab4cf) which silently broke pages for every token minted after — legacy
      // tokens kept the old grant, masking the breakage in testing.
      'pages_read_engagement',
    ],

    instagramScopes: [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_insights'
    ],

    // Facebook Login endpoints (flows: marketing, pages)
    authorizationUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`,
    apiBaseUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}`,
    pagesApiBaseUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}`,

    // Instagram Business Login endpoints (flow: instagram)
    instagramAuthorizationUrl: `https://api.instagram.com/oauth/authorize`,
    instagramTokenUrl: `https://api.instagram.com/oauth/access_token`,
    instagramApiBaseUrl: `https://graph.instagram.com/${META_INSTAGRAM_VERSION}`
  },

  gmail: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/gmail/callback`,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  youtube: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/youtube/callback`,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    channelsUrl: 'https://www.googleapis.com/youtube/v3/channels',
    scopes: [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  google_ads: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/google-ads/callback`,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/adwords',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  fathom: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/fathom/callback`,
    authorizationUrl: 'https://fathom.video/external/v1/oauth2/authorize',
    tokenUrl: 'https://api.fathom.ai/external/v1/oauth2/token',
    scopes: ['public_api'],
  },

  attio: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/attio/callback`,
    authorizationUrl: 'https://app.attio.com/authorize',
    tokenUrl: 'https://app.attio.com/oauth/token',
    selfUrl: 'https://api.attio.com/v2/self',
    scopes: [],
  },

  hubspot: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/hubspot/callback`,
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
    scopes: [
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
      'crm.objects.deals.read',
      'crm.objects.deals.write',
      'crm.lists.read',
      'crm.lists.write',
      'crm.schemas.contacts.read',
      'crm.schemas.contacts.write',
      'crm.schemas.deals.read',
      'crm.schemas.deals.write',
    ] as const,
    marketingOnlyScopes: [
      'marketing.campaigns.read',
      'marketing.campaigns.revenue.read',
      'marketing.campaigns.write',
      'content',
      'automation',
      'forms',
    ] as const,
    get marketingScopes() { return [...this.scopes, ...this.marketingOnlyScopes]; },
  },

  clickup: {
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/clickup/callback`,
    authorizationUrl: 'https://app.clickup.com/api',
    tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
    // ClickUp OAuth grants access to all workspaces the user has access to;
    // no explicit scopes are required in the authorization request.
    scopes: [] as string[],
  },

  linkedinAds: {
    // Separate MDP (Marketing Developer Platform) app — distinct from the posting app
    redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/linkedin-ads/callback`,
    scopes: [
      'r_basicprofile',
      'r_ads',
      'rw_ads',
      'r_ads_reporting',
      'r_organization_social',
      'w_organization_social'
    ],
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    profileUrl: 'https://api.linkedin.com/v2/userinfo',
    apiBaseUrl: 'https://api.linkedin.com',
    apiVersion: '202603',
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

// LinkedIn Ads configuration interface
export interface LinkedInAdsConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  profileUrl: string;
  apiBaseUrl: string;
  apiVersion: string;
}

/**
 * Fetches LinkedIn Ads OAuth configuration from AWS Secrets Manager.
 * Uses the separate MDP (Marketing Developer Platform) app credentials,
 * stored at dev/AgentWeb/LinkedIn/Ads (or prod/... for production).
 */
export async function getLinkedInAdsConfig(): Promise<LinkedInAdsConfig> {
  const credentials = await getLinkedInAdsSecrets();
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.linkedinAds.redirectUri,
    scopes: INTEGRATION_CONFIG.linkedinAds.scopes,
    authorizationUrl: INTEGRATION_CONFIG.linkedinAds.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.linkedinAds.tokenUrl,
    profileUrl: INTEGRATION_CONFIG.linkedinAds.profileUrl,
    apiBaseUrl: INTEGRATION_CONFIG.linkedinAds.apiBaseUrl,
    apiVersion: INTEGRATION_CONFIG.linkedinAds.apiVersion,
  };
}

/**
 * Returns scopes and auth/token URLs for a given Meta OAuth flow.
 */
export function getMetaFlowConfig(flow: MetaFlowType): {
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
} {
  const cfg = INTEGRATION_CONFIG.meta;
  if (flow === 'instagram') {
    return {
      scopes: cfg.instagramScopes,
      authorizationUrl: cfg.instagramAuthorizationUrl,
      tokenUrl: cfg.instagramTokenUrl,
      apiBaseUrl: cfg.instagramApiBaseUrl
    };
  }
  // default: marketing
  return {
    scopes: cfg.marketingScopes,
    authorizationUrl: cfg.authorizationUrl,
    tokenUrl: cfg.tokenUrl,
    apiBaseUrl: cfg.apiBaseUrl
  };
}

// Gmail configuration interface
export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  profileUrl: string;
}

// Module-level cache — avoids hitting Secrets Manager on every Gmail API call
let cachedGmailConfig: GmailOAuthConfig | null = null;
let gmailConfigCacheExpiresAt = 0;
const GMAIL_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns Gmail OAuth configuration.
 * Credentials are fetched from AWS Secrets Manager (dev/AgentWeb/Google/Gmail or prod/...).
 * Result is cached for 5 minutes to avoid per-request Secrets Manager calls.
 */
export async function getGmailConfig(): Promise<GmailOAuthConfig> {
  if (cachedGmailConfig && Date.now() < gmailConfigCacheExpiresAt) {
    return cachedGmailConfig;
  }
  const credentials = await getGmailCredentials();
  cachedGmailConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.gmail.redirectUri,
    scopes: INTEGRATION_CONFIG.gmail.scopes,
    authorizationUrl: INTEGRATION_CONFIG.gmail.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.gmail.tokenUrl,
    revokeUrl: INTEGRATION_CONFIG.gmail.revokeUrl,
    profileUrl: INTEGRATION_CONFIG.gmail.profileUrl,
  };
  gmailConfigCacheExpiresAt = Date.now() + GMAIL_CONFIG_CACHE_TTL_MS;
  return cachedGmailConfig;
}

// YouTube configuration interface
export interface YouTubeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  profileUrl: string;
  channelsUrl: string;
}

// Module-level cache for YouTube config (reuses Gmail credentials)
let cachedYouTubeConfig: YouTubeOAuthConfig | null = null;
let youtubeConfigCacheExpiresAt = 0;
const YOUTUBE_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns YouTube OAuth configuration.
 * Reuses Gmail Google OAuth credentials from AWS Secrets Manager.
 * Result is cached for 5 minutes.
 */
export async function getYouTubeConfig(): Promise<YouTubeOAuthConfig> {
  if (cachedYouTubeConfig && Date.now() < youtubeConfigCacheExpiresAt) {
    return cachedYouTubeConfig;
  }
  const credentials = await getYouTubeCredentials();
  cachedYouTubeConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.youtube.redirectUri,
    scopes: INTEGRATION_CONFIG.youtube.scopes,
    authorizationUrl: INTEGRATION_CONFIG.youtube.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.youtube.tokenUrl,
    profileUrl: INTEGRATION_CONFIG.youtube.profileUrl,
    channelsUrl: INTEGRATION_CONFIG.youtube.channelsUrl,
  };
  youtubeConfigCacheExpiresAt = Date.now() + YOUTUBE_CONFIG_CACHE_TTL_MS;
  return cachedYouTubeConfig;
}

export interface GoogleAdsOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
}

let cachedGoogleAdsConfig: GoogleAdsOAuthConfig | null = null;
let googleAdsConfigCacheExpiresAt = 0;
const GOOGLE_ADS_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getGoogleAdsConfig(): Promise<GoogleAdsOAuthConfig> {
  if (cachedGoogleAdsConfig && Date.now() < googleAdsConfigCacheExpiresAt) {
    return cachedGoogleAdsConfig;
  }
  const credentials = await getGoogleAdsCredentials();
  cachedGoogleAdsConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.google_ads.redirectUri,
    scopes: INTEGRATION_CONFIG.google_ads.scopes,
    authorizationUrl: INTEGRATION_CONFIG.google_ads.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.google_ads.tokenUrl,
  };
  googleAdsConfigCacheExpiresAt = Date.now() + GOOGLE_ADS_CONFIG_CACHE_TTL_MS;
  return cachedGoogleAdsConfig;
}

/**
 * Fetches Meta OAuth configuration from AWS Secrets Manager.
 * Credentials are stored at dev/AgentWeb/Meta (or prod/... for production)
 */
export async function getMetaConfig(flow?: MetaFlowType): Promise<MetaConfig> {
  const credentials = await getMetaCredentials();
  const flowCfg = getMetaFlowConfig(flow || 'marketing');

  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.meta.redirectUri,
    scopes: flowCfg.scopes,
    authorizationUrl: flowCfg.authorizationUrl,
    tokenUrl: flowCfg.tokenUrl,
    apiBaseUrl: flowCfg.apiBaseUrl
  };
}

// ClickUp configuration interface
export interface ClickUpOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
}

let cachedClickUpConfig: ClickUpOAuthConfig | null = null;
let clickupConfigCacheExpiresAt = 0;
const CLICKUP_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns ClickUp OAuth configuration.
 * Credentials are fetched from AWS Secrets Manager (dev/AgentWeb/ClickUp or prod/...).
 * Result is cached for 5 minutes to avoid per-request Secrets Manager calls.
 */
export async function getClickUpConfig(): Promise<ClickUpOAuthConfig> {
  if (cachedClickUpConfig && Date.now() < clickupConfigCacheExpiresAt) {
    return cachedClickUpConfig;
  }
  const credentials = await getClickUpCredentials();
  cachedClickUpConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.clickup.redirectUri,
    authorizationUrl: INTEGRATION_CONFIG.clickup.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.clickup.tokenUrl,
  };
  clickupConfigCacheExpiresAt = Date.now() + CLICKUP_CONFIG_CACHE_TTL_MS;
  return cachedClickUpConfig;
}

// Fathom configuration interface
export interface FathomOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
}

// Module-level cache for Fathom config
let cachedFathomConfig: FathomOAuthConfig | null = null;
let fathomConfigCacheExpiresAt = 0;
const FATHOM_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns Fathom OAuth configuration.
 * Credentials are fetched from AWS Secrets Manager (dev/AgentWeb/Fathom or prod/...).
 * Result is cached for 5 minutes to avoid per-request Secrets Manager calls.
 */
export async function getFathomConfig(): Promise<FathomOAuthConfig> {
  if (cachedFathomConfig && Date.now() < fathomConfigCacheExpiresAt) {
    return cachedFathomConfig;
  }
  const credentials = await getFathomCredentials();
  cachedFathomConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.fathom.redirectUri,
    scopes: INTEGRATION_CONFIG.fathom.scopes,
    authorizationUrl: INTEGRATION_CONFIG.fathom.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.fathom.tokenUrl,
  };
  fathomConfigCacheExpiresAt = Date.now() + FATHOM_CONFIG_CACHE_TTL_MS;
  return cachedFathomConfig;
}

// HubSpot configuration interface
export interface HubSpotOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  marketingOnlyScopes: string[];
  marketingScopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  tokenInfoUrl: string;
}

let cachedHubSpotConfig: HubSpotOAuthConfig | null = null;
let hubspotConfigCacheExpiresAt = 0;
const HUBSPOT_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getHubSpotConfig(): Promise<HubSpotOAuthConfig> {
  if (cachedHubSpotConfig && Date.now() < hubspotConfigCacheExpiresAt) {
    return cachedHubSpotConfig;
  }
  const credentials = await getHubSpotCredentials();
  cachedHubSpotConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.hubspot.redirectUri,
    scopes: [...INTEGRATION_CONFIG.hubspot.scopes],
    marketingOnlyScopes: [...INTEGRATION_CONFIG.hubspot.marketingOnlyScopes],
    marketingScopes: INTEGRATION_CONFIG.hubspot.marketingScopes,
    authorizationUrl: INTEGRATION_CONFIG.hubspot.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.hubspot.tokenUrl,
    tokenInfoUrl: INTEGRATION_CONFIG.hubspot.tokenInfoUrl,
  };
  hubspotConfigCacheExpiresAt = Date.now() + HUBSPOT_CONFIG_CACHE_TTL_MS;
  return cachedHubSpotConfig;
}

export interface AttioOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  selfUrl: string;
}

let cachedAttioConfig: AttioOAuthConfig | null = null;
let attioConfigCacheExpiresAt = 0;
const ATTIO_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getAttioConfig(): Promise<AttioOAuthConfig> {
  if (cachedAttioConfig && Date.now() < attioConfigCacheExpiresAt) {
    return cachedAttioConfig;
  }
  const credentials = await getAttioCredentials();
  cachedAttioConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.attio.redirectUri,
    scopes: INTEGRATION_CONFIG.attio.scopes,
    authorizationUrl: INTEGRATION_CONFIG.attio.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.attio.tokenUrl,
    selfUrl: INTEGRATION_CONFIG.attio.selfUrl,
  };
  attioConfigCacheExpiresAt = Date.now() + ATTIO_CONFIG_CACHE_TTL_MS;
  return cachedAttioConfig;
}
