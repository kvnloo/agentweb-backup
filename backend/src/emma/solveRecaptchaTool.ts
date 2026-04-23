import { emmaToolRegistry } from './registry';
import { get2CaptchaApiKey } from '../utils/secretsManager';

function findPlaywrightTool(service: any, suffix: string): string | null {
  const allTools = service.toolRegistry?.getAllTools?.() || [];
  for (const tool of allTools) {
    if (tool.name === suffix || tool.name.endsWith(`_${suffix}`)) {
      return tool.name;
    }
  }
  return null;
}

function extractMcpText(result: any): string {
  if (typeof result === 'string') return result;
  if (result?.raw?.content) {
    const arr = Array.isArray(result.raw.content) ? result.raw.content : [];
    const text = arr.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    const m = text.match(/^###\s+Result\s*\n([\s\S]*?)(?:\n###\s|$)/i);
    const raw = m ? m[1].trim() : text;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try { return JSON.parse(raw); } catch { /* use as-is */ }
    }
    return raw;
  }
  if (result?.content) return String(result.content);
  return String(result);
}

/** Submit a task to 2captcha and poll until solved. Returns the solution token. */
async function submit2CaptchaTask(
  apiKey: string,
  params: Record<string, string>,
  initialWaitMs: number
): Promise<string> {
  const submitUrl = new URL('https://2captcha.com/in.php');
  submitUrl.searchParams.set('key', apiKey);
  submitUrl.searchParams.set('json', '1');
  for (const [k, v] of Object.entries(params)) {
    submitUrl.searchParams.set(k, v);
  }

  const submitRes = await fetch(submitUrl.toString(), { method: 'POST' });
  const submitJson = await submitRes.json() as { status: number; request: string };
  if (submitJson.status !== 1) {
    throw new Error(`2captcha submit failed: ${submitJson.request}`);
  }
  const taskId = submitJson.request;
  console.log(`[solveCaptcha] Task submitted id=${taskId}`);

  await new Promise(r => setTimeout(r, initialWaitMs));

  const resultUrl = new URL('https://2captcha.com/res.php');
  resultUrl.searchParams.set('key', apiKey);
  resultUrl.searchParams.set('action', 'get');
  resultUrl.searchParams.set('id', taskId);
  resultUrl.searchParams.set('json', '1');

  const deadline = Date.now() + 165000;
  while (Date.now() < deadline) {
    const pollRes = await fetch(resultUrl.toString());
    const pollJson = await pollRes.json() as { status: number; request: string };
    if (pollJson.status === 1) return pollJson.request;
    if (pollJson.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha error: ${pollJson.request}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('2captcha timed out — CAPTCHA not solved within 3 minutes');
}

/** Inject a token into the page for a given CAPTCHA type and fire any registered callbacks. */
function buildInjectCode(captchaType: string, token: string): string {
  const t = JSON.stringify(token);

  if (captchaType === 'recaptcha_v2') {
    return `async (page) => {
  const t = ${t};
  await page.evaluate((tok) => {
    const ta = document.getElementById('g-recaptcha-response');
    if (ta) { ta.style.display = ''; ta.value = tok; }
    document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(el => { el.value = tok; });
    try {
      const widgetId = Object.keys(window.___grecaptcha_cfg?.clients || {})[0];
      if (widgetId !== undefined) {
        const client = window.___grecaptcha_cfg.clients[widgetId];
        const cbKey = Object.keys(client).find(k => typeof client[k]?.callback === 'function');
        if (cbKey) client[cbKey].callback(tok);
      }
    } catch(e) {}
  }, t);
  return 'injected';
}`;
  }

  if (captchaType === 'hcaptcha') {
    return `async (page) => {
  const t = ${t};
  await page.evaluate((tok) => {
    document.querySelectorAll('[name="h-captcha-response"], textarea[id*="hcaptcha"]').forEach(el => { el.value = tok; });
    // Fire hCaptcha callback if available
    try {
      const frames = document.querySelectorAll('iframe[src*="hcaptcha"]');
      if (window.hcaptcha) {
        const widgetId = Object.keys(window.hcaptcha.widgets || {})[0];
        if (widgetId) window.hcaptcha.execute(widgetId);
      }
      // Try form callback
      const form = document.querySelector('form');
      if (form) {
        const cbAttr = form.getAttribute('data-callback') || form.getAttribute('data-hcaptcha-callback');
        if (cbAttr && typeof window[cbAttr] === 'function') window[cbAttr](tok);
      }
    } catch(e) {}
  }, t);
  return 'injected';
}`;
  }

  if (captchaType === 'turnstile') {
    return `async (page) => {
  const t = ${t};
  await page.evaluate((tok) => {
    document.querySelectorAll('[name="cf-turnstile-response"]').forEach(el => { el.value = tok; });
    // Fire Turnstile callback if registered
    try {
      const widget = document.querySelector('[data-callback]');
      const cbName = widget?.getAttribute('data-callback');
      if (cbName && typeof window[cbName] === 'function') window[cbName](tok);
    } catch(e) {}
  }, t);
  return 'injected';
}`;
  }

  return `async (page) => { return 'no-inject-needed'; }`;
}

// ---------------------------------------------------------------------------
// solve_captcha — unified tool for all token-based CAPTCHAs
// ---------------------------------------------------------------------------
emmaToolRegistry.register({
  name: 'solve_captcha',
  definition: {
    name: 'solve_captcha',
    description:
      'Automatically solve a CAPTCHA challenge using the 2captcha service. ' +
      'IMPORTANT: Before calling this tool, you MUST first extract the site_key and captcha_type from the page using browser_evaluate. ' +
      'Use this JS to find them: document.querySelector(\'[data-sitekey]\')?.getAttribute(\'data-sitekey\') — the site_key is the data-sitekey attribute value. ' +
      'Determine captcha_type by checking: .g-recaptcha or #recaptcha-anchor → "recaptcha_v2"; .h-captcha → "hcaptcha"; .cf-turnstile → "turnstile". ' +
      'Note: reCAPTCHA widgets often render inside an iframe — look for the data-sitekey on the outer div in the main document, not inside the iframe. ' +
      'Use this for token-based CAPTCHAs: reCAPTCHA v2 (checkbox or invisible), reCAPTCHA v3 (score-based), hCaptcha, Cloudflare Turnstile. ' +
      'For reCAPTCHA v2 / hCaptcha / Turnstile: the token is automatically injected — just submit the form after. ' +
      'For reCAPTCHA v3: the token is returned and you must inject it manually. ' +
      'Takes ~15–60 seconds. ' +
      'NOTE: For simple image/text CAPTCHAs (distorted letters, math puzzles, custom image grids without a standard library), ' +
      'use request_user_captcha_solution instead.',
    inputSchema: {
      type: 'object',
      properties: {
        captcha_type: {
          type: 'string',
          enum: ['recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile'],
          description:
            'Type of CAPTCHA: "recaptcha_v2" = checkbox/invisible reCAPTCHA, ' +
            '"recaptcha_v3" = score-based invisible reCAPTCHA, ' +
            '"hcaptcha" = hCaptcha (look for data-sitekey on div.h-captcha or iframe src containing hcaptcha.com), ' +
            '"turnstile" = Cloudflare Turnstile (look for div.cf-turnstile or iframe src containing challenges.cloudflare.com)'
        },
        site_key: {
          type: 'string',
          description: 'The CAPTCHA site key — value of the data-sitekey attribute on the CAPTCHA widget element'
        },
        page_url: {
          type: 'string',
          description: 'The full URL of the page containing the CAPTCHA'
        },
        invisible: {
          type: 'boolean',
          description: 'reCAPTCHA v2 only: set true if invisible variant (no visible checkbox). Defaults to false.'
        },
        action: {
          type: 'string',
          description: 'reCAPTCHA v3 only: the action name (e.g. "login", "submit"). Defaults to "verify".'
        },
        min_score: {
          type: 'number',
          description: 'reCAPTCHA v3 only: minimum acceptable score (0.1–0.9). Defaults to 0.7.'
        }
      },
      required: ['captcha_type', 'site_key', 'page_url']
    }
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const { captcha_type, site_key, page_url, invisible = false, action = 'verify', min_score = 0.7 } = args ?? {};
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    const missing: string[] = [];
    if (!captcha_type) missing.push('captcha_type');
    if (!site_key) missing.push('site_key');
    if (!page_url) missing.push('page_url');
    if (missing.length > 0) {
      return {
        success: false,
        error: `Missing required parameters: ${missing.join(', ')}. ` +
          `You must extract these from the page BEFORE calling solve_captcha. ` +
          `Use browser_evaluate with this code to find them:\n` +
          `document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') + ' | type: ' + ` +
          `(document.querySelector('.g-recaptcha, [data-sitekey]') ? 'recaptcha_v2' : ` +
          `document.querySelector('.h-captcha') ? 'hcaptcha' : ` +
          `document.querySelector('.cf-turnstile') ? 'turnstile' : 'unknown') + ` +
          `' | url: ' + window.location.href`
      };
    }

    const apiKey = await get2CaptchaApiKey();
    console.log(`[solveCaptcha] Solving ${captcha_type} for ${page_url}`);

    let token: string;

    switch (captcha_type) {
      case 'recaptcha_v2':
        token = await submit2CaptchaTask(apiKey, {
          method: 'userrecaptcha',
          googlekey: site_key,
          pageurl: page_url,
          ...(invisible ? { invisible: '1' } : {})
        }, 15000);
        break;

      case 'recaptcha_v3':
        token = await submit2CaptchaTask(apiKey, {
          method: 'userrecaptcha',
          version: 'v3',
          googlekey: site_key,
          pageurl: page_url,
          action,
          min_score: String(min_score)
        }, 20000);
        // v3: return token for Emma to inject — no standard injection target
        return {
          success: true,
          message: `reCAPTCHA v3 token obtained (action="${action}"). Use browser_evaluate to inject this token where the page expects it (usually a hidden input or via a JS call), then submit the form.`,
          token,
          token_preview: token.substring(0, 20) + '...'
        };

      case 'hcaptcha':
        token = await submit2CaptchaTask(apiKey, {
          method: 'hcaptcha',
          sitekey: site_key,
          pageurl: page_url
        }, 15000);
        break;

      case 'turnstile':
        token = await submit2CaptchaTask(apiKey, {
          method: 'turnstile',
          sitekey: site_key,
          pageurl: page_url
        }, 10000);
        break;

      default:
        throw new Error(`Unknown captcha_type: ${captcha_type}. Supported: recaptcha_v2, recaptcha_v3, hcaptcha, turnstile`);
    }

    // Inject the token into the page
    const runCodeTool = findPlaywrightTool(context.service, 'browser_run_code');
    if (!runCodeTool) {
      throw new Error('Playwright browser tools are not available. Make sure a browser session is active.');
    }

    const injectResult = await context.service.executeTool(
      context.llmModel,
      runCodeTool,
      { code: buildInjectCode(captcha_type, token) },
      userId,
      context.sessionId
    );

    const injectText = extractMcpText(injectResult);
    console.log(`[solveCaptcha] Injection result: ${injectText}`);

    return {
      success: true,
      message: `${captcha_type} solved and token injected into the page. You can now submit the form.`,
      token_preview: token.substring(0, 20) + '...'
    };
  }
});

// ---------------------------------------------------------------------------
// request_user_captcha_solution — for image/text CAPTCHAs needing human eyes
// ---------------------------------------------------------------------------
emmaToolRegistry.register({
  name: 'request_user_captcha_solution',
  definition: {
    name: 'request_user_captcha_solution',
    description:
      'Use this when a page has a simple image or text CAPTCHA that cannot be solved automatically — ' +
      'e.g. distorted letters/numbers in an image, a math question, a custom image grid without a standard CAPTCHA library, ' +
      'or any challenge where there is no data-sitekey attribute. ' +
      'This tool takes a screenshot of the current page so the user can see the CAPTCHA, ' +
      'then pauses and asks the user to provide the solution. ' +
      'After calling this tool, take a screenshot using browser_take_screenshot and include it in your response to the user, ' +
      'then ask them to type the CAPTCHA answer. Once they reply, type their answer into the CAPTCHA field.',
    inputSchema: {
      type: 'object',
      properties: {
        captcha_field_selector: {
          type: 'string',
          description: 'CSS selector of the input field where the CAPTCHA answer should be typed (e.g. "#captcha", "input[name=captcha]"). If unknown, leave blank and identify it from the screenshot.'
        },
        context_description: {
          type: 'string',
          description: 'Brief description of what the CAPTCHA looks like or where it appears on the page, to help the user understand what to solve.'
        }
      },
      required: []
    }
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const { captcha_field_selector, context_description } = args;
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    // Take a screenshot of the current page so Emma can show it to the user
    const screenshotTool = findPlaywrightTool(context.service, 'browser_take_screenshot');
    if (screenshotTool) {
      // Fire the screenshot — the result will appear in Emma's tool context as a vision image
      await context.service.executeTool(
        context.llmModel,
        screenshotTool,
        { type: 'png' },
        userId,
        context.sessionId
      );
    }

    const fieldHint = captcha_field_selector
      ? `The answer should be typed into: \`${captcha_field_selector}\``
      : 'Identify the CAPTCHA input field from the screenshot and type the answer there.';

    const contextHint = context_description
      ? `Context: ${context_description}.`
      : '';

    return {
      action: 'request_user_input',
      message:
        `This page has a simple image/text CAPTCHA that requires human input. ${contextHint} ` +
        `Please include the screenshot you just took in your response to show the user what the CAPTCHA looks like, ` +
        `then ask them to type the solution. ${fieldHint} ` +
        `Once the user replies with the answer, type it into the CAPTCHA field using browser_type and submit the form.`,
      next_step: 'Show the screenshot to the user and ask for their CAPTCHA solution.'
    };
  }
});
