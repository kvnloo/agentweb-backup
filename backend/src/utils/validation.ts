export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Stricter than validateEmail above: rejects consecutive dots in the local
// part or domain, and requires a real TLD label — the shapes that pass
// validateEmail's loose regex but still get rejected by provider validation
// (e.g. Resend 422s) at send time. See ENG-1194.
const STRICT_EMAIL_SYNTAX_REGEX =
  /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export const isEmailSyntaxValid = (email: string): boolean => {
  return STRICT_EMAIL_SYNTAX_REGEX.test((email || '').trim());
};

// RFC 2606 domains/TLDs reserved for documentation/testing — providers like
// Resend reject sends to these outright. Deliberately does NOT include
// generic-looking domains like "test.com" (a real, registered domain) —
// only the formally reserved set.
const RESERVED_TEST_DOMAINS = new Set(['example.com', 'example.net', 'example.org', 'example.edu']);
const RESERVED_TEST_TLDS = ['.test', '.example', '.invalid', '.localhost'];

export const isReservedTestDomainEmail = (email: string): boolean => {
  const trimmed = (email || '').trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx < 0) return false;
  const domain = trimmed.slice(atIdx + 1);
  if (RESERVED_TEST_DOMAINS.has(domain)) return true;
  return RESERVED_TEST_TLDS.some((tld) => domain.endsWith(tld));
};

/**
 * Single source of truth for group-email eligibility on syntax/test-domain
 * grounds. Shared by both the preview and send endpoints (ENG-1194) so the
 * preview's "eligible" count can't diverge from what the send actually
 * queues to the provider. A missing email is NOT flagged here — that's
 * covered by the separate no-email bucket upstream.
 */
export const isGroupEmailIneligible = (email: string | undefined | null): boolean => {
  if (!email) return false;
  return !isEmailSyntaxValid(email) || isReservedTestDomainEmail(email);
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