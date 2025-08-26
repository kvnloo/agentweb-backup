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
