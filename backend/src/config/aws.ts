import AWS from 'aws-sdk';

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  // Leave the SDK's normal credential-provider chain intact when explicit
  // credentials are not configured. Passing accessKeyId/secretAccessKey here
  // unconditionally (even as undefined) short-circuits the default provider
  // chain and masks valid shared-profile / instance-role credentials used by
  // migration scripts and local tooling — same fix as db.ts's guard.
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN
          ? { sessionToken: process.env.AWS_SESSION_TOKEN }
          : {}),
      }
    : {}),
});

// Create DynamoDB document client
export const dynamodb = new AWS.DynamoDB.DocumentClient(); 