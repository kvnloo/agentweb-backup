import { redactPhones } from '../redactText';

const CALL_SID = 'CA00000000000000000000000000000001';
const NUMBER_SID = 'PN00000000000000000000000000000001';

describe('redactPhones', () => {
  it.each([
    ['E.164', '+15555550100'],
    ['formatted', '+1 (555) 555-0100'],
    ['dotted', '555.555.0100'],
    ['bare', '5555550100'],
    ['slashes', '555/555/0100'],
    ['Arabic-Indic digits', '٥٥٥٥٥٥٥١٠٠'],
    ['fullwidth digits', '５５５５５５５１００'],
    ['fullwidth plus', '＋1 415 555 0100'],
    ['non-breaking hyphen and space', '555‑555 0100'],
    ['minus sign', '555−555−0100'],
    ['comma-grouped', '1,415,555,0100'],
    ['asterisk-separated', '415*555*0100'],
    ['underscore-separated', '415_555_0100'],
    ['zero-width space', '415\u200B555\u200B0100'],
    ['zero-width joiner', '415\u200D555\u200D0100'],
    ['word joiner', '415\u2060555\u20600100'],
    ['byte-order mark', '415\uFEFF555\uFEFF0100'],
    ['soft hyphen', '415\u00AD555\u00AD0100'],
    ['left-to-right mark', '415\u200E555\u200E0100'],
    ['right-to-left mark', '415\u200F555\u200F0100'],
    ['Arabic letter mark', '415\u061C555\u061C0100'],
    ['semicolon-separated', '415;555;0100'],
    ['pipe-separated', '415|555|0100'],
    ['hash-separated', '415#555#0100'],
    ['tilde-separated', '415~555~0100'],
    ['equals-separated', '415=555=0100'],
    ['URL-encoded space', '415%20555%200100'],
    ['URL-encoded space after a plus', '%2B1%20415%20555%200100'],
    ['comma-grouped with a four-digit last group', '1,415,555,0100'],
    ['URL-encoded plus', '%2B14155550100'],
    ['lowercase URL-encoded plus', '%2b14155550100'],
  ])('redacts a %s number', (_label, num) => {
    expect(redactPhones(`dial ${num} now`)).toBe('dial [redacted] now');
  });

  it.each([
    ['a UUID', 'req 550e8400-e29b-41d4-a716-446655440000 done'],
    ['a UUID whose first block is all digits', 'id 12345678-1234-4abc-8def-123456789012'],
    ['a UUID with a letter before a digit run', 'id f1234567-0000-4000-8000-000000000000'],
    ['a number with thousands separators', 'sent 1,234,567 emails'],
    ['a larger number with thousands separators', 'total 12,345,678,901'],
    ['a list of small numbers', 'pages 1, 2, 3, 4, 5, 6, 7 and 10, 20, 30, 40'],
  ])('keeps %s', (_label, text) => {
    expect(redactPhones(text)).toBe(text);
  });

  it('still redacts a phone that sits next to a kept number or UUID', () => {
    expect(redactPhones('1,234,567 and +15555550100')).toBe('1,234,567 and [redacted]');
    expect(redactPhones('550e8400-e29b-41d4-a716-446655440000 +15555550100')).toBe('550e8400-e29b-41d4-a716-446655440000 [redacted]');
  });

  it('does not keep the front of a longer comma-grouped phone', () => {
    expect(redactPhones('call 1,415,555,0100 now')).toBe('call [redacted] now');
    expect(redactPhones('call 415,555,0100 now')).toBe('call [redacted] now');
  });

  it('redacts a number with a plus even when it is glued to a word', () => {
    expect(redactPhones('number+15555550100')).toBe('number[redacted]');
  });

  it('redacts a number glued to a word prefix', () => {
    expect(redactPhones('to4155550100')).toBe('to[redacted]');
    expect(redactPhones('tel:4155550100')).toBe('tel:[redacted]');
    expect(redactPhones('callto%2B14155550100')).toBe('callto[redacted]');
  });

  it('redacts a number inside a URL query', () => {
    expect(redactPhones('/owner?to=%2B14155550100&x=1')).toBe('/owner?to=[redacted]&x=1');
  });

  it('redacts a digit run glued on the right', () => {
    expect(redactPhones('ext 4155550100x')).toBe('ext [redacted]x');
  });

  it('keeps Twilio SIDs, ISO dates and ids glued on the left', () => {
    const text = `${CALL_SID} ${NUMBER_SID} 2026-10-19 2026-10-19T10:00:00.000Z job_1234567 job-1234567 job_1234567_89 ${CALL_SID}_1234567`;
    expect(redactPhones(text)).toBe(text);
  });

  it('redacts a number sitting next to a SID', () => {
    expect(redactPhones(`${NUMBER_SID} / +15555550100`)).toBe(`${NUMBER_SID} / [redacted]`);
  });

  it('keeps runs shorter than 7 digits and does not treat padding as digits', () => {
    expect(redactPhones('code 21211 and 123456')).toBe('code 21211 and 123456');
    expect(redactPhones('1       2')).toBe('1       2');
  });
});
