import crypto from 'crypto';
import AWS from 'aws-sdk';

const API_URL = process.env.STAGING_API_URL || 'https://api-stage.agentweb.pro';
const AUTH_TOKEN = process.env.STAGING_SMOKE_AUTH_TOKEN;
const PAGE_ID = process.env.STAGING_SMOKE_PAGE_ID;
const TIMEOUT_MS = Number(process.env.STAGING_SMOKE_TIMEOUT_MS || 12 * 60 * 1000);
const V0_USAGE_TABLE = process.env.V0_USAGE_TABLE_NAME || 'AW-V0Usage';
const CONSOLE_ALLOW_PATTERNS = (process.env.STAGING_SMOKE_CONSOLE_ALLOW_PATTERNS || '')
  .split('\n')
  .flatMap((line) => line.split(','))
  .map((pattern) => pattern.trim())
  .filter(Boolean);
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${required('STAGING_SMOKE_AUTH_TOKEN', AUTH_TOKEN)}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${JSON.stringify(body).slice(0, 1000)}`);
  }
  return body;
}

function findCodingAgentResult(response: any): any {
  const calls = response?.toolCalls || response?.session?.toolCalls || response?.session?.messages?.flatMap((m: any) => m.toolCalls || []) || [];
  const match = calls.find((call: any) => call?.name === 'coding_agent' || call?.toolName === 'coding_agent');
  return match?.result || match;
}

async function sendSessionMessage(sessionId: string, message: string, pageId: string): Promise<any> {
  return api(`/api/chatbot/sessions/${sessionId}/messages?portal=customer`, {
    method: 'POST',
    body: JSON.stringify({ message, pageContext: `Disposable landing page id: ${pageId}` }),
  });
}

async function countV0UsageAttemptsSince(scopeId: string, sinceIso: string): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const res = await dynamodb.scan({
      TableName: V0_USAGE_TABLE,
      ProjectionExpression: 'idempotencyKey',
      FilterExpression: 'scopeId = :scopeId AND updatedAt >= :sinceIso',
      ExpressionAttributeValues: {
        ':scopeId': scopeId,
        ':sinceIso': sinceIso,
      },
      ExclusiveStartKey,
    }).promise();
    count += res.Count || 0;
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

async function main() {
  const pageId = required('STAGING_SMOKE_PAGE_ID', PAGE_ID);
  const token = `aw_smoke_${crypto.randomBytes(8).toString('hex')}`;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  const session = await api('/api/chatbot/sessions?portal=customer', {
    method: 'POST',
    body: JSON.stringify({
      pageIdentifier: 'customer-portal',
      pageContext: 'Coding-agent staging smoke. Use only the supplied disposable page.',
    }),
  });
  const sessionId = session.sessionId || session.id;
  if (!sessionId) throw new Error(`Could not create smoke session: ${JSON.stringify(session).slice(0, 1000)}`);

  const message = [
    `Use coding_agent exactly once on landing page ${pageId}.`,
    `Add the opaque verification token ${token} somewhere visible on the page without changing the page's meaning.`,
    `Pass typed acceptance checks only: HTTP 200, text_present for ${token}, no_console_errors, and no_external_hosts.`,
    CONSOLE_ALLOW_PATTERNS.length
      ? `For no_console_errors, pass these allowPatterns exactly: ${JSON.stringify(CONSOLE_ALLOW_PATTERNS)}.`
      : '',
    `Do not generate a new landing page and do not call v0.`,
    `Do not call install_skills or any other setup/discovery tool.`,
    `This is a staging smoke test and no further confirmation is needed; choose an unobtrusive visible location and proceed now.`,
  ].filter(Boolean).join(' ');

  let response = await sendSessionMessage(sessionId, message, pageId);

  let result = findCodingAgentResult(response);
  for (let attempt = 1; !result && attempt <= 3; attempt++) {
    response = await sendSessionMessage(
      sessionId,
      [
        `Proceed now by calling coding_agent. Do not ask for confirmation.`,
        `Do not call install_skills, generate_landing_page, v0, or any tool except coding_agent.`,
        `Use page ${pageId}, add visible token ${token}, and pass typed checks: http_status 200, text_present ${token}, no_console_errors, no_external_hosts.`,
        CONSOLE_ALLOW_PATTERNS.length
          ? `For no_console_errors, include allowPatterns exactly ${JSON.stringify(CONSOLE_ALLOW_PATTERNS)}.`
          : '',
      ].filter(Boolean).join(' '),
      pageId
    );
    result = findCodingAgentResult(response);
  }
  if (!result) {
    throw new Error(`coding_agent result was not found in response: ${JSON.stringify(response).slice(0, 2000)}`);
  }
  if (result.state !== 'passed' && result.acceptanceStatus !== 'passed') {
    throw new Error(`coding_agent did not pass: ${JSON.stringify(result).slice(0, 3000)}`);
  }
  if (!result.previewUrl) {
    throw new Error(`coding_agent passed without previewUrl: ${JSON.stringify(result).slice(0, 2000)}`);
  }

  const preview = await fetch(result.previewUrl);
  const html = await preview.text();
  if (preview.status !== 200) throw new Error(`Preview returned HTTP ${preview.status}`);
  if (!html.includes(token)) throw new Error(`Preview HTML does not contain smoke token ${token}`);
  const v0UsageCount = await countV0UsageAttemptsSince(pageId, startedAt);
  if (v0UsageCount !== 0) {
    throw new Error(`coding_agent smoke unexpectedly recorded ${v0UsageCount} v0 usage attempt(s) for page ${pageId}`);
  }

  const artifacts = {
    ok: true,
    token,
    sessionId,
    runId: result.runId,
    state: result.state,
    acceptanceStatus: result.acceptanceStatus,
    previewUrl: result.previewUrl,
    branch: result.branch,
    verification: result.verification || result.acceptance,
    v0UsageCount,
    elapsedMs: Date.now() - started,
  };
  console.log(JSON.stringify(artifacts, null, 2));

  if (Date.now() - started > TIMEOUT_MS) {
    throw new Error(`Smoke exceeded timeout budget ${TIMEOUT_MS}ms`);
  }
}

main().catch((error) => {
  console.error('[coding-agent-staging-smoke] FAILED', error);
  process.exit(1);
});
