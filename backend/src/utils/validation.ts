export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
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