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
    console.error(`Error fetching secret ${secretName}:`, error);
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
 * Interface for V0 credentials returned from Secrets Manager
 */
export interface V0Credentials {
  apiKey: string;
}

/**
 * Get V0 Platform API key from AWS Secrets Manager.
 * Falls back to V0_API_KEY environment variable if Secrets Manager is unavailable.
 *
 * Secret location: dev/AgentWeb/V0 (or prod/... for production)
 * Secret format: { "apiKey": "v1:team_..." }
 *
 * @returns The V0 API key string
 */
export async function getV0ApiKey(): Promise<string> {
  // Try env var first (useful for local dev and EB environment config)
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
