import * as https from 'https';
import * as http from 'http';
import { emmaToolRegistry } from './registry';
import { uploadFileToS3 } from '../utils/s3Utils';

interface RelayConfig {
  endpoint: string;
  apiKey: string;
}

interface RelayResponse {
  ok?: boolean;
  result?: unknown;
  session_id?: string;
  returncode?: number;
  error?: string;
}

/**
 * Map the relay's JSON response into the tool result. On failure the relay
 * sometimes returns `{ ok: false }` with the detail only in `result`/`returncode`
 * and no `error` — which the agent loop would surface as the opaque "Tool
 * returned success=false". Always populate a reason on failure so the model (and
 * the failure telemetry) get something actionable (dev.md "Theme 1").
 */
export function buildLocalAgentResult(
  parsed: RelayResponse,
  screenshotUrls: string[],
): { success: boolean; result: unknown; session_id: string; returncode: number; screenshot_urls?: string[]; error?: string } {
  const ok = parsed.ok === true;
  const result = parsed.result ?? '';
  const returncode = parsed.returncode ?? -1;
  const error = !ok
    ? (typeof parsed.error === 'string' && parsed.error.trim()) ||
      (typeof result === 'string' && result.trim()) ||
      `Local agent task failed (returncode ${returncode})`
    : typeof parsed.error === 'string'
      ? parsed.error.trim()
      : '';
  return {
    success: ok,
    result,
    session_id: parsed.session_id ?? '',
    returncode,
    ...(screenshotUrls.length > 0 ? { screenshot_urls: screenshotUrls } : {}),
    ...(error ? { error } : {}),
  };
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

// HARD-BLOCK: truly dangerous intents — never allowed regardless of read-only
// framing (shell/file/credential/transaction). These match a state-changing or
// security-sensitive ACTION the agent would be asked to perform.
const HARD_BLOCKED_TASK_PATTERNS = [
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
  /\bpassword/i,
  /\bcredential/i,
  /\bprivate key/i,
  /\baccess token/i,
  /\bapi key/i,
  /\bsecret/i,
  /\bpurchase/i,
  /\bbuy\b/i,
  /\bupload/i,
  /\bdownload.*file/i,
];

// SOFT-WRITE: phrases that USUALLY mean a write action but very often appear as
// read-only CONTEXT ("read the comments under this post", "find the text near the
// login button", "summarize what happens after you click Sign in"). Telemetry
// (Dev-AW-LoopEvents, June 2026) showed these regexes were the #1 source of
// run_local_agent_task false-positive rejections — `post.*comment`, `click.*button`,
// `log.*in` all fired on read-only tasks. We only treat them as blocking when the
// task does NOT also carry clear read-only intent.
const SOFT_WRITE_TASK_PATTERNS = [
  /\bsubmit.*form/i,
  /\bclick.*button/i,
  /\bfill.*form/i,
  /\blog.*in/i,
  /\bsign.*in/i,
  /\bsend.*message/i,
  /\bpost.*comment/i,
  /\bwrite.*post/i,
  /\bdelete\b/i,
  /\bmodif/i,
  /\bedit.*account/i,
  /\bchange.*setting/i,
  /\bupdate.*profile/i,
];

// Clear read-only intent — when present, the soft-write phrases above are treated
// as descriptive context, not as an action the agent is being asked to perform.
const READ_ONLY_INTENT_PATTERNS = [
  /\b(read|reads|reading)\b/i,
  /\b(extract|extracts|extracting)\b/i,
  /\b(scrape|scrapes|scraping|crawl|crawling)\b/i,
  /\b(summari[sz]e|summary)\b/i,
  /\b(list|lists|listing)\b/i,
  /\b(find|finds|finding|gather|collect)\b/i,
  /\b(get|grab|capture|view|see|check|look\s+at)\b.*\b(text|content|data|title|info|details|posts?|comments?|profile)\b/i,
  /\bwhat (does|is|are)\b/i,
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

const SCOPE_GUIDANCE =
  'run_local_agent_task only handles READ-ONLY web browsing and data extraction (visit a URL, read/scrape page content). ' +
  'It cannot run commands, edit files or accounts, submit forms, log in, send messages, or handle credentials. ' +
  'Do not retry this task here — use coding_agent for code changes, perform_data_analysis for data analysis, ' +
  'you_search_web for research, or the dedicated tool for the action you need (e.g. linkedin_outreach, send_email).';

function hasReadOnlyIntent(task: string): boolean {
  return READ_ONLY_INTENT_PATTERNS.some((p) => p.test(task));
}

/**
 * Validate that a task is in-scope (read-only browsing). Returns null when the
 * task is allowed, otherwise a human-readable rejection reason that names the
 * right alternative tool.
 *
 * Telemetry-driven (Dev-AW-LoopEvents, June 2026): scope-rejections were the #1
 * run_local_agent_task failure cluster (~14/20, ~54% of failures), dominated by
 * SOFT-WRITE false positives on read-only tasks. We now (1) hard-block only truly
 * dangerous intents and (2) treat soft-write phrases as descriptive context when
 * the task also has clear read-only intent — keeping the safety floor while cutting
 * the false-positive rejections.
 */
export function validateBrowserTask(task: string): string | null {
  for (const pattern of HARD_BLOCKED_TASK_PATTERNS) {
    if (pattern.test(task)) {
      return `Task rejected (matched forbidden pattern "${pattern.source}"). ${SCOPE_GUIDANCE}`;
    }
  }
  // Soft-write phrases only block when the task is NOT clearly read-only. A task
  // like "read the comments under this LinkedIn post" should pass; "post a comment
  // on this LinkedIn page" should not.
  if (!hasReadOnlyIntent(task)) {
    for (const pattern of SOFT_WRITE_TASK_PATTERNS) {
      if (pattern.test(task)) {
        return `Task rejected (matched forbidden pattern "${pattern.source}"). ${SCOPE_GUIDANCE}`;
      }
    }
  }
  const isBrowserTask = BROWSER_TASK_PATTERNS.some((p) => p.test(task));
  if (!isBrowserTask) {
    return `Task rejected: no URL or web-browsing intent found in the task. ${SCOPE_GUIDANCE} If you do want a page read, restate the task with the specific URL to visit.`;
  }
  return null;
}

/**
 * Pick the most relevant alternative tool name to route the model to, based on
 * what the rejected task was trying to do. Used to make scope-rejections an
 * actionable, model-correctable signal instead of a dead end.
 */
export function suggestAlternativeTool(task: string): string {
  if (/\b(code|repo|repository|commit|deploy|build|script|function|bug|fix)\b/i.test(task)) return 'coding_agent';
  if (/\b(analyz|analys|data analysis|metrics|chart|spreadsheet|csv|dataset)\b/i.test(task)) return 'perform_data_analysis';
  if (/\b(post|comment|message|dm|connect|invite|outreach)\b/i.test(task) && /\blinkedin\b/i.test(task)) return 'linkedin_outreach';
  if (/\b(dm|follow|unfollow|profile|block|mute|bookmark|search)\b/i.test(task) && /\b(twitter|x|tweet)\b/i.test(task)) return 'twitter_outreach';
  if (/\b(tweet|thread|reply|post|like|retweet|quote)\b/i.test(task) && /\b(twitter|x|tweet)\b/i.test(task)) return 'twitter_manage_post';
  if (/\b(send|email|reply)\b/i.test(task) && /\bemail\b/i.test(task)) return 'send_email';
  return 'you_search_web';
}

/**
 * Shape a scope-rejection as a GRACEFUL, model-correctable outcome rather than a
 * hard tool failure. Telemetry (June 2026) showed these rejections being recorded
 * as `agent_tool_failed` (downgraded from success=false), inflating the
 * run_local_agent_task failure rate and feeding the repeated-failure circuit
 * breaker — even though the validator did its job and the model just needs to pick
 * a different tool. We return success=true with `rejected:true` + guidance so the
 * dispatch layer does NOT count it as a failure, and the model gets a clear
 * redirect. The legit success path is unchanged.
 */
export function buildScopeRejectionResult(reason: string, suggestedTool: string): {
  success: true;
  rejected: true;
  guidance: string;
  suggestedTool: string;
  formattedContent: string;
} {
  const guidance = `${reason} Suggested next tool: ${suggestedTool}.`;
  return {
    success: true,
    rejected: true,
    guidance,
    suggestedTool,
    formattedContent: guidance,
  };
}

export function buildLocalAgentUnavailableResult(
  reason: 'not_configured' | 'unreachable' | 'auth_failed' | 'bad_response',
  message: string,
): {
  success: true;
  unavailable: true;
  reason: string;
  message: string;
  formattedContent: string;
} {
  return {
    success: true,
    unavailable: true,
    reason,
    message,
    formattedContent:
      `${message}\n\n` +
      'The local browser relay is unavailable, but this is only a fallback. ' +
      'Do not retry run_local_agent_task in this run; continue the website scan with the cloud Playwright browser tools, read_page_source, and search tools. ' +
      'If the cloud browser can load enough page content, complete the audit from that evidence. ' +
      'If bot protection blocks all cloud-browser evidence, report that manual browser verification is needed instead of marking the whole scan as an internal tool failure.',
  };
}

emmaToolRegistry.register({
  name: 'run_local_agent_task',
  definition: {
    name: 'run_local_agent_task',
    description: `Send a browser data-extraction task to the user's local Codex agent via a relay server. The local agent runs a real (non-headless) browser remotely, bypassing bot protection that blocks the headless cloud browser.

USE THIS TOOL AS A FALLBACK when the headless browser (Playwright) fails to load a website properly:
- The page returns a blank/white screen or renders nothing useful
- Bot protection, Cloudflare, or anti-scraping measures block the headless browser
- Static assets return 429 (Too Many Requests) or access-denied errors
- A React/JS framework crashes (e.g. missing provider, chunk load error) causing a blank page
- The page consistently shows an error screen in the cloud browser despite retries

ALWAYS check: after navigating and taking a screenshot, if the page appears blank or broken, try this tool before giving up.

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
          description: 'Timeout in seconds. Defaults to 120. Max 900.',
        },
      },
      required: ['task'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    // Safety: validate task is browser-only before sending to relay.
    // A scope-rejection is a GRACEFUL, model-correctable outcome (the validator
    // worked; the model just needs a different tool), NOT a hard tool failure —
    // return success=true + guidance so the dispatch layer does not record it as
    // `agent_tool_failed` or trip the repeated-failure breaker. (Telemetry-driven,
    // Dev-AW-LoopEvents June 2026: scope-rejections were ~54% of this tool's
    // recorded failures.)
    const validationError = validateBrowserTask(args.task);
    if (validationError) {
      return buildScopeRejectionResult(validationError, suggestAlternativeTool(args.task));
    }

    const config = await getRelayConfig();
    if (!config) {
      return buildLocalAgentUnavailableResult(
        'not_configured',
        'Local agent relay is not configured for this environment.',
      );
    }

    const timeoutSeconds = Math.min(args.timeout_seconds ?? 120, 900);

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
      rawResponse = await httpRequest('POST', taskUrl, config.apiKey, requestBody, (timeoutSeconds + 90) * 1000);
    } catch (err: any) {
      return buildLocalAgentUnavailableResult(
        'unreachable',
        `Failed to reach local agent relay: ${err.message}`,
      );
    }

    if (rawResponse.status === 401) {
      return buildLocalAgentUnavailableResult(
        'auth_failed',
        'Local agent relay rejected the request.',
      );
    }
    if (rawResponse.status !== 200) {
      return buildLocalAgentUnavailableResult(
        'bad_response',
        `Local agent relay returned status ${rawResponse.status}: ${rawResponse.data.slice(0, 200)}`,
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawResponse.data);
    } catch {
      return buildLocalAgentUnavailableResult(
        'bad_response',
        'Invalid JSON from local agent relay.',
      );
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

    return buildLocalAgentResult(parsed, screenshotUrls);
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

    // Probe the worker with a trivial task — this catches a hung worker that still serves /health.
    // The relay is single-threaded; if it's mid-task it won't respond until it finishes, so allow 120s.
    let taskResponse: { status: number; data: string };
    try {
      taskResponse = await httpRequest('POST', base + '/task', config.apiKey, {
        task: 'Return the single word: ping',
        timeout_seconds: 90,
      }, 120_000);
    } catch (err: any) {
      return { configured: true, reachable: false, workerHung: true, error: `Relay HTTP server is up but worker is not responding within 120s: ${err.message}` };
    }
    if (taskResponse.status !== 200) {
      return { configured: true, reachable: false, workerHung: true, error: `Worker probe returned status ${taskResponse.status}: ${taskResponse.data.slice(0, 200)}` };
    }

    return { configured: true, reachable: true, endpoint: config.endpoint };
  },
});
