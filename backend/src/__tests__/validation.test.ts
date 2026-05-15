/**
 * Tests for validation utilities, focusing on email normalization.
 */

import { normalizeEmailList, validateEmail } from '../utils/validation';

describe('normalizeEmailList', () => {
  // ─── FAIL tests: invalid/edge inputs ─────────────────────────────────────

  it('should return empty array for null', () => {
    expect(normalizeEmailList(null)).toEqual([]);
  });

  it('should return empty array for undefined', () => {
    expect(normalizeEmailList(undefined)).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    expect(normalizeEmailList('')).toEqual([]);
  });

  it('should return empty array for empty array', () => {
    expect(normalizeEmailList([])).toEqual([]);
  });

  it('should reject invalid email strings when passed as array elements', () => {
    // Non-email strings should be filtered out
    expect(normalizeEmailList(['not-an-email', 'also-bad'])).toEqual([]);
  });

  it('should parse and flatten a stringified JSON array (the reported bug)', () => {
    // This is the exact bug: LLM passes `["[\"will@provenlabs.ai\", \"founders@agentweb.pro\"]"]`
    // i.e. an array with one element that is itself a stringified JSON array
    const input = ['["will@provenlabs.ai", "founders@agentweb.pro"]'];
    expect(normalizeEmailList(input)).toEqual(['will@provenlabs.ai', 'founders@agentweb.pro']);
  });

  it('should parse a single stringified array element mixed with valid emails', () => {
    const input = ['real@example.com', '["extra@example.com", "other@example.com"]'];
    expect(normalizeEmailList(input)).toEqual(['real@example.com', 'extra@example.com', 'other@example.com']);
  });

  it('should handle a stringified array passed as a plain string', () => {
    // e.g. value = '["a@b.com","c@d.com"]'
    const input = '["a@b.com","c@d.com"]';
    expect(normalizeEmailList(input)).toEqual(['a@b.com', 'c@d.com']);
  });

  it('should filter out non-string elements within an array', () => {
    expect(normalizeEmailList([42, null, 'valid@example.com', {}, true])).toEqual(['valid@example.com']);
  });

  // ─── SUCCESS tests ─────────────────────────────────────────────────────────

  it('should return valid emails unchanged', () => {
    expect(normalizeEmailList(['will@provenlabs.ai', 'founders@agentweb.pro'])).toEqual([
      'will@provenlabs.ai',
      'founders@agentweb.pro',
    ]);
  });

  it('should wrap a single valid email string in an array', () => {
    expect(normalizeEmailList('user@example.com')).toEqual(['user@example.com']);
  });

  it('should trim whitespace from email strings', () => {
    expect(normalizeEmailList(['  user@example.com  ', ' other@example.com'])).toEqual([
      'user@example.com',
      'other@example.com',
    ]);
  });
});
