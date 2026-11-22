/**
 * ENG-2123: identity rules for phone-only capture dedupe, and the rollout-mode setting.
 */
import { phoneDedupeKey, phoneNamesConflict, PHONE_FANOUT_CAP } from '../utils/phoneLeadDedupe';

describe('phoneDedupeKey', () => {
  it.each([
    ['+1 (212) 456-7890', '2124567890'],
    ['212-456-7890', '2124567890'],
    ['2124567890', '2124567890'],
    ['(212) 456 7890', '2124567890'],
    ['12124567890', '2124567890'],            // leading NANP country code stripped by phoneDigits
    ['+44 20 7946 0958', '442079460958'],     // non-NANP, 12 digits: kept whole
    ['+61 2 9374 4000', '61293744000'],       // 11 digits not starting with 1: kept whole
  ])('%s -> %s', (input, key) => expect(phoneDedupeKey(input)).toBe(key));

  it.each([
    ['empty', ''],
    ['undefined', undefined],
    ['9 digits', '212456789'],
    ['seven-digit local number (the shared 7-digit floor is NOT enough to merge on)', '456-7890'],
    ['only a country code', '+1'],
    ['one repeated digit', '555-555-5555'],
    ['all zeros', '0000000000'],
    ['ascending run', '1234567890'],
    ['ascending run from 0', '0123456789'],
    ['descending run', '9876543210'],
    ['NANP area code starting with 1', '112 456 7890'],
    ['NANP area code starting with 0', '012 456 7890'],
    ['NANP exchange starting with 1', '212 156 7890'],
    ['NANP exchange starting with 0', '212 056 7890'],
    ['more than 15 digits', '+1234567890123456'],
    ['letters only', 'call me'],
  ])('rejects %s', (_n, input) => expect(phoneDedupeKey(input as any)).toBe(''));

  it('never returns a key for a number the shared 7-digit helper would have merged on', () => {
    expect(phoneDedupeKey('555-0142')).toBe('');
  });
});

describe('phoneNamesConflict', () => {
  it.each([
    [{ firstName: 'Ana' }, { firstName: 'Bob' }, true],
    [{ firstName: 'Ana' }, { firstName: 'ana' }, false],              // case-insensitive
    [{ firstName: ' Ana  Maria ' }, { firstName: 'ana maria' }, false], // whitespace-insensitive
    [{ firstName: 'Ana', lastName: 'Lee' }, { firstName: 'Ana', lastName: 'Kim' }, true],
    [{ firstName: 'Ana' }, { firstName: '' }, false],                 // blank on one side is no conflict
    [{ firstName: '' }, { firstName: 'Ana' }, false],
    [{}, {}, false],
    [{ firstName: 'Ana', lastName: '' }, { firstName: 'Ana', lastName: 'Lee' }, false],
    [null, { firstName: 'Ana' }, false],
  ])('%j vs %j -> %s', (a, b, expected) => expect(phoneNamesConflict(a, b)).toBe(expected));

  it('a company or notes difference alone is not a conflict', () => {
    expect(phoneNamesConflict({ firstName: 'Ana', company: 'A' }, { firstName: 'Ana', company: 'B' })).toBe(false);
  });
});

it('the fan-out cap is 5', () => expect(PHONE_FANOUT_CAP).toBe(5));
