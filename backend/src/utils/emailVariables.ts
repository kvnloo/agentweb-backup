import { LLMService } from './llmService';

const STANDARD_FIELDS = ['firstName', 'lastName', 'email', 'company', 'title'] as const;

/**
 * Returns true if the HTML contains a <style> block with class-based CSS rules that
 * are likely to be stripped by email clients (Gmail, Outlook, etc.).
 */
export function hasUnsafeEmailStyles(html: string): boolean {
  if (!html) return false;
  const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (!styleBlocks) return false;
  return styleBlocks.some(block => {
    // Strip the opening/closing <style> tags to get just the CSS
    const css = block.replace(/<style[^>]*>/i, '').replace(/<\/style>/i, '');
    // Remove all @media blocks — class rules inside @media are acceptable
    // (they handle responsive layout and dark mode; Gmail ignores them gracefully)
    const outsideMedia = css.replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '');
    return /\.[a-zA-Z][\w-]*\s*\{/.test(outsideMedia);
  });
}

/**
 * Uses Claude Sonnet 4.6 to convert a class-based CSS email template to a fully
 * inline-styled version that renders correctly in all email clients.
 *
 * Returns the inlined HTML, or the original HTML if the LLM call fails.
 */
export async function inlineEmailStyles(html: string): Promise<{ html: string; wasFixed: boolean }> {
  if (!hasUnsafeEmailStyles(html)) {
    return { html, wasFixed: false };
  }

  try {
    const llm = new LLMService('anthropic.claude-sonnet-4-6', 0, 16000);
    const systemPrompt = `You are an expert HTML email developer. Your job is to convert HTML emails that use <style> blocks and CSS classes into email-client-compatible HTML that works in Gmail, Outlook, and Apple Mail.

Rules:
1. Move ALL CSS from <style> blocks into inline style="" attributes on every element that uses those classes
2. Do NOT change any colors, fonts, sizes, spacing, layout, or visual design — preserve them exactly
3. Remove the <style> blocks from <head> after inlining (they are no longer needed)
4. Keep @media queries in a single <style> block if present (they cannot be inlined)
5. Keep any Google Fonts <link> tags
6. Do NOT change any text content, links, images, or HTML structure
7. Preserve all existing inline style="" attributes — merge class styles into them
8. CRITICAL for buttons and CTAs: Gmail strips CSS gradients. For any element that has background: linear-gradient(...), you MUST also add a solid background-color fallback using the darkest color in the gradient (e.g., if the gradient uses #8B5CF6 and #7c3aed, add background-color: #7c3aed). Place background-color BEFORE the background: gradient in the style attribute so it acts as the fallback.
9. CRITICAL for button text: Always ensure button/CTA text color has high contrast against the background. If the background is dark (e.g., purple, dark blue, dark green), the text color must be #ffffff or a very light color. If the background is light, the text color must be dark.
10. CRITICAL for any fixed-size element that uses flexbox to center its content: Gmail strips flexbox entirely. For ANY element that has a fixed height AND uses display:flex + align-items:center or justify-content:center to center its content, replace those flex properties with display:block + text-align:center + line-height set to the same value as the element's height (e.g. if height:38px then line-height:38px; if height:48px then line-height:48px). This applies to circular badges, icon circles, numbered steps, avatar circles, or any other fixed-height container. Always derive the line-height from the actual height value in that element's styles.

Return ONLY the complete fixed HTML wrapped in <actual_html_content>...</actual_html_content> tags. No explanation.`;

    const userPrompt = `Convert this email HTML to use inline styles instead of CSS classes:\n\n${html}`;

    const inlined = await llm.generateHTML(systemPrompt, userPrompt);
    if (inlined && inlined.length > html.length * 0.5) {
      return { html: inlined, wasFixed: true };
    }
    return { html, wasFixed: false };
  } catch (err) {
    console.error('[inlineEmailStyles] LLM call failed, using original HTML:', err);
    return { html, wasFixed: false };
  }
}

/**
 * Extract all variable names used in a template string.
 * Returns standard fields like "firstName" and custom fields like "customFields.region".
 */
export function extractVariables(template: string): string[] {
  if (!template) return [];
  const vars = new Set<string>();
  const regex = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    const varName = match[1].trim();
    // Skip special non-lead variables
    if (varName === 'unsubscribeUrl') continue;
    vars.add(varName);
  }
  return Array.from(vars);
}

/**
 * Check whether a lead has a non-empty value for a given variable name.
 */
export function leadHasVariable(lead: Record<string, any>, varName: string): boolean {
  if (varName.startsWith('customFields.')) {
    const fieldName = varName.slice('customFields.'.length);
    const customFields = lead.customFields;
    if (customFields && typeof customFields === 'object' && fieldName in customFields) {
      const val = customFields[fieldName];
      return val != null && val !== '';
    }
    return false;
  }
  const val = lead[varName];
  return val != null && val !== '';
}

/**
 * Inject an unsubscribe URL into HTML email content using a three-step strategy:
 * 1. Replace {{unsubscribeUrl}} template variable if present anywhere in the HTML
 * 2. If the HTML already has an unsubscribe anchor (href="#" near "Unsubscribe" text),
 *    update that href to the real URL
 * 3. If neither exists, append a plain footer before </body> (or at the end)
 */
export function injectUnsubscribeUrl(html: string, unsubscribeUrl: string, fallbackFooterHtml?: string): string {
  if (!html) return html;

  // Step 1: replace {{unsubscribeUrl}} variable
  if (/\{\{unsubscribeUrl\}\}/i.test(html)) {
    return html.replace(/\{\{unsubscribeUrl\}\}/gi, unsubscribeUrl);
  }

  // Step 2: update existing unsubscribe anchor href
  // Match a single <a>...</a> whose inner text contains "unsubscribe".
  // The middle group excludes </a> to prevent crossing tag boundaries.
  const updatedHtml = html.replace(
    /(<a\b[^>]*>)((?:(?!<\/a>)[\s\S])*?unsubscribe(?:(?!<\/a>)[\s\S])*?)(<\/a>)/gi,
    (_match, openTag, text, closeTag) => {
      const newOpenTag = openTag.replace(/href="[^"]*"/i, `href="${unsubscribeUrl}"`);
      const finalOpenTag = /href=/i.test(openTag)
        ? newOpenTag
        : openTag.replace(/<a\b/i, `<a href="${unsubscribeUrl}"`);
      return `${finalOpenTag}${text}${closeTag}`;
    }
  );

  if (updatedHtml !== html) {
    return updatedHtml;
  }

  // Step 3: no unsubscribe link found — append a footer
  const footer = fallbackFooterHtml
    ? fallbackFooterHtml.replace(/\{\{unsubscribeUrl\}\}/gi, unsubscribeUrl)
    : `<div style="text-align:center;margin-top:40px;padding-top:20px;border-top:1px solid #eee;font-size:12px;color:#999;"><a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a> from future emails</div>`;

  return html.replace(/<\/body>/i, `${footer}</body>`) + (/<\/body>/i.test(html) ? '' : footer);
}

/**
 * Converts youtu.be short URLs to full youtube.com/watch?v=... URLs.
 * Gmail's spam filters flag youtu.be links as potential phishing attempts.
 */
export function normalizeYoutubeUrls(html: string): string {
  if (!html) return html;
  return html.replace(
    /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)(\?[^\s"'<>]*)?/g,
    (_match, videoId, query) => {
      const base = `https://www.youtube.com/watch?v=${videoId}`;
      if (!query) return base;
      // Append existing query params (e.g. si=...) after v=
      const extraParams = query.slice(1); // strip leading '?'
      return `${base}&${extraParams}`;
    },
  );
}

const S3_BUCKET_HOST = 'agentweb-user-files.s3.us-west-2.amazonaws.com';

/**
 * Rewrite S3 image src URLs in email HTML to go through the /asset/ proxy on the
 * backend (e.g. https://api.agentweb.pro/asset/<base64url>). This makes image
 * hostnames match the sending domain, satisfying Resend/Gmail deliverability checks.
 *
 * Only rewrites src attributes pointing to the agentweb-user-files S3 bucket.
 * baseUrl should be the backend URL, e.g. process.env.BACKEND_URL or 'https://api.agentweb.pro'.
 */
export function rewriteS3ImageUrls(html: string, baseUrl: string): string {
  if (!html) return html;
  const base = baseUrl.replace(/\/$/, '');
  return html.replace(
    /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (_match, prefix, srcUrl, suffix) => {
      if (!srcUrl.includes(S3_BUCKET_HOST)) return _match;
      const hash = Buffer.from(srcUrl).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      return `${prefix}${base}/asset/${hash}${suffix}`;
    },
  );
}

export interface EmailFormatWarning {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Check an HTML email for common format issues that cause rendering problems.
 * Returns a list of warnings to surface to the user before sending.
 */
export function checkEmailFormat(html: string): EmailFormatWarning[] {
  if (!html) return [];
  const warnings: EmailFormatWarning[] = [];

  // Check for class-based CSS (stripped by Gmail)
  if (hasUnsafeEmailStyles(html)) {
    warnings.push({
      code: 'class-based-css',
      message: 'Email contains <style> blocks with CSS classes. Gmail strips these — use inline styles instead.',
      severity: 'error',
    });
  }

  // Check for dark mode handling. Two valid approaches:
  // 1. Opt-out: <meta name="color-scheme" content="light"> tells Apple Mail / iOS Mail
  //    to never invert the email — simplest and most reliable fix.
  // 2. Opt-in: @media (prefers-color-scheme: dark) with explicit overrides for every
  //    dark text color and light background.
  const hasColorSchemeOptOut = /color-scheme[^"]*"[^"]*light/i.test(html) ||
    /<meta[^>]*name=["']color-scheme["'][^>]*content=["'][^"']*light[^"']*["']/i.test(html) ||
    /<meta[^>]*content=["'][^"']*light[^"']*["'][^>]*name=["']color-scheme["']/i.test(html);
  const hasDarkModeQuery = /@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(html);
  const darkModeHandled = hasColorSchemeOptOut || hasDarkModeQuery;

  if (!darkModeHandled) {
    warnings.push({
      code: 'no-dark-mode',
      message: 'No dark mode handling detected. In Apple Mail and iOS dark mode, light backgrounds may invert making dark text unreadable. Fix: add <meta name="color-scheme" content="light"> in the <head> to opt out of dark mode inversion.',
      severity: 'warning',
    });
  }

  // Check for hardcoded light text colors on potentially dark-mode-inverted backgrounds
  // Detect dark hex/named text colors inline (e.g. color:#111, color:#333, color:black)
  // without a nearby dark-mode override — a common source of "black text on dark bg" bugs
  const hasDarkTextColors = /color\s*:\s*(#[0-7][0-9a-fA-F]{5}|#[0-7][0-9a-fA-F]{2}|black|#000)/i.test(html);
  const hasLightBgColors = /background(-color)?\s*:\s*(#[ef][0-9a-fA-F]{5}|#[ef][0-9a-fA-F]{2}|white|#fff\b)/i.test(html);
  if (hasDarkTextColors && hasLightBgColors && !darkModeHandled) {
    warnings.push({
      code: 'dark-mode-contrast',
      message: 'Email uses dark text on a light background without dark mode handling. In dark mode (e.g. iOS Mail), the background may invert while text stays dark, making it unreadable. Fix: add <meta name="color-scheme" content="light"> in the <head>.',
      severity: 'warning',
    });
  }

  return warnings;
}

/**
 * Injects <meta name="color-scheme" content="light"> into the <head> if not already present.
 * Opts the email out of dark-mode inversion in Apple Mail / iOS Mail.
 * No-op when the tag already exists or there is no <head>.
 */
export function injectColorSchemeMeta(html: string): string {
  if (!html) return html;
  // Already opted out — nothing to do.
  const alreadyPresent =
    /<meta[^>]*name=["']color-scheme["'][^>]*>/i.test(html) ||
    /<meta[^>]*content=["'][^"']*light[^"']*["'][^>]*name=["']color-scheme["'][^>]*>/i.test(html);
  if (alreadyPresent) return html;
  const meta = '<meta name="color-scheme" content="light">';
  // Inject right after <head> if present, otherwise before the first <meta> or <body>.
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  }
  return html;
}

export function substituteVariables(template: string, lead: Record<string, any>): string {
  if (!template) return template;

  let result = template;

  // Replace standard fields: {{firstName}}, {{lastName}}, etc.
  for (const field of STANDARD_FIELDS) {
    const regex = new RegExp(`\\{\\{${field}\\}\\}`, 'g');
    result = result.replace(regex, lead[field] != null ? String(lead[field]) : '');
  }

  // Replace custom fields: {{customFields.xxx}}
  result = result.replace(/\{\{customFields\.([^}]+)\}\}/g, (_match, fieldName) => {
    const customFields = lead.customFields;
    if (customFields && typeof customFields === 'object' && fieldName in customFields) {
      return String(customFields[fieldName]);
    }
    return '';
  });

  return result;
}
