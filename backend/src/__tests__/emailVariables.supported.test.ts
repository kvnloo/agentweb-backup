import { isSupportedVariable } from '../utils/emailVariables';

describe('isSupportedVariable', () => {
  it('treats standard lead fields as supported', () => {
    expect(isSupportedVariable('firstName')).toBe(true);
    expect(isSupportedVariable('title')).toBe(true);
    expect(isSupportedVariable('company')).toBe(true);
  });
  it('treats customFields.* as supported', () => {
    expect(isSupportedVariable('customFields.region')).toBe(true);
  });
  it('treats arbitrary non-standard fields as unsupported', () => {
    expect(isSupportedVariable('phone')).toBe(false);
    expect(isSupportedVariable('linkedinHeadline')).toBe(false);
  });
  it('treats sender-sourced vars as unsupported (handled separately, never lead-checked)', () => {
    expect(isSupportedVariable('senderName')).toBe(false);
    expect(isSupportedVariable('senderEmail')).toBe(false);
  });
});
