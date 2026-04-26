import AWS from 'aws-sdk';

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// Create DynamoDB document client. maxRetries: 3 (vs SDK default 10) caps the
// retry budget so one throttled GSI query doesn't burn ~10s of exponential
// backoff. See the matching note in services/db.ts.
export const dynamodb = new AWS.DynamoDB.DocumentClient({ maxRetries: 3 }); 