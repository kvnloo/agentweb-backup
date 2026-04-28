const STANDARD_FIELDS = ['firstName', 'lastName', 'email', 'company', 'title'] as const;

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
