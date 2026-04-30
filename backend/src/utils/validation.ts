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
 * Handles LLMs that pass a single address as a string instead of an array.
 */
export function normalizeEmailList(value: unknown): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return [];
} 