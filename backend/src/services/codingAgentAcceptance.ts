export type AcceptanceStatus = 'not_run' | 'passed' | 'failed' | 'blocked';

export type PublicAcceptanceCheck =
  | {
      type: 'http_status';
      label?: string;
      url?: string;
      method?: 'GET' | 'HEAD';
      expectStatus?: number;
    }
  | {
      type: 'text_present';
      label?: string;
      url?: string;
      selector?: string;
      text: string;
    }
  | {
      type: 'selector_exists';
      label?: string;
      url?: string;
      selector: string;
    }
  | {
      type: 'no_console_errors';
      label?: string;
      url?: string;
      allowPatterns?: string[];
    }
  | {
      type: 'no_external_hosts';
      label?: string;
      url?: string;
      allowHosts?: string[];
      denyPatterns?: string[];
    };

export type InternalAcceptanceCheck =
  | PublicAcceptanceCheck
  | {
      type: 'browser_eval';
      label?: string;
      url?: string;
      script: string;
      expect?: unknown;
    }
  | {
      type: 'dom_text';
      label?: string;
      url?: string;
      selector?: string;
      text: string;
    }
  | {
      type: 'console_errors';
      label?: string;
      url?: string;
      allowPatterns?: string[];
    };

export type AcceptanceCheck = InternalAcceptanceCheck;

export interface AcceptanceCheckResult {
  id: string;
  type: AcceptanceCheck['type'];
  label: string;
  status: Exclude<AcceptanceStatus, 'not_run'>;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export interface AcceptanceVerificationResult {
  status: AcceptanceStatus;
  checks: AcceptanceCheckResult[];
  summary: string;
}

export type ExecuteMcpTool = (toolName: string, args: any) => Promise<any>;

interface VerifyAcceptanceChecksOptions {
  checks?: AcceptanceCheck[];
  previewUrl?: string;
  executeMcpTool?: ExecuteMcpTool;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  checkTimeoutMs?: number;
  previewRetryCount?: number;
  previewRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_PREVIEW_RETRY_COUNT = 2;
const DEFAULT_PREVIEW_RETRY_DELAY_MS = 2_000;

function labelFor(check: AcceptanceCheck, index: number): string {
  return check.label?.trim() || `${check.type} #${index + 1}`;
}

function checkId(index: number): string {
  return `check_${index + 1}`;
}

function resolveUrl(check: AcceptanceCheck, previewUrl?: string): string | undefined {
  const url = 'url' in check ? check.url : undefined;
  if (url && url.trim()) {
    return previewUrl ? url.replace(/\{\{\s*previewUrl\s*\}\}/g, previewUrl) : url;
  }
  return previewUrl;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sleepWithAbort(ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (sleep) return sleep(ms);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const err: any = new Error('Acceptance verification was cancelled.');
  err.name = 'AbortError';
  return err;
}

function timeoutError(ms: number): Error {
  const err: any = new Error(`Acceptance check timed out after ${Math.round(ms / 1000)}s.`);
  err.name = 'TimeoutError';
  return err;
}

async function withCheckTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw abortError();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
      timer.unref?.();
      onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}

function parseTextValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const resultMatch = trimmed.match(/### Result\s*\n([\s\S]*?)(?:\n### |\n```|$)/);
  const valueText = (resultMatch?.[1] || trimmed).trim();
  if (valueText === 'true') return true;
  if (valueText === 'false') return false;
  if (valueText === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(valueText)) return Number(valueText);

  try {
    return JSON.parse(valueText);
  } catch {
    return valueText;
  }
}

export function normalizeBrowserToolValue(result: any): unknown {
  if (result == null) return result;
  if (typeof result !== 'object') return result;
  if ('result' in result) return result.result;
  if ('value' in result) return result.value;
  if (typeof result.content === 'string') return parseTextValue(result.content);
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return parseTextValue(text);
  }
  const textBlock = Array.isArray(result.raw?.content)
    ? result.raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string')
    : undefined;
  if (textBlock) return parseTextValue(textBlock.text);
  return result;
}

async function runBrowserEval(
  executeMcpTool: ExecuteMcpTool,
  url: string,
  scriptBody: string
): Promise<unknown> {
  await executeMcpTool('playwright_browser_navigate', { url });
  const source = /^\s*(async\s*)?\(?\s*\)?\s*=>/.test(scriptBody)
    ? scriptBody
    : `async () => {\n${scriptBody}\n}`;
  const result = await executeMcpTool('playwright_browser_evaluate', { function: source });
  return normalizeBrowserToolValue(result);
}

async function runTextPresentCheck(
  executeMcpTool: ExecuteMcpTool,
  url: string,
  selector: string | undefined,
  text: string
): Promise<unknown> {
  const escapedSelector = JSON.stringify(selector || 'body');
  const escapedText = JSON.stringify(text);
  return runBrowserEval(
    executeMcpTool,
    url,
    `const el = document.querySelector(${escapedSelector});
return Boolean(el && (el.textContent || '').includes(${escapedText}));`
  );
}

async function runSelectorExistsCheck(
  executeMcpTool: ExecuteMcpTool,
  url: string,
  selector: string
): Promise<unknown> {
  const escapedSelector = JSON.stringify(selector);
  return runBrowserEval(
    executeMcpTool,
    url,
    `return Boolean(document.querySelector(${escapedSelector}));`
  );
}

async function runConsoleErrorsCheck(
  executeMcpTool: ExecuteMcpTool,
  url: string,
  allowPatterns: string[] | undefined
): Promise<unknown> {
  await executeMcpTool('playwright_browser_navigate', { url });
  const result = await executeMcpTool('playwright_browser_console_messages', { level: 'error' });
  const value = normalizeBrowserToolValue(result);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const allow = (allowPatterns || []).map((p) => new RegExp(p, 'i'));
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\b(error|failed|uncaught|exception)\b/i.test(line))
    .filter((line) => !allow.some((pattern) => pattern.test(line)));
}

async function runNoExternalHostsCheck(
  executeMcpTool: ExecuteMcpTool,
  url: string,
  allowHosts: string[] | undefined,
  denyPatterns: string[] | undefined
): Promise<string[]> {
  const allow = new Set((allowHosts || []).map((h) => h.toLowerCase()));
  const deny = (denyPatterns || [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnfonts',
  ]).map((p) => new RegExp(p, 'i'));
  const actualUrl = new URL(url);
  allow.add(actualUrl.host.toLowerCase());

  const resources = await runBrowserEval(
    executeMcpTool,
    url,
    `return Array.from(document.querySelectorAll('link[href], script[src], img[src], source[src], iframe[src]'))
      .map((el) => el.getAttribute('href') || el.getAttribute('src'))
      .filter(Boolean)
      .map((value) => new URL(value, location.href).host);`
  );
  const hosts = Array.isArray(resources) ? resources.map(String) : [];
  return Array.from(new Set(hosts))
    .filter((host) => !allow.has(host.toLowerCase()))
    .filter((host) => deny.length === 0 || deny.some((pattern) => pattern.test(host)));
}

async function fetchWithPreviewRetry(
  url: string,
  method: 'GET' | 'HEAD',
  expectedStatus: number,
  options: VerifyAcceptanceChecksOptions
): Promise<Response> {
  const fetcher = options.fetchImpl || fetch;
  const attempts = Math.max(1, (options.previewRetryCount ?? DEFAULT_PREVIEW_RETRY_COUNT) + 1);
  let lastResponse: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw abortError();
    const response = await fetcher(url, { method, signal: options.signal } as any);
    lastResponse = response;
    if (response.status === expectedStatus || response.status < 500) return response;
    if (attempt < attempts) {
      await sleepWithAbort(options.previewRetryDelayMs ?? DEFAULT_PREVIEW_RETRY_DELAY_MS, options.signal, options.sleep);
    }
  }
  return lastResponse!;
}

async function verifyOne(
  check: AcceptanceCheck,
  index: number,
  options: VerifyAcceptanceChecksOptions
): Promise<AcceptanceCheckResult> {
  const id = checkId(index);
  const label = labelFor(check, index);
  const fail = (message: string, actual?: unknown, expected?: unknown): AcceptanceCheckResult => ({
    id,
    type: check.type,
    label,
    status: 'failed',
    expected,
    actual,
    message,
  });
  const block = (message: string): AcceptanceCheckResult => ({
    id,
    type: check.type,
    label,
    status: 'blocked',
    message,
  });
  const pass = (message: string, actual?: unknown, expected?: unknown): AcceptanceCheckResult => ({
    id,
    type: check.type,
    label,
    status: 'passed',
    expected,
    actual,
    message,
  });

  try {
    const timeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    return await withCheckTimeout((async () => {
      if (check.type === 'http_status') {
        const fetcher = options.fetchImpl || fetch;
        if (!fetcher) return block('HTTP checks require fetch support.');
        const url = resolveUrl(check, options.previewUrl);
        if (!url) return block('This check requires a preview URL or an explicit check URL.');
        const expected = check.expectStatus ?? 200;
        const response = await fetchWithPreviewRetry(url, check.method || 'GET', expected, options);
        return response.status === expected
          ? pass(`HTTP ${response.status} matched expected status.`, response.status, expected)
          : fail(`HTTP ${response.status} did not match expected ${expected}.`, response.status, expected);
      }

      const url = resolveUrl(check, options.previewUrl);
      if (!url) return block('This check requires a preview URL or an explicit check URL.');
      if (!options.executeMcpTool) return block('Browser checks require Playwright tool access.');

      if (check.type === 'text_present' || check.type === 'dom_text') {
        const actual = await runTextPresentCheck(options.executeMcpTool, url, check.selector, check.text);
        return actual === true
          ? pass(`Found expected text "${check.text}".`, actual, true)
          : fail(`Did not find expected text "${check.text}".`, actual, true);
      }

      if (check.type === 'selector_exists') {
        const actual = await runSelectorExistsCheck(options.executeMcpTool, url, check.selector);
        return actual === true
          ? pass(`Found selector "${check.selector}".`, actual, true)
          : fail(`Did not find selector "${check.selector}".`, actual, true);
      }

      if (check.type === 'no_console_errors' || check.type === 'console_errors') {
        const errors = await runConsoleErrorsCheck(options.executeMcpTool, url, check.allowPatterns);
        return Array.isArray(errors) && errors.length === 0
          ? pass('No disallowed console errors found.', errors, [])
          : fail('Disallowed console errors were found.', errors, []);
      }

      if (check.type === 'no_external_hosts') {
        const hosts = await runNoExternalHostsCheck(options.executeMcpTool, url, check.allowHosts, check.denyPatterns);
        return hosts.length === 0
          ? pass('No disallowed external hosts found.', hosts, [])
          : fail('Disallowed external hosts were found.', hosts, []);
      }

      if (check.type === 'browser_eval') {
        const actual = await runBrowserEval(options.executeMcpTool, url, check.script);
        const expected = 'expect' in check ? check.expect : true;
        return valuesEqual(actual, expected)
          ? pass('Browser assertion passed.', actual, expected)
          : fail('Browser assertion failed.', actual, expected);
      }

      return block(`Unsupported acceptance check type: ${(check as any).type}`);
    })(), timeoutMs, options.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel|abort|timed out|timeout|Playwright|MCP|tool/i.test(message)) {
      return block(message);
    }
    return fail(message);
  }
}

export async function verifyAcceptanceChecks(
  options: VerifyAcceptanceChecksOptions
): Promise<AcceptanceVerificationResult> {
  const checks = (options.checks || []).filter(Boolean).slice(0, 10);
  if (checks.length === 0) {
    return { status: 'not_run', checks: [], summary: 'No acceptance checks were provided.' };
  }

  const results: AcceptanceCheckResult[] = [];
  for (let i = 0; i < checks.length; i++) {
    if (options.signal?.aborted) {
      results.push({
        id: checkId(i),
        type: checks[i].type,
        label: labelFor(checks[i], i),
        status: 'blocked',
        message: 'Acceptance verification was cancelled.',
      });
      continue;
    }
    results.push(await verifyOne(checks[i], i, options));
  }

  const failed = results.filter((r) => r.status === 'failed').length;
  const blocked = results.filter((r) => r.status === 'blocked').length;
  const passed = results.filter((r) => r.status === 'passed').length;
  const status: AcceptanceStatus = failed > 0 ? 'failed' : blocked > 0 ? 'blocked' : 'passed';
  const summary = status === 'passed'
    ? `Acceptance passed (${passed}/${results.length} checks).`
    : status === 'blocked'
      ? `Acceptance blocked (${blocked}/${results.length} checks could not run).`
      : `Acceptance failed (${failed}/${results.length} checks failed).`;

  return { status, checks: results, summary };
}
