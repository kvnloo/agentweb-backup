// Points the app's AWS SDK v2 DynamoDB clients at a local DynamoDB (DYNAMODB_ENDPOINT), without
// changing the app's code. Loaded with NODE_OPTIONS="--require /opslane/aws-local.cjs".
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (endpoint) {
  const AWS = require(require.resolve("aws-sdk", { paths: [process.cwd(), "/app"] }));
  AWS.config.update({ dynamodb: { endpoint } });
  console.error(`[opslane-local] DynamoDB -> ${endpoint}`);
}
