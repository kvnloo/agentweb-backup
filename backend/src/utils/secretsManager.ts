import AWS from 'aws-sdk';

// Initialize AWS SDK
const secretsManager = new AWS.SecretsManager({
  region: process.env.AWS_REGION || 'us-west-2'
});

/**
 * Fetch a secret from AWS Secrets Manager
 * @param secretName - The name of the secret to retrieve
 * @returns The secret value as a string
 */
export async function getSecret(secretName: string): Promise<string> {
  try {
    const data = await secretsManager.getSecretValue({
      SecretId: secretName
    }).promise();

    if (data.SecretString) {
      return data.SecretString;
    }

    throw new Error('Secret string is empty');
  } catch (error) {
    // The name and the error code only: the whole error object has no business in logs.
    console.error(`Error fetching secret ${secretName}: ${(error as { code?: string })?.code || (error as Error)?.name || 'error'}`);
    throw new Error(`Failed to fetch secret: ${secretName}`);
  }
}

/**
 * Check if a secret exists in AWS Secrets Manager
 * @param secretName - The name of the secret to check
 * @returns true if the secret exists, false if not
 */
export async function secretExists(secretName: string): Promise<boolean> {
  try {
    // Try to get the secret value - if it exists, this will succeed
    await secretsManager.getSecretValue({
      SecretId: secretName
    }).promise();
    return true;
  } catch (error: any) {
    // If the secret is not found, AWS throws a ResourceNotFoundException
    if (error.code === 'ResourceNotFoundException') {
      return false;
    }
    // For other errors, log but don't throw - let the caller try getSecret which will handle it properly
    console.log(`Error checking existence of secret ${secretName}:`, error.code || error.message || error);
    // Return false to fall back to base secret, rather than throwing
    return false;
  }
}

/**
 * Get Meta API access token from Secrets Manager
 * @returns The Meta access token as a string
 */
export async function getMetaAccessToken(): Promise<string> {
  try {
    const secretName = process.env.META_SECRETS_NAME || 'dev/AgentWeb/Meta';
    const accessToken = await getSecret(secretName);

    if (!accessToken || accessToken.trim() === '') {
      throw new Error('Meta access token is empty');
    }

    return accessToken;
  } catch (error) {
    console.error('Error fetching Meta access token:', error);
    throw new Error('Failed to fetch Meta access token from Secrets Manager');
  }
}

/**
 * Get GCS private key from Secrets Manager based on environment
 * @returns The GCS private key as a string with newlines properly formatted
 */
export async function getGCSPPrivateKey(): Promise<string> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/GCS/PK'
      : 'dev/AgentWeb/GCS/PK';

    const privateKey = await getSecret(secretName);

    if (!privateKey || privateKey.trim() === '') {
      throw new Error('GCS private key is empty');
    }

    // Replace [NEWLINE] with actual newlines as done in the original code
    return privateKey.replace(/\[NEWLINE\]/g, '\n');
  } catch (error) {
    console.error('Error fetching GCS private key from Secrets Manager:', error);
    throw new Error('Failed to fetch GCS private key from Secrets Manager');
  }
}

/**
 * Interface for LinkedIn credentials returned from Secrets Manager
 */
export interface LinkedInCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Get LinkedIn OAuth credentials from AWS Secrets Manager
 * This fetches credentials for the unified LinkedIn app that handles both
 * personal and organization accounts with all required scopes.
 * 
 * Secret location: dev/AgentWeb/LinkedIn/Personal (or prod/... for production)
 * 
 * @returns The LinkedIn client credentials (clientId and clientSecret)
 */
export async function getLinkedInCredentials(): Promise<LinkedInCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/LinkedIn/Company'
      : 'dev/AgentWeb/LinkedIn/Company';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('LinkedIn credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as LinkedInCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('LinkedIn credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching LinkedIn credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch LinkedIn credentials from Secrets Manager');
  }
}

/**
 * Interface for Meta credentials returned from Secrets Manager
 */
export interface MetaCredentials {
  clientId: string;
  clientSecret: string;
  instagramClientId: string;
  instagramClientSecret: string;
}

/**
 * Get Meta OAuth credentials from AWS Secrets Manager
 * 
 * Secret location: dev/AgentWeb/Meta (or prod/... for production)
 * 
 * @returns The Meta client credentials (clientId and clientSecret)
 */
export async function getMetaCredentials(): Promise<MetaCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/MetaApp'
      : 'dev/AgentWeb/MetaApp';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Meta credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as MetaCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Meta credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Meta credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Meta credentials from Secrets Manager');
  }
}


/**
 * Get Instagram Business Login OAuth credentials from AWS Secrets Manager.
 * Reads instagramClientId and instagramClientSecret from the Meta secret.
 *
 * Secret location: dev/AgentWeb/Meta (or prod/... for production)
 *
 * @returns The Instagram client credentials (clientId and clientSecret)
 */
export async function getInstagramCredentials(): Promise<MetaCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/MetaApp'
      : 'dev/AgentWeb/MetaApp';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Instagram credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as MetaCredentials;

    if (!credentials.instagramClientId || !credentials.instagramClientSecret) {
      throw new Error('Instagram credentials missing instagramClientId or instagramClientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Instagram credentials:', error);
    throw new Error('Failed to fetch Instagram credentials from Secrets Manager');
  }
}

/**
 * Get Google Drive service account email from Secrets Manager
 * Reads the service account JSON key and extracts the client_email field.
 *
 * Secret location: dev/AgentWeb/Google/Share (or prod/... for production)
 *
 * @returns The service account email address
 */
export async function getGoogleDriveServiceAccountEmail(): Promise<string> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Google/Share'
      : 'dev/AgentWeb/Google/Share';
    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Google Drive service account secret is empty');
    }

    const serviceAccount = JSON.parse(secretString);

    if (!serviceAccount.client_email) {
      throw new Error('Google Drive service account JSON missing client_email');
    }

    return serviceAccount.client_email;
  } catch (error) {
    console.error('Error fetching Google Drive service account email:', error);
    throw new Error('Failed to fetch Google Drive service account email from Secrets Manager');
  }
}
/**
 * Interface for Unipile credentials returned from Secrets Manager.
 * Store as JSON: { "dsn": "https://api3.unipile.com:13311", "apiKey": "your_key" }
 */
export interface UnipileCredentials {
  dsn: string;
  apiKey: string;
}

/**
 * Get Unipile credentials (DSN + API key) from AWS Secrets Manager.
 *
 * Secret location: dev/AgentWeb/Unipile (or prod/AgentWeb/Unipile for production)
 *
 * @returns The Unipile DSN and API key
 */
export async function getUnipileCredentials(): Promise<UnipileCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Unipile'
      : 'dev/AgentWeb/Unipile';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Unipile credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as UnipileCredentials;

    if (!credentials.dsn || !credentials.apiKey) {
      throw new Error('Unipile credentials missing dsn or apiKey');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Unipile credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Unipile credentials from Secrets Manager');
  }
}

/**
 * Interface for Gmail OAuth credentials returned from Secrets Manager
 */
export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Get Gmail OAuth credentials from AWS Secrets Manager.
 *
 * Secret location: dev/AgentWeb/Google/Gmail (or prod/... for production)
 * Secret format: { "clientId": "...", "clientSecret": "..." }
 *
 * @returns Gmail OAuth client credentials
 */
export async function getGmailCredentials(): Promise<GmailCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Google/Gmail'
      : 'dev/AgentWeb/Google/Gmail';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Gmail credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as GmailCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Gmail credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Gmail credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Gmail credentials from Secrets Manager');
  }
}

/**
 * Interface for Outlook / Microsoft 365 OAuth credentials returned from Secrets Manager
 */
export interface OutlookCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Get Outlook / Microsoft 365 OAuth credentials from AWS Secrets Manager.
 *
 * Secret location: dev/AgentWeb/Microsoft/Outlook (or prod/... for production)
 * Secret format: { "clientId": "...", "clientSecret": "..." }
 *
 * The Entra app registration must be MULTITENANT — otherwise only our own tenant
 * can consent and no customer can ever connect a mailbox.
 *
 * @returns Outlook OAuth client credentials
 */
export async function getOutlookCredentials(): Promise<OutlookCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Microsoft/Outlook'
      : 'dev/AgentWeb/Microsoft/Outlook';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Outlook credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as OutlookCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Outlook credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Outlook credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Outlook credentials from Secrets Manager');
  }
}

/**
 * Interface for Calendly OAuth credentials returned from Secrets Manager
 */
export interface CalendlyCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Get Calendly OAuth credentials from AWS Secrets Manager.
 *
 * Secret location: dev/AgentWeb/Calendly (or prod/... for production)
 * Secret format: { "clientId": "...", "clientSecret": "..." }
 *
 * @returns Calendly OAuth client credentials
 */
export async function getCalendlyCredentials(): Promise<CalendlyCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Calendly'
      : 'dev/AgentWeb/Calendly';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Calendly credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as CalendlyCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Calendly credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Calendly credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Calendly credentials from Secrets Manager');
  }
}

/**
 * Interface for Twitter/X OAuth2 credentials returned from Secrets Manager
 */
export interface TwitterCredentials {
  clientId: string;
  clientSecret: string;
  /**
   * App-only OAuth2 Bearer token for the shared X Developer App. Present in the
   * secret alongside clientId/clientSecret; used for app-level endpoints that are
   * not tied to a connected user — notably GET /2/usage/tweets, the app's own
   * billed consumption against the read cap (ENG-664 reconciliation). Optional so
   * an older secret without it still loads.
   */
  bearerToken?: string;
}

/**
 * Get Twitter/X OAuth2 (Authorization Code + PKCE) client credentials from AWS Secrets Manager.
 *
 * Secret location: dev/AgentWeb/Twitter (or prod/AgentWeb/Twitter for production)
 * Secret format: { "clientId": "...", "clientSecret": "..." }
 *
 * @returns Twitter/X OAuth2 client credentials
 */
export async function getTwitterCredentials(): Promise<TwitterCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Twitter'
      : 'dev/AgentWeb/Twitter';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Twitter credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as TwitterCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Twitter credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Twitter credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Twitter credentials from Secrets Manager');
  }
}

/**
 * Get YouTube OAuth credentials from AWS Secrets Manager.
 * Reuses the Gmail Google OAuth credentials (same Google Cloud project).
 *
 * Secret location: dev/AgentWeb/Google/Gmail (or prod/... for production)
 *
 * @returns YouTube OAuth client credentials (same as Gmail)
 */
export async function getYouTubeCredentials(): Promise<GmailCredentials> {
  return getGmailCredentials();
}

/**
 * Interface for Google Ads API credentials returned from Secrets Manager
 */
export interface GoogleAdsCredentials {
  clientId: string;
  clientSecret: string;
  developerToken: string;
}

/**
 * Get Google Ads API credentials from AWS Secrets Manager.
 *
 * Secret location: dev/AgentWeb/Google/Ads (or prod/... for production)
 * Secret format: { "clientId": "...", "clientSecret": "...", "developerToken": "..." }
 *
 * @returns Google Ads API credentials
 */
export async function getGoogleAdsCredentials(): Promise<GoogleAdsCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Google/Ads'
      : 'dev/AgentWeb/Google/Ads';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Google Ads credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as GoogleAdsCredentials;

    if (!credentials.clientId || !credentials.clientSecret || !credentials.developerToken) {
      throw new Error('Google Ads credentials missing one or more required fields: clientId, clientSecret, developerToken');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Google Ads credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Google Ads credentials from Secrets Manager');
  }
}

/**
 * Interface for V0 credentials returned from Secrets Manager
 */
export interface V0Credentials {
  apiKey: string;
}

/**
 * Get V0 Platform API key from AWS Secrets Manager.
 * Falls back to V0_API_KEY environment variable if Secrets Manager is unavailable.
 */
export async function getV0ApiKey(): Promise<string> {
  if (process.env.V0_API_KEY) {
    return process.env.V0_API_KEY;
  }

  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/V0'
      : 'dev/AgentWeb/V0';

    const secretString = await getSecret(secretName);
    if (!secretString || secretString.trim() === '') {
      throw new Error('V0 credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as V0Credentials;
    if (!credentials.apiKey) {
      throw new Error('V0 credentials missing apiKey');
    }

    return credentials.apiKey;
  } catch (error) {
    console.error('Error fetching V0 API key from Secrets Manager:', error);
    throw new Error('Failed to fetch V0 API key. Set V0_API_KEY env var or store in Secrets Manager.');
  }
}

interface GitHubOrgCredentials {
  orgToken: string;
  org: string;
}

/**
 * Get GitHub org-level token for creating repos under AgentWebPro.
 * Falls back to GITHUB_ORG_TOKEN environment variable.
 */
export async function getGitHubOrgToken(): Promise<{ token: string; org: string }> {
  if (process.env.GITHUB_ORG_TOKEN) {
    return { token: process.env.GITHUB_ORG_TOKEN, org: process.env.GITHUB_ORG || 'AgentWebPro' };
  }

  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/GitHub'
      : 'dev/AgentWeb/GitHub';

    const secretString = await getSecret(secretName);
    const credentials = JSON.parse(secretString) as GitHubOrgCredentials;
    if (!credentials.orgToken) {
      throw new Error('GitHub credentials missing orgToken');
    }

    return { token: credentials.orgToken, org: credentials.org || 'AgentWebPro' };
  } catch (error) {
    console.error('Error fetching GitHub org token from Secrets Manager:', error);
    throw new Error('Failed to fetch GitHub org token. Set GITHUB_ORG_TOKEN env var or store in Secrets Manager.');
  }
}

/**
 * Get Vercel API token for creating projects and deployments.
 * Falls back to VERCEL_TOKEN environment variable.
 */
export async function getVercelToken(): Promise<string> {
  if (process.env.VERCEL_TOKEN) {
    return process.env.VERCEL_TOKEN;
  }

  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Vercel'
      : 'dev/AgentWeb/Vercel';

    const secretString = await getSecret(secretName);
    const credentials = JSON.parse(secretString) as { token: string };
    if (!credentials.token) {
      throw new Error('Vercel credentials missing token');
    }

    return credentials.token;
  } catch (error) {
    console.error('Error fetching Vercel token from Secrets Manager:', error);
    throw new Error('Failed to fetch Vercel token. Set VERCEL_TOKEN env var or store in Secrets Manager.');
  }
}

/**
 * Interface for LinkedIn Ads OAuth credentials returned from Secrets Manager
 */
export interface LinkedInAdsCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Get LinkedIn Ads OAuth credentials from AWS Secrets Manager.
 * These are credentials for the separate MDP (Marketing Developer Platform) app,
 * distinct from the existing LinkedIn posting app.
 *
 * Secret location: dev/AgentWeb/LinkedIn/Ads (or prod/... for production)
 * Secret format: { "clientId": "...", "clientSecret": "..." }
 *
 * @returns The LinkedIn Ads client credentials (clientId and clientSecret)
 */
export async function getLinkedInAdsSecrets(): Promise<LinkedInAdsCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/LinkedIn/Ads'
      : 'dev/AgentWeb/LinkedIn/Ads';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('LinkedIn Ads credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as LinkedInAdsCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('LinkedIn Ads credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching LinkedIn Ads credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch LinkedIn Ads credentials from Secrets Manager');
  }
}

export interface FathomCredentials {
  clientId: string;
  clientSecret: string;
}

export async function getFathomCredentials(): Promise<FathomCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Fathom'
      : 'dev/AgentWeb/Fathom';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Fathom credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as FathomCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Fathom credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Fathom credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Fathom credentials from Secrets Manager');
  }
}

export interface ClickUpCredentials {
  clientId: string;
  clientSecret: string;
}

export async function getClickUpCredentials(): Promise<ClickUpCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/ClickUp'
      : 'dev/AgentWeb/ClickUp';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('ClickUp credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as ClickUpCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('ClickUp credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching ClickUp credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch ClickUp credentials from Secrets Manager');
  }
}

export interface StripeCredentials {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  starterPriceId: string;
  completePriceId: string;
}

/**
 * Get Stripe credentials from AWS Secrets Manager.
 * Populates process.env so the rest of the app can read STRIPE_* vars.
 */
export async function getStripeCredentials(): Promise<StripeCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Stripe'
      : 'dev/AgentWeb/Stripe';

    const secretString = await getSecret(secretName);
    const credentials = JSON.parse(secretString) as StripeCredentials;
    if (!credentials.secretKey) {
      throw new Error('Stripe credentials missing secretKey');
    }

    // Populate env vars so the rest of the app can use them
    process.env.STRIPE_SECRET_KEY = credentials.secretKey;
    process.env.STRIPE_PUBLISHABLE_KEY = credentials.publishableKey;
    process.env.STRIPE_WEBHOOK_SECRET = credentials.webhookSecret;
    process.env.STRIPE_STARTER_PRICE_ID = credentials.starterPriceId;
    process.env.STRIPE_COMPLETE_PRICE_ID = credentials.completePriceId;

    return credentials;
  } catch (error) {
    console.error('Error fetching Stripe credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Stripe credentials. Store in Secrets Manager at dev/AgentWeb/Stripe or prod/AgentWeb/Stripe.');
  }
}

export interface HubSpotCredentials {
  clientId: string;
  clientSecret: string;
  developerApiKey?: string;
  hubspotAppId?: string;
}

export async function getHubSpotCredentials(): Promise<HubSpotCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/HubSpot'
      : 'dev/AgentWeb/HubSpot';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('HubSpot credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as HubSpotCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('HubSpot credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching HubSpot credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch HubSpot credentials from Secrets Manager');
  }
}

/**
 * Get 2captcha API key from AWS Secrets Manager.
 * Secret format: plain string API key (not JSON).
 */
export async function get2CaptchaApiKey(): Promise<string> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/2Captcha'
    : 'dev/AgentWeb/2Captcha';
  const key = await getSecret(secretName);
  if (!key || key.trim() === '') {
    throw new Error(`2captcha API key is empty. Store it in Secrets Manager at ${secretName}.`);
  }
  return key.trim();
}


export interface RankAICredentials {
  /** First-party key that suppresses RankAI's invisible reCAPTCHA on their signin page. */
  captchaBypassKey: string;
  /** Base signin URL, e.g. https://rankai.ai/signin */
  signinUrl: string;
  /** Account the scheduled report signs in as. */
  reportAccountEmail?: string;
  /** Dashboard the report reads. */
  dashboardId?: string;
}

/**
 * Get RankAI automation credentials from AWS Secrets Manager (ENG-795).
 *
 * Secret format: JSON at dev/AgentWeb/RankAI or prod/AgentWeb/RankAI. The
 * captcha bypass key is RankAI's own credential for their own bot protection —
 * it is sensitive, must never be committed or written into a chat prompt, and is
 * therefore always read at runtime from here.
 */
export async function getRankAICredentials(): Promise<RankAICredentials> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/RankAI'
    : 'dev/AgentWeb/RankAI';

  const raw = await getSecret(secretName);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Secret ${secretName} is not valid JSON. Expected keys: captchaBypassKey, signinUrl.`);
  }

  return {
    captchaBypassKey: parsed.captchaBypassKey,
    signinUrl: parsed.signinUrl,
    reportAccountEmail: parsed.reportAccountEmail,
    dashboardId: parsed.dashboardId,
  };
}

/**
 * Get the email-verification provider API key from AWS Secrets Manager.
 * Stored as a plain string at dev/AgentWeb/EnrichSo or prod/AgentWeb/EnrichSo.
 */
export async function getEnrichSoApiKey(): Promise<string> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/EnrichSo'
    : 'dev/AgentWeb/EnrichSo';
  const key = await getSecret(secretName);
  if (!key || key.trim() === '') {
    throw new Error(`Email verification API key is empty. Store it in Secrets Manager at ${secretName}.`);
  }
  return key.trim();
}

/**
 * Get the Enigma (company card-revenue data) API key from AWS Secrets Manager.
 * Stored as a plain string at dev/AgentWeb/Enigma or prod/AgentWeb/Enigma.
 */
export async function getEnigmaApiKey(): Promise<string> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/Enigma'
    : 'dev/AgentWeb/Enigma';
  const key = await getSecret(secretName);
  if (!key || key.trim() === '') {
    throw new Error(`Enigma API key is empty. Store it in Secrets Manager at ${secretName}.`);
  }
  return key.trim();
}

/**
 * Get the Okareo API token (OTel trace exporter, ENG-141) from AWS Secrets Manager.
 * Stored as a plain string at dev/AgentWeb/Okareo or prod/AgentWeb/Okareo.
 */
export async function getOkareoApiKey(): Promise<string> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/Okareo'
    : 'dev/AgentWeb/Okareo';
  const key = await getSecret(secretName);
  if (!key || key.trim() === '') {
    throw new Error(`Okareo API key is empty. Store it in Secrets Manager at ${secretName}.`);
  }
  return key.trim();
}

export interface ApolloCredentials {
  apiKey: string;
  webhookSecret?: string;
}

/**
 * Get the Apollo people-enrichment API key from AWS Secrets Manager.
 * Stored as JSON `{"apiKey":"…","webhookSecret":"…"}` at dev/AgentWeb/Apollo
 * or prod/AgentWeb/Apollo.
 */
export async function getApolloApiKey(): Promise<string> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/Apollo'
    : 'dev/AgentWeb/Apollo';
  const secretString = await getSecret(secretName);
  if (!secretString || secretString.trim() === '') {
    throw new Error(`Apollo credentials secret is empty. Store JSON {"apiKey","webhookSecret"} in Secrets Manager at ${secretName}.`);
  }
  const parsed = JSON.parse(secretString) as ApolloCredentials;
  if (!parsed.apiKey || parsed.apiKey.trim() === '') {
    throw new Error(`Apollo credentials at ${secretName} missing apiKey.`);
  }
  return parsed.apiKey.trim();
}

/**
 * Shared secret used to authenticate the Apollo waterfall webhook callback.
 * Apollo doesn't HMAC-sign webhook bodies and silently drops `webhook_headers`,
 * so we embed this value in the **URL path** of the webhook we hand Apollo
 * (/api/crm/webhooks/apollo/<secret>) and verify it on the receiving route
 * with a constant-time compare. Must be URL-safe (no characters needing
 * percent-encoding to round-trip cleanly).
 *
 * Resolution order: `APOLLO_WEBHOOK_SECRET` env var if set and non-empty,
 * otherwise the built-in default. The default ships intentionally so the
 * webhook works in dev without extra setup; production deploys should set
 * the env var to a rotated value.
 */
const DEFAULT_APOLLO_WEBHOOK_SECRET = 'dev_apl_wh_8k3p2x9qm7n4r5z6_v1';

export async function getApolloWebhookSecret(): Promise<string> {
  const fromEnv = process.env.APOLLO_WEBHOOK_SECRET?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_APOLLO_WEBHOOK_SECRET;
}

export interface AttioCredentials {
  clientId: string;
  clientSecret: string;
}

export async function getAttioCredentials(): Promise<AttioCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Attio'
      : 'dev/AgentWeb/Attio';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Attio credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as AttioCredentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Attio credentials missing clientId or clientSecret');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Attio credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Attio credentials from Secrets Manager');
  }
}

export interface LandingPagesConfig {
  ga4PropertyId: string;
  gscDomain: string;
  ga4MeasurementId?: string;
  /**
   * Additional domain→GA4 mappings beyond the base gscDomain/ga4PropertyId.
   * Lets the platform serve landing pages on more than one root domain (e.g.
   * audit pages on agentweb.pro alongside form pages on agentwebforms.com),
   * each with its own GA4 property + measurement ID. Resolved by
   * resolveLandingPageGa4 (utils/landingPageGa4.ts).
   */
  additionalDomains?: Array<{
    gscDomain: string;
    ga4PropertyId: string;
    ga4MeasurementId?: string;
  }>;
}

/**
 * Get landing pages analytics config from AWS Secrets Manager.
 * Used to auto-configure GSC domain and GA4 property when a landing page is deployed
 * to a subdomain of the configured gscDomain (e.g., agentwebforms.com).
 *
 * Secret location: dev/AgentWeb/LandingPages (or prod/AgentWeb/LandingPages)
 * Secret format: { "ga4PropertyId": "123456789", "gscDomain": "agentwebforms.com" }
 *
 * Returns null (non-throwing) if the secret does not exist or is inaccessible —
 * the deploy succeeds regardless, just without auto-configuration.
 */
/**
 * Get ElevenLabs API key from AWS Secrets Manager.
 * Secret location: dev/AgentWeb/ElevenLabs (or prod/AgentWeb/ElevenLabs)
 * Secret format: plain string API key (xi_...)
 */
export async function getElevenLabsApiKey(): Promise<string> {
  const secretName = process.env.NODE_ENV === 'production'
    ? 'prod/AgentWeb/ElevenLabs'
    : 'dev/AgentWeb/ElevenLabs';
  return (await getSecret(secretName)).trim();
}

/**
 * How long a resolved Placid token is reused before Secrets Manager is asked
 * again. The token is a long-lived API credential, not a session token, so
 * freshness is measured in rotations, not seconds; five minutes bounds how long
 * a rotated secret takes to be picked up.
 */
export const PLACID_TOKEN_TTL_MS = 5 * 60 * 1000;

let placidTokenCache: { value: string | null; expiresAt: number } | null = null;
let placidTokenInFlight: Promise<string | null> | null = null;

/** Test hook: forget any cached or in-flight Placid token lookup. */
export function __resetPlacidTokenCache(): void {
  placidTokenCache = null;
  placidTokenInFlight = null;
}

/**
 * Resolve the Placid private API token (ENG-698).
 *
 * Reads `prod/AgentWeb/Placid` (or `dev/…`) first. Harsha created the prod
 * secret on 2026-09-11 (ENG-1598) by migrating the token that had lived in the
 * Elastic Beanstalk environment, and described it as holding "a non-empty
 * `PLACID_PRIVATE_TOKEN` value". That phrasing fits both a JSON object keyed by
 * that name and a bare token string, and the secret itself is not readable from
 * here, so BOTH shapes are accepted rather than guessing one and breaking
 * production on the other.
 *
 * Falls back to `process.env.PLACID_PRIVATE_TOKEN` when the secret is absent or
 * unusable — which is the normal case in development, where no
 * `dev/AgentWeb/Placid` exists. The fallback is logged, not silent: the point of
 * ENG-698's migration is that production stops depending on the environment
 * variable, and a quiet fallback would let it keep doing so unnoticed.
 *
 * Returns null when neither source yields a token.
 */
async function resolvePlacidPrivateToken(): Promise<string | null> {
  const secretName = process.env.NODE_ENV === 'production'
    ? 'prod/AgentWeb/Placid'
    : 'dev/AgentWeb/Placid';

  try {
    const raw = (await getSecret(secretName)).trim();
    let token = raw;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed.PLACID_PRIVATE_TOKEN ?? parsed.privateToken ?? parsed.token;
      token = typeof value === 'string' ? value.trim() : '';
    }
    if (token) return token;
    console.warn(`[Placid] ${secretName} exists but holds no usable token; falling back to environment`);
  } catch (err: any) {
    console.warn(`[Placid] ${secretName} unavailable (${err?.message || err}); falling back to environment`);
  }

  const fromEnv = process.env.PLACID_PRIVATE_TOKEN?.trim();
  return fromEnv || null;
}

export async function getPlacidPrivateToken(): Promise<string | null> {
  // Cached, because this sits on interactive request paths — every editor-token
  // mint and every template-list load. The environment read it replaced was
  // free; an uncached Secrets Manager call on each is a network round trip and
  // a per-call AWS charge on every page view (CodeRabbit, PR #2901).
  //
  // Misses are cached too, deliberately. In development no dev/AgentWeb/Placid
  // exists, and caching only successes would re-attempt — and re-log — that
  // failed lookup on every single request.
  const now = Date.now();
  if (placidTokenCache && placidTokenCache.expiresAt > now) {
    return placidTokenCache.value;
  }

  // Concurrent callers share one lookup. Without this a cold cache under load
  // fans out into as many Secrets Manager reads as there are waiting requests.
  if (!placidTokenInFlight) {
    placidTokenInFlight = resolvePlacidPrivateToken()
      .then((value) => {
        placidTokenCache = { value, expiresAt: Date.now() + PLACID_TOKEN_TTL_MS };
        return value;
      })
      .finally(() => {
        placidTokenInFlight = null;
      });
  }
  return placidTokenInFlight;
}

/**
 * Get the platform-wide Foreplay API key from AWS Secrets Manager.
 * Stored as a plain string at dev/AgentWeb/Foreplay or prod/AgentWeb/Foreplay.
 * Returns null (non-throwing) if the secret does not exist — callers treat this as
 * "no platform key configured" and degrade gracefully.
 */
export async function getForeplayApiKey(): Promise<string | null> {
  try {
    const secretName = process.env.NODE_ENV === 'production'
      ? 'prod/AgentWeb/Foreplay'
      : 'dev/AgentWeb/Foreplay';
    const key = await getSecret(secretName);
    return key && key.trim() ? key.trim() : null;
  } catch (err: any) {
    console.warn(`[Foreplay] Platform API key not found in Secrets Manager (${process.env.NODE_ENV}): ${err?.code || err?.message}`);
    return null;
  }
}

export async function getLandingPagesConfig(): Promise<LandingPagesConfig | null> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/LandingPages'
      : 'dev/AgentWeb/LandingPages';

    const secretString = await getSecret(secretName);
    if (!secretString || secretString.trim() === '') {
      console.warn('[LandingPages] Config secret is empty — skipping auto-configure');
      return null;
    }

    const config = JSON.parse(secretString) as LandingPagesConfig;
    if (!config.ga4PropertyId || !config.gscDomain) {
      console.warn('[LandingPages] Config secret missing ga4PropertyId or gscDomain — skipping auto-configure');
      return null;
    }

    return config;
  } catch (error: any) {
    console.warn(`[LandingPages] Could not load config from Secrets Manager — skipping auto-configure: ${error.message}`);
    return null;
  }
}


export interface WhatsAppCredentials {
  /** Cloud API phone number id — the sender. Not the display phone number. */
  phoneNumberId: string;
  /** WhatsApp Business Account id — needed for template management. */
  wabaId: string;
  /** System-user token with whatsapp_business_messaging + whatsapp_business_management. */
  accessToken: string;
  /** Meta app secret — verifies the X-Hub-Signature-256 on inbound webhooks. */
  appSecret: string;
  /** Shared token echoed back on the webhook's GET subscription challenge. */
  webhookVerifyToken: string;
}

/**
 * Get WhatsApp Cloud API credentials (ENG-273).
 *
 * Env vars first, matching getGitHubOrgToken and Slack's SLACK_BOT_TOKEN: a test env
 * can be pointed at Meta's sandbox number by setting five variables, without needing
 * write access to Secrets Manager for a throwaway value. Otherwise the secret at
 * dev/AgentWeb/WhatsApp (or prod/... for production).
 *
 * The env set is used ONLY when complete. A partial set falls through to Secrets
 * Manager rather than being merged with it — mixing sources could pair one
 * environment's access token with another's phoneNumberId and send from the wrong number.
 *
 * Throws rather than returning a partial object: a missing appSecret would silently
 * disable inbound webhook signature verification, and a missing phoneNumberId would
 * send to the wrong number. Both fail closed.
 */
const WHATSAPP_ENV_VARS = {
  phoneNumberId: 'WHATSAPP_PHONE_NUMBER_ID',
  wabaId: 'WHATSAPP_WABA_ID',
  accessToken: 'WHATSAPP_ACCESS_TOKEN',
  appSecret: 'WHATSAPP_APP_SECRET',
  webhookVerifyToken: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
} as const satisfies Record<keyof WhatsAppCredentials, string>;

let whatsappCredsCache: { value: WhatsAppCredentials; expiresAt: number } | null = null;
let whatsappCredsInFlight: Promise<WhatsAppCredentials> | null = null;
const WHATSAPP_CREDS_TTL_MS = 5 * 60 * 1000;

/** Test hook: forget any cached or in-flight Secrets-Manager-backed WhatsApp credentials. */
export function __resetWhatsAppCredentialsCache(): void {
  whatsappCredsCache = null;
  whatsappCredsInFlight = null;
}

async function fetchWhatsAppCredentialsFromSecretsManager(): Promise<WhatsAppCredentials> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/WhatsApp'
    : 'dev/AgentWeb/WhatsApp';

  const secretString = await getSecret(secretName);

  if (!secretString || secretString.trim() === '') {
    throw new Error('WhatsApp credentials secret is empty');
  }

  const credentials = JSON.parse(secretString) as WhatsAppCredentials;

  const missing = (['phoneNumberId', 'wabaId', 'accessToken', 'appSecret', 'webhookVerifyToken'] as const)
    .filter((k) => !credentials[k]);
  if (missing.length > 0) {
    throw new Error(`WhatsApp credentials missing: ${missing.join(', ')}`);
  }

  return credentials;
}

export async function getWhatsAppCredentials(): Promise<WhatsAppCredentials> {
  const fromEnv = {} as WhatsAppCredentials;
  const missingEnv: string[] = [];
  for (const [field, envName] of Object.entries(WHATSAPP_ENV_VARS)) {
    const value = process.env[envName]?.trim();
    if (value) fromEnv[field as keyof WhatsAppCredentials] = value;
    else missingEnv.push(envName);
  }
  // The env path is a synchronous, in-memory lookup — free, and re-reading it live
  // (rather than caching) means a changed env var takes effect immediately. Nothing
  // below this point needs caching UNTIL it is Secrets Manager, which is a network call.
  if (missingEnv.length === 0) return fromEnv;
  if (missingEnv.length < Object.keys(WHATSAPP_ENV_VARS).length) {
    // Some but not all set: almost certainly a forgotten variable, not an intent to
    // use Secrets Manager. Say so instead of silently ignoring the ones that ARE set.
    console.warn(
      `[whatsapp] ignoring partial WHATSAPP_* env config (missing: ${missingEnv.join(', ')}); ` +
        'falling back to Secrets Manager.',
    );
  }

  // Secrets Manager sits on the path of EVERY inbound webhook POST (signature
  // verification needs appSecret) and every outbound send — uncached, that is one
  // GetSecretValue call per request, adding latency before the signature check and
  // exposing the path to throttling under real traffic. Cached with a TTL, the same
  // shape as getPlacidPrivateToken's cache below.
  //
  // Only a SUCCESS is cached. Placid's cache also caches an absent secret, because
  // that is an expected, stable state in dev — a WhatsApp credentials fetch failing is
  // much more likely a real outage or misconfiguration, and caching THAT would turn one
  // bad Secrets Manager call into five minutes of every inbound STOP silently failing
  // to record. Concurrent callers share one in-flight lookup so a cold cache under a
  // burst of webhook traffic does not fan out into one Secrets Manager call each.
  const now = Date.now();
  if (whatsappCredsCache && whatsappCredsCache.expiresAt > now) {
    return whatsappCredsCache.value;
  }
  if (!whatsappCredsInFlight) {
    whatsappCredsInFlight = fetchWhatsAppCredentialsFromSecretsManager()
      .then((value) => {
        whatsappCredsCache = { value, expiresAt: Date.now() + WHATSAPP_CREDS_TTL_MS };
        return value;
      })
      .catch((error) => {
        console.error('Error fetching WhatsApp credentials from Secrets Manager:', error);
        throw new Error(
          'Failed to fetch WhatsApp credentials. Set all of the WHATSAPP_* env vars or store them in Secrets Manager.',
        );
      })
      .finally(() => {
        whatsappCredsInFlight = null;
      });
  }
  return whatsappCredsInFlight;
}

export interface TeamsBotCredentials {
  /** Microsoft App (client) ID of the bot's Entra app registration. */
  appId: string;
  /** Client secret for that app registration. */
  appPassword: string;
  /**
   * Home tenant of the Azure Bot resource.
   *
   * Required, not optional: Azure rejected `--app-type MultiTenant` as deprecated, so both
   * bots are SingleTenant. A single-tenant bot must request its Bot Connector token from
   * `login.microsoftonline.com/{tenantId}/...` rather than the shared `botframework.com`
   * endpoint, so without this every outbound reply fails to authenticate.
   */
  tenantId: string;
}

const TEAMS_BOT_ENV_VARS = {
  appId: 'TEAMS_BOT_APP_ID',
  appPassword: 'TEAMS_BOT_APP_PASSWORD',
  tenantId: 'TEAMS_BOT_TENANT_ID',
} as const satisfies Record<keyof TeamsBotCredentials, string>;

let teamsBotCredsCache: { value: TeamsBotCredentials; expiresAt: number } | null = null;
let teamsBotCredsInFlight: Promise<TeamsBotCredentials> | null = null;
const TEAMS_BOT_CREDS_TTL_MS = 5 * 60 * 1000;

/** Test hook: forget any cached or in-flight Secrets-Manager-backed Teams bot credentials. */
export function __resetTeamsBotCredentialsCache(): void {
  teamsBotCredsCache = null;
  teamsBotCredsInFlight = null;
}

async function fetchTeamsBotCredentialsFromSecretsManager(): Promise<TeamsBotCredentials> {
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/Microsoft/TeamsBot'
    : 'dev/AgentWeb/Microsoft/TeamsBot';

  const secretString = await getSecret(secretName);

  if (!secretString || secretString.trim() === '') {
    throw new Error('Teams bot credentials secret is empty');
  }

  const credentials = JSON.parse(secretString) as TeamsBotCredentials;

  const missing = (['appId', 'appPassword', 'tenantId'] as const).filter((k) => !credentials[k]);
  if (missing.length > 0) {
    throw new Error(`Teams bot credentials missing: ${missing.join(', ')}`);
  }

  return credentials;
}

/**
 * Get Azure Bot Service credentials for the Teams channel (ENG-272).
 *
 * Same shape as getWhatsAppCredentials above, for the same reason: these sit on the path of
 * every inbound Teams activity, so an uncached read would add a Secrets Manager round trip
 * before the request can even be authenticated.
 *
 * The env set is honoured ONLY when complete. A partial set falls through rather than being
 * merged, so the dev bot's appId can never be paired with the prod bot's secret.
 *
 * Note `prod/AgentWeb/Microsoft/TeamsBot` does not exist yet — the provisioning identity
 * lacked CreateSecret on prod/*, and the prod values are in 1Password. In production this
 * therefore throws until that secret is created. It deliberately does NOT fall back to the
 * dev secret: replying to a customer's tenant with the dev bot's identity would fail
 * authentication in a way that looks like a Teams outage rather than a missing secret.
 */
export async function getTeamsBotCredentials(): Promise<TeamsBotCredentials> {
  const fromEnv = {} as TeamsBotCredentials;
  const missingEnv: string[] = [];
  for (const [field, envName] of Object.entries(TEAMS_BOT_ENV_VARS)) {
    const value = process.env[envName]?.trim();
    if (value) fromEnv[field as keyof TeamsBotCredentials] = value;
    else missingEnv.push(envName);
  }
  if (missingEnv.length === 0) return fromEnv;
  if (missingEnv.length < Object.keys(TEAMS_BOT_ENV_VARS).length) {
    console.warn(
      `[teams] ignoring partial TEAMS_BOT_* env config (missing: ${missingEnv.join(', ')}); ` +
        'falling back to Secrets Manager.',
    );
  }

  const now = Date.now();
  if (teamsBotCredsCache && teamsBotCredsCache.expiresAt > now) {
    return teamsBotCredsCache.value;
  }
  if (!teamsBotCredsInFlight) {
    teamsBotCredsInFlight = fetchTeamsBotCredentialsFromSecretsManager()
      .then((value) => {
        teamsBotCredsCache = { value, expiresAt: Date.now() + TEAMS_BOT_CREDS_TTL_MS };
        return value;
      })
      .catch((error) => {
        console.error('Error fetching Teams bot credentials from Secrets Manager:', error);
        throw new Error(
          'Failed to fetch Teams bot credentials. Set all of the TEAMS_BOT_* env vars or store them in Secrets Manager.',
        );
      })
      .finally(() => {
        teamsBotCredsInFlight = null;
      });
  }
  return teamsBotCredsInFlight;
}
