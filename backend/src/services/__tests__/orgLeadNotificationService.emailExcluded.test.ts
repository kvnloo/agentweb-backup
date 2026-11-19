import { emailExcluded } from '../orgLeadNotificationService';

describe('emailExcluded', () => {
  const patterns = ['@nuerraa.com', '@agentweb.pro', 'yugo-test'];
  it('matches exact and sub domains case-insensitively', () => {
    expect(emailExcluded('Sondra@NuErraa.com', patterns)).toBe(true);
    expect(emailExcluded('a@mail.agentweb.pro', patterns)).toBe(true);
  });
  it('does not match lookalike domains', () => {
    expect(emailExcluded('a@notnuerraa.com', patterns)).toBe(false);
    expect(emailExcluded('a@nuerraa.com.evil.io', patterns)).toBe(false);
  });
  it('substring patterns', () => {
    expect(emailExcluded('yugo-test+x@gmail.com', patterns)).toBe(true);
    expect(emailExcluded('lead@gmail.com', patterns)).toBe(false);
  });
  it('no patterns or no email never excludes', () => {
    expect(emailExcluded('a@nuerraa.com', undefined)).toBe(false);
    expect(emailExcluded('', patterns)).toBe(false);
  });
});
