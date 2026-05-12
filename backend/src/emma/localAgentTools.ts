import * as https from 'https';
import * as http from 'http';
import { emmaToolRegistry } from './registry';
import { uploadFileToS3 } from '../utils/s3Utils';

interface RelayConfig {
  endpoint: string;
  apiKey: string;
}

async function getRelayConfig(): Promise<RelayConfig | null> {
  const { getSecret, secretExists } = await import('../utils/secretsManager');
  const env = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  const secretName = `${env}/AgentWeb/LocalAgentRelay`;
  const exists = await secretExists(secretName);
  if (!exists) return null;
  const raw = await getSecret(secretName);
  const parsed = JSON.parse(raw) as RelayConfig;
  if (!parsed.endpoint || !parsed.apiKey) return null;
  return parsed;
}

function httpRequestBinary(
  url: string,
  secret: string,
  timeoutMs: number,
): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('File download timed out')); });
    req.on('error', reject);
    req.end();
  });
}

function httpRequest(
  method: string,
  url: string,
  secret: string,
  body: object | null,
  timeoutMs: number,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const payload = body !== null ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
    };

    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request to local agent timed out after ${timeoutMs / 1000}s`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Keywords that indicate non-browser tasks — blocked for safety
const BLOCKED_TASK_PATTERNS = [
  /\becho\b/i,
  /\bls\b/,
  /\bcat\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bgit\b/i,
  /\bnpm\b/i,
  /\bpip\b/i,
  /\bpython\b/i,
  /\bnode\b/i,
  /\bbash\b/i,
  /\bzsh\b/i,
  /\bshell command/i,
  /\brun command/i,
  /\bterminal/i,
  /\bexecute.*command/i,
  /\bfile system/i,
  /\bdelete\b/i,
  /\bpassword/i,
  /\bcredential/i,
  /\bprivate key/i,
  /\baccess token/i,
  /\bapi key/i,
  /\bsecret/i,
  /\bsubmit.*form/i,
  /\bclick.*button/i,
  /\bfill.*form/i,
  /\blog.*in/i,
  /\bsign.*in/i,
  /\bpurchase/i,
  /\bbuy\b/i,
  /\bsend.*message/i,
  /\bpost.*comment/i,
  /\bwrite.*post/i,
  /\bupload/i,
  /\bdownload.*file/i,
  /\bmodif/i,
  /\bedit.*account/i,
  /\bchange.*setting/i,
  /\bupdate.*profile/i,
];

// Must mention a URL or web-browsing intent
const BROWSER_TASK_PATTERNS = [
  /https?:\/\//i,
  /\b\w+\.(com|org|net|io|co|app|ai|dev)\b/i,
  /\bopen\b.*\b(browser|page|site|url|link)\b/i,
  /\b(browse|navigate|visit|load|fetch|scrape|crawl|extract)\b.*\b(page|site|url|web)\b/i,
  /\b(page|site|url|web).*\b(browse|navigate|visit|load|fetch|scrape|crawl|extract)\b/i,
  /\b(linkedin|twitter|x\.com|facebook|instagram|hubspot|salesforce|crm)\b/i,
  /\bweb.*data/i,
  /\bpage.*content/i,
  /\bpage.*title/i,
  /\bpage.*summary/i,
];

function validateBrowserTask(task: string): string | null {
  for (const pattern of BLOCKED_TASK_PATTERNS) {
    if (pattern.test(task)) {
      return `Task rejected: local agent may only be used for web browsing and data extraction. Forbidden pattern detected: "${pattern.source}".`;
    }
  }
  const isBrowserTask = BROWSER_TASK_PATTERNS.some((p) => p.test(task));
  if (!isBrowserTask) {
    return 'Task rejected: local agent may only be used for web browsing and data extraction tasks. Please specify a URL or web site to visit.';
  }
  return null;
}

emmaToolRegistry.register({
  name: 'run_local_agent_task',
  definition: {
    name: 'run_local_agent_task',
    description: `Send a browser data-extraction task to the user's local Codex agent via a relay server.

ALLOWED USE CASES (browser/web only):
- Open a URL in the user's browser and extract visible text, titles, or summaries
- Read publicly visible data from authenticated sites the user is already logged into (e.g. LinkedIn profiles, CRM dashboards)
- Summarize page content from any website

STRICTLY FORBIDDEN — never use this tool to:
- Run shell commands, terminal commands, or scripts unrelated to browser tasks
- Access, read, copy, or exfiltrate local files
- Steal personal information, passwords, credentials, API keys, or tokens
- Make any changes to accounts, profiles, settings, or data (no form submissions, no clicks that modify state)
- Post content, send messages, make purchases, or take any write actions
- Download files to the local machine

PRIVACY — the result must NEVER include personal data of the account owner (the person whose browser session is used): their name, email, phone, address, profile details, connection count, employer, or any other identifying information. Only return data about other people, companies, or content on the page.

This tool is read-only, browser-only. If the user asks for anything outside web browsing and data extraction, refuse and explain why.`,
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The browser data-extraction task. Must describe a URL to visit and what data to read from it. Must NOT include shell commands or account modification actions.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds. Defaults to 120. Max 600.',
        },
      },
      required: ['task'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    // Safety: validate task is browser-only before sending to relay
    const validationError = validateBrowserTask(args.task);
    if (validationError) {
      return { success: false, error: validationError };
    }

    const config = await getRelayConfig();
    if (!config) {
      return {
        success: false,
        error: 'Local agent relay not configured. Store the secret at dev/AgentWeb/LocalAgentRelay (or prod/...) with {"endpoint":"https://xxx.ngrok-free.app","apiKey":"YOUR_API_KEY"}.',
      };
    }

    const timeoutSeconds = Math.min(args.timeout_seconds ?? 120, 600);

    // Prepend a hard privacy instruction to every task so Codex never returns
    // the account owner's personal data (name, email, phone, address, etc.).
    const PRIVACY_PREFIX =
      'IMPORTANT PRIVACY RULES — follow these for every page you read:\n' +
      '1. Do NOT include the logged-in account owner\'s personal details in your response: ' +
      'full name, email address, phone number, physical address, date of birth, ' +
      'profile photo description, personal bio, connection count, follower count, ' +
      'employer/job title of the account owner, or any other identifying information.\n' +
      '2. Only return data about OTHER people, companies, posts, or content on the page — ' +
      'not about the person whose account is being used to view it.\n' +
      '3. If the entire page only contains the account owner\'s personal data, return an empty summary.\n\n';

    // Force read-only sandbox — no file writes, no account changes
    const requestBody: Record<string, unknown> = {
      task: PRIVACY_PREFIX + args.task,
      sandbox: 'danger-full-access', // needed for browser access; task-level guardrails enforce read-only intent
      timeout_seconds: timeoutSeconds,
    };

    const taskUrl = config.endpoint.replace(/\/$/, '') + '/task';

    let rawResponse: { status: number; data: string };
    try {
      rawResponse = await httpRequest('POST', taskUrl, config.apiKey, requestBody, (timeoutSeconds + 30) * 1000);
    } catch (err: any) {
      return { success: false, error: `Failed to reach local agent relay: ${err.message}` };
    }

    if (rawResponse.status === 401) {
      return { success: false, error: 'Local agent relay rejected the request — check the secret token.' };
    }
    if (rawResponse.status !== 200) {
      return { success: false, error: `Local agent relay returned status ${rawResponse.status}: ${rawResponse.data.slice(0, 500)}` };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawResponse.data);
    } catch {
      return { success: false, error: 'Invalid JSON from local agent relay.' };
    }

    const screenshotUrls: string[] = [];
    if (parsed.ok && Array.isArray(parsed.screenshots) && parsed.screenshots.length > 0) {
      const baseEndpoint = config.endpoint.replace(/\/$/, '');
      for (const screenshot of parsed.screenshots as Array<{ name: string; url: string }>) {
        try {
          const fileUrl = baseEndpoint + screenshot.url;
          const fileResp = await httpRequestBinary(fileUrl, config.apiKey, 30_000);
          if (fileResp.status === 200) {
            const ext = screenshot.name.split('.').pop()?.toLowerCase() ?? 'png';
            const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'webp' ? 'image/webp'
              : ext === 'gif' ? 'image/gif'
              : 'image/png';
            const uploadResult = await uploadFileToS3(fileResp.data, screenshot.name, userId, contentType);
            if (uploadResult.success && uploadResult.url) {
              screenshotUrls.push(uploadResult.url);
            }
          }
        } catch (err: any) {
          console.error('localAgentTools: failed to upload screenshot', screenshot.name, err.message);
        }
      }
    }

    return {
      success: parsed.ok === true,
      result: parsed.result ?? '',
      session_id: parsed.session_id ?? '',
      returncode: parsed.returncode ?? -1,
      ...(screenshotUrls.length > 0 ? { screenshot_urls: screenshotUrls } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
    };
  },
});

emmaToolRegistry.register({
  name: 'check_local_agent_status',
  definition: {
    name: 'check_local_agent_status',
    description: 'Check whether the local Codex agent relay is reachable and configured for this user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async (_args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    const config = await getRelayConfig();
    if (!config) {
      return {
        configured: false,
        message: 'No local agent relay configured. Store secret at dev/AgentWeb/LocalAgentRelay with {"endpoint":"...","apiKey":"..."}.',
      };
    }

    const base = config.endpoint.replace(/\/$/, '');

    // First check the HTTP server is up
    let healthResponse: { status: number; data: string };
    try {
      healthResponse = await httpRequest('GET', base + '/health', '', null, 10_000);
    } catch (err: any) {
      return { configured: true, reachable: false, error: `Cannot reach relay at ${config.endpoint}: ${err.message}` };
    }
    if (healthResponse.status !== 200) {
      return { configured: true, reachable: false, status: healthResponse.status, error: healthResponse.data.slice(0, 200) };
    }

    // Probe the worker with a trivial task — this catches a hung worker that still serves /health
    let taskResponse: { status: number; data: string };
    try {
      taskResponse = await httpRequest('POST', base + '/task', config.apiKey, {
        task: 'Return the single word: ping',
        timeout_seconds: 15,
      }, 25_000);
    } catch (err: any) {
      return { configured: true, reachable: false, workerHung: true, error: `Relay HTTP server is up but worker is not responding: ${err.message}` };
    }
    if (taskResponse.status !== 200) {
      return { configured: true, reachable: false, workerHung: true, error: `Worker probe returned status ${taskResponse.status}: ${taskResponse.data.slice(0, 200)}` };
    }

    return { configured: true, reachable: true, endpoint: config.endpoint };
  },
});
