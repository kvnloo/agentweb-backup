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
  ])('redacts a %s number', (_label, num) => {
    expect(redactPhones(`dial ${num} now`)).toBe('dial [redacted] now');
  });

  it('redacts a number with a plus even when it is glued to a word', () => {
    expect(redactPhones('number+15555550100')).toBe('number[redacted]');
  });

  it('redacts a digit run glued on the right', () => {
    expect(redactPhones('ext 4155550100x')).toBe('ext [redacted]x');
  });

  it('keeps Twilio SIDs, ISO dates and ids glued on the left', () => {
    const text = `${CALL_SID} ${NUMBER_SID} 2026-10-19 2026-10-19T10:00:00.000Z job_1234567 job-1234567`;
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
