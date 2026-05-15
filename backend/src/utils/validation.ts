export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.fr', 'yahoo.de', 'yahoo.it', 'yahoo.es',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es',
  'outlook.com', 'outlook.co.uk',
  'live.com', 'live.co.uk', 'live.fr',
  'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'protonmail.com', 'proton.me',
  'zohomail.com',
  'yandex.com', 'yandex.ru',
  'mail.com', 'mail.ru',
  'gmx.com', 'gmx.net', 'gmx.de',
  'inbox.com',
  'fastmail.com', 'fastmail.fm',
  'hey.com',
  'tutanota.com', 'tutamail.com',
]);

/**
 * Returns true if the email appears to be from a company/work domain
 * (i.e. not a well-known personal/free email provider).
 */
export const isCompanyEmail = (email: string): boolean => {
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 0) return false;
  const domain = email.slice(atIdx + 1).toLowerCase();
  return !PERSONAL_EMAIL_DOMAINS.has(domain);
};

/**
 * Normalizes a string-or-array email field to a string[].
 * Handles LLMs that pass a single address as a string instead of an array,
 * and also handles the case where elements are stringified JSON arrays
 * (e.g. ["[\"a@b.com\", \"c@d.com\"]"] → ["a@b.com", "c@d.com"]).
 * Non-string and invalid email elements are filtered out.
 */
export function normalizeEmailList(value: unknown): string[] {
  let items: unknown[];

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    items = [value.trim()];
  } else {
    return [];
  }

  const emails: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Detect stringified JSON arrays like '["a@b.com","c@d.com"]'
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const inner of parsed) {
            if (typeof inner === 'string') {
              const innerTrimmed = inner.trim();
              if (validateEmail(innerTrimmed)) emails.push(innerTrimmed);
            }
          }
          continue;
        }
      } catch {
        // Not valid JSON — fall through to email validation below
      }
    }

    if (validateEmail(trimmed)) emails.push(trimmed);
  }
  return emails;
} 