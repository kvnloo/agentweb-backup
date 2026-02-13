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
 * Interface for Instagram (Meta) credentials returned from Secrets Manager
 */
export interface InstagramCredentials {
  appId: string;
  appSecret: string;
  webhookVerifyToken: string;
  configId: string;
}

/**
 * Get Instagram (Meta) OAuth credentials from AWS Secrets Manager
 * These are the Facebook/Meta App credentials used for Instagram Graph API.
 *
 * Secret location: dev/AgentWeb/Instagram (or prod/... for production)
 *
 * @returns The Instagram app credentials (appId and appSecret)
 */
export async function getInstagramCredentials(): Promise<InstagramCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Instagram'
      : 'dev/AgentWeb/Instagram';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Instagram credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as InstagramCredentials;

    if (!credentials.appId || !credentials.appSecret || !credentials.webhookVerifyToken || !credentials.configId) {
      throw new Error('Instagram credentials missing appId, appSecret, webhookVerifyToken, or configId');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Instagram credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Instagram credentials from Secrets Manager');
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

