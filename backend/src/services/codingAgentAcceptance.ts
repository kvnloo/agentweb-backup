export type AcceptanceStatus = 'not_run' | 'passed' | 'failed' | 'blocked';

export type AcceptanceCheck =
  | {
      type: 'http_status';
      label?: string;
      url: string;
      method?: 'GET' | 'HEAD';
      expectStatus?: number;
    }
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
}

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

function unwrapToolValue(result: any): unknown {
  if (result == null) return result;
  if (typeof result !== 'object') return result;
  if ('result' in result) return result.result;
  if ('value' in result) return result.value;
  if (typeof result.content === 'string') {
    return parseTextValue(result.content);
  }
  const textBlock = Array.isArray(result.raw?.content)
    ? result.raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string')
    : undefined;
  if (textBlock) {
    return parseTextValue(textBlock.text);
  }
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
  return unwrapToolValue(result);
}

async function runDomTextCheck(
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

async function runConsoleErrorsCheck(
  executeMcpTool: ExecuteMcpTool,
  url: string,
  allowPatterns: string[] | undefined
): Promise<unknown> {
  await executeMcpTool('playwright_browser_navigate', { url });
  const result = await executeMcpTool('playwright_browser_console_messages', { level: 'error' });
  const value = unwrapToolValue(result);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const allow = (allowPatterns || []).map((p) => new RegExp(p, 'i'));
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\b(error|failed|uncaught|exception)\b/i.test(line))
    .filter((line) => !allow.some((pattern) => pattern.test(line)));
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
    if (check.type === 'http_status') {
      const fetcher = options.fetchImpl || fetch;
      if (!fetcher) return block('HTTP checks require fetch support.');
      const url = resolveUrl(check, options.previewUrl);
      if (!url) return block('This check requires a preview URL or an explicit check URL.');
      const response = await fetcher(url, { method: check.method || 'GET' });
      const expected = check.expectStatus ?? 200;
      return response.status === expected
        ? pass(`HTTP ${response.status} matched expected status.`, response.status, expected)
        : fail(`HTTP ${response.status} did not match expected ${expected}.`, response.status, expected);
    }

    const url = resolveUrl(check, options.previewUrl);
    if (!url) return block('This check requires a preview URL or an explicit check URL.');
    if (!options.executeMcpTool) return block('Browser checks require Playwright tool access.');

    if (check.type === 'browser_eval') {
      const actual = await runBrowserEval(options.executeMcpTool, url, check.script);
      const expected = 'expect' in check ? check.expect : true;
      return valuesEqual(actual, expected)
        ? pass('Browser assertion passed.', actual, expected)
        : fail('Browser assertion failed.', actual, expected);
    }

    if (check.type === 'dom_text') {
      const actual = await runDomTextCheck(options.executeMcpTool, url, check.selector, check.text);
      return actual === true
        ? pass(`Found expected text "${check.text}".`, actual, true)
        : fail(`Did not find expected text "${check.text}".`, actual, true);
    }

    if (check.type === 'console_errors') {
      const errors = await runConsoleErrorsCheck(options.executeMcpTool, url, check.allowPatterns);
      return Array.isArray(errors) && errors.length === 0
        ? pass('No disallowed console errors found.', errors, [])
        : fail('Disallowed console errors were found.', errors, []);
    }

    return block(`Unsupported acceptance check type: ${(check as any).type}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
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
