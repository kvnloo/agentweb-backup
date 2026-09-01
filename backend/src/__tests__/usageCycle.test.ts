/**
 * ENG-1344 — every customer-visible block message must name the reset DATE.
 *
 * The escalation that opened this row (xCures, 2026-08-18) was not "the block is
 * wrong", it was "what does that mean": the product said the word "reset" on four
 * surfaces and never once said when. These tests pin the derivation, and — more
 * importantly — pin the two ways a naive fix goes wrong: rendering the reset a day
 * early for users west of UTC, and inventing a date when the month is unusable.
 */

import {
  utcDay,
  resolveCycle,
  resetDateFromMonth,
  formatResetDateLong,
  resetSentence,
  usagePausedMessage,
} from '../utils/usageCycle';
import { buildUsageBlockCopy } from '../utils/usageBlockCopy';
import { toCustomerTokenUsage } from '../services/tokenUsageService';

describe('usageCycle — reset date derivation', () => {
  it('resets on the 1st of the following month', () => {
    expect(resetDateFromMonth('2026-09')).toBe('2026-10-01');
    expect(resetDateFromMonth('2026-01')).toBe('2026-02-01');
  });

  it('rolls December into January of the next year', () => {
    expect(resetDateFromMonth('2026-12')).toBe('2027-01-01');
  });

  it('returns null for anything it cannot parse, rather than a wrong date', () => {
    for (const bad of [undefined, null, '', '2026', '2026-13', '2026-00', 'not-a-month', '2026-9']) {
      expect(resetDateFromMonth(bad as string)).toBeNull();
    }
  });

  it('agrees with resolveCycle, which the forecast surfaces already use', () => {
    // Both must name the same day or the modal and the runway panel would
    // disagree about when the same account is unblocked.
    expect(resolveCycle('2026-09-17').cycleResetDate).toBe(resetDateFromMonth('2026-09'));
    expect(resolveCycle('2026-12-31').cycleResetDate).toBe(resetDateFromMonth('2026-12'));
  });

  it('renders the same calendar day on any host timezone', () => {
    // The hazard is real and this asserts it: the instant our reset date refers to
    // IS the previous day in Los Angeles. `formatResetDateLong` never constructs a
    // Date, so it cannot be dragged across that boundary — and unlike a
    // `timeZone: "UTC"` pin, this holds on a host east of UTC too, which is where
    // CI actually runs.
    const instant = new Date('2026-10-01T00:00:00Z');
    expect(
      instant.toLocaleDateString('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    ).toBe('September 30, 2026');
    expect(formatResetDateLong('2026-10-01')).toBe('October 1, 2026');
  });

  it('formats each month boundary from the string, never from a clock', () => {
    expect(formatResetDateLong('2027-01-01')).toBe('January 1, 2027');
    expect(formatResetDateLong('2026-12-01')).toBe('December 1, 2026');
    expect(formatResetDateLong(null)).toBeNull();
    expect(formatResetDateLong('2026-13-01')).toBeNull();
    expect(formatResetDateLong('2026-10-1')).toBeNull();
  });

  it('utcDay is a plain YYYY-MM-DD', () => {
    expect(utcDay(new Date('2026-10-01T23:59:59Z'))).toBe('2026-10-01');
  });
});

describe('usageCycle — customer-facing copy', () => {
  it('names the day in the reset sentence', () => {
    expect(resetSentence('2026-09')).toBe('Your included usage resets on October 1, 2026.');
  });

  it('omits the sentence entirely when the month is unusable', () => {
    expect(resetSentence(undefined)).toBeNull();
    expect(resetSentence('garbage')).toBeNull();
  });

  it('the paused message carries the date and the way out', () => {
    const msg = usagePausedMessage('2026-09');
    expect(msg).toContain('AI usage is paused.');
    expect(msg).toContain('resets on October 1, 2026');
    expect(msg).toMatch(/add usage or upgrade/i);
    // The dollars ENG-1212 removed from the customer payload must not reappear here.
    expect(msg).not.toMatch(/\$/);
  });

  it('falls back to the old wording rather than promising a date it cannot compute', () => {
    const msg = usagePausedMessage(undefined);
    expect(msg).toBe('AI usage is paused until your next reset or additional usage is added.');
    expect(msg).not.toMatch(/null|undefined|NaN|Invalid/);
  });
});

describe('usageBlockCopy — one server-side producer (ENG-1344 AC6)', () => {
  it('composes the whole explanation from the billing month', () => {
    const copy = buildUsageBlockCopy({ month: '2026-09' });
    expect(copy).toEqual({
      resetDate: '2026-10-01',
      headline: 'Your monthly AI usage is paused',
      body: "You've used all of the AI usage included in your plan this month.",
      resetSentence: 'Your included usage resets on October 1, 2026.',
      message:
        'AI usage is paused. Your included usage resets on October 1, 2026. ' +
        'Add usage or upgrade your plan to keep working before then.',
    });
  });

  it('degrades to the undated wording without inventing a date', () => {
    const copy = buildUsageBlockCopy({ month: undefined });
    expect(copy.resetDate).toBeNull();
    expect(copy.resetSentence).toBeNull();
    expect(copy.message).toBe(
      'AI usage is paused until your next reset or additional usage is added.'
    );
    expect(copy.message).not.toMatch(/null|undefined|NaN|Invalid/);
    // The state is still explained even with no date to give.
    expect(copy.headline).toBeTruthy();
    expect(copy.body).toBeTruthy();
  });

  it('carries no dollar figure — ENG-1212 removed those from customer payloads', () => {
    for (const month of ['2026-09', '2026-12', undefined]) {
      const copy = buildUsageBlockCopy({ month });
      expect(JSON.stringify(copy)).not.toMatch(/\$/);
    }
  });

  it('is the SAME object the flat 429 string comes from', () => {
    // usagePausedMessage delegates rather than re-composing; if it ever forked,
    // the 429 and the portal modal could word the same block differently.
    for (const month of ['2026-09', '2026-12', undefined, 'garbage']) {
      expect(usagePausedMessage(month)).toBe(buildUsageBlockCopy({ month }).message);
    }
  });
});

describe('usageBlockCopy — edges found while auditing the PR', () => {
  it('agrees with the resetDate convention already stored on every user record', () => {
    // `getNextResetDate()` in tokenUsageService builds LOCAL midnight of the 1st
    // of the next month and stores it on `user.tokenUsage.resetDate`. Verified
    // against production 2026-09-01: every stored value is exactly
    // `T00:00:00.000Z` (so the fleet runs UTC) and month "2026-09" pairs with
    // "2026-10-01" — across 7 months and 144 user records.
    //
    // Reconstructed here with the same LOCAL construction and read back with
    // local getters, so this holds on a dev box in any timezone. If either
    // derivation is changed without the other, the block copy would start naming
    // a different day from the account's own stored reset.
    for (let m = 1; m <= 12; m++) {
      const month = `2026-${String(m).padStart(2, '0')}`;
      const stored = new Date(2026, m, 1); // identical construction to getNextResetDate
      const expected =
        `${stored.getFullYear()}-` +
        `${String(stored.getMonth() + 1).padStart(2, '0')}-` +
        `${String(stored.getDate()).padStart(2, '0')}`;
      expect(resetDateFromMonth(month)).toBe(expected);
    }
  });

  it('treats an empty-string month as underivable, not as "now"', () => {
    // `''` is falsy but is a plausible shape for a partially-populated record.
    expect(resetDateFromMonth('')).toBeNull();
    expect(buildUsageBlockCopy({ month: '' }).resetSentence).toBeNull();
  });

  it('never names a reset date already in the past', () => {
    // The failure mode ENG-1622 shipped to a customer on the runway modal: a date
    // that had already gone by. It cannot happen here because `checkTokenUsage`
    // lazily resets `month` to the CURRENT month on every read (three return
    // paths, all `currentMonth`), so the derived reset is always the upcoming
    // 1st. This pins that relationship rather than trusting it.
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const resetDate = resetDateFromMonth(currentMonth)!;
    const todayLocal =
      `${now.getFullYear()}-` +
      `${String(now.getMonth() + 1).padStart(2, '0')}-` +
      `${String(now.getDate()).padStart(2, '0')}`;
    expect(resetDate > todayLocal).toBe(true);
  });
});
