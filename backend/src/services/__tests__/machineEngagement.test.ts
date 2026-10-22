import { isSuspectedMachineEngagement, parseResendTimestamp, SUSPECTED_MACHINE_GAP_MS } from '../machineEngagement';

describe('isSuspectedMachineEngagement (ENG-2524/ENG-2565)', () => {
  it('uses a 5s threshold', () => {
    expect(SUSPECTED_MACHINE_GAP_MS).toBe(5_000);
  });

  it('flags a sub-5s click', () => {
    expect(isSuspectedMachineEngagement('email.clicked', 4_200)).toBe(true);
  });

  it('flags a sub-5s open', () => {
    expect(isSuspectedMachineEngagement('email.opened', 1_500)).toBe(true);
  });

  it('does not flag an 18.7s click', () => {
    expect(isSuspectedMachineEngagement('email.clicked', 18_700)).toBe(false);
  });

  it('does not flag a human-paced GoogleImageProxy open (UA is not an input)', () => {
    // GoogleImageProxy opens are real human opens; only the gap matters.
    expect(isSuspectedMachineEngagement('email.opened', 42_000)).toBe(false);
  });

  it('never flags a reply exit, however fast', () => {
    expect(isSuspectedMachineEngagement('email.received', 100)).toBe(false);
  });

  it('does not flag when the gap is unknown or negative', () => {
    expect(isSuspectedMachineEngagement('email.clicked', null)).toBe(false);
    expect(isSuspectedMachineEngagement('email.clicked', -500)).toBe(false);
  });
});

describe('parseResendTimestamp (ENG-2565)', () => {
  it('parses the Resend YYYY-MM-DD HH:MM:SS.ffffff+00 format', () => {
    expect(parseResendTimestamp('2026-10-19 16:00:00.123456+00')).toBe(Date.parse('2026-10-19T16:00:00.123Z'));
  });

  it('parses ISO strings', () => {
    expect(parseResendTimestamp('2026-10-19T16:00:05.000Z')).toBe(Date.parse('2026-10-19T16:00:05.000Z'));
  });

  it('returns null for missing or garbage values without throwing', () => {
    expect(parseResendTimestamp(undefined)).toBeNull();
    expect(parseResendTimestamp(null)).toBeNull();
    expect(parseResendTimestamp('')).toBeNull();
    expect(parseResendTimestamp('not a date')).toBeNull();
  });

  it('yields a gap that flags a 3s scanner click', () => {
    const sent = parseResendTimestamp('2026-10-19 16:00:00.000000+00')!;
    const clicked = Date.parse('2026-10-19T16:00:03.000Z');
    expect(isSuspectedMachineEngagement('email.clicked', clicked - sent)).toBe(true);
  });
});
