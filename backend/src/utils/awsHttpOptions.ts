/**
 * awsHttpOptions — shared HTTP options for the aws-sdk v2 global config.
 * ENG-749 contributor #3.
 *
 * aws-sdk v2 does not reuse connections by default (unlike v3). Every DynamoDB
 * call on a cold socket pays a fresh TCP + TLS handshake. `POST /api/auth/login`
 * makes three sequential awaited DynamoDB calls, so that cost is paid three times
 * before the app can open.
 *
 * A keep-alive agent is AWS's documented fix for v2 ("Reusing connections with
 * keep-alive in Node.js"). maxSockets matches the SDK's own default of 50, so this
 * changes reuse only, not concurrency.
 *
 * ENG-2598: an https.Agent cannot send an http:// request, and DynamoDB Local speaks plain
 * http. When DYNAMODB_LOCAL_ENDPOINT is an http:// URL no agent is attached, so the opt-in
 * real-DynamoDB suites run unmocked. Real DynamoDB is always https and keeps the agent.
 */
import https from "https";

export const AWS_HTTP_MAX_SOCKETS = 50;

let sharedAgent: https.Agent | undefined;

/** One process-wide keep-alive agent, created lazily. */
export function getAwsKeepAliveAgent(): https.Agent {
  if (!sharedAgent) {
    sharedAgent = new https.Agent({ keepAlive: true, maxSockets: AWS_HTTP_MAX_SOCKETS });
  }
  return sharedAgent;
}

/** True when the DynamoDB endpoint override is a plain http:// URL (DynamoDB Local). */
export function isPlainHttpDynamoEndpoint(endpoint: string | undefined): boolean {
  return typeof endpoint === "string" && /^http:\/\//i.test(endpoint.trim());
}

export function buildAwsHttpOptions(): { agent?: https.Agent } {
  return isPlainHttpDynamoEndpoint(process.env.DYNAMODB_LOCAL_ENDPOINT) ? {} : { agent: getAwsKeepAliveAgent() };
}
