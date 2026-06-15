import { nameTokensMatch } from '../utils/nameMatch';

describe('nameTokensMatch', () => {
  it('matches identical names (case-insensitive)', () => {
    expect(nameTokensMatch('Joe', 'Hio', 'joe', 'HIO')).toBe(true);
  });

  it('rejects when both tokens differ', () => {
    expect(nameTokensMatch('Awais', 'Haider', 'Joe', 'Hio')).toBe(false);
  });

  it('rejects when only the first name differs', () => {
    expect(nameTokensMatch('Bob', 'Hio', 'Joe', 'Hio')).toBe(false);
  });

  it('rejects when only the last name differs', () => {
    expect(nameTokensMatch('Joe', 'Smith', 'Joe', 'Hio')).toBe(false);
  });

  it('allows nickname / prefix matches in both directions', () => {
    expect(nameTokensMatch('Robert', 'Hio', 'Rob', 'Hio')).toBe(true);
    expect(nameTokensMatch('Rob', 'Hio', 'Robert', 'Hio')).toBe(true);
  });

  it('treats an empty token as "no constraint"', () => {
    expect(nameTokensMatch('Joe', '', 'Joe', 'Hio')).toBe(true);
    expect(nameTokensMatch('', '', 'Joe', 'Hio')).toBe(true);
    expect(nameTokensMatch(undefined, null, 'Joe', 'Hio')).toBe(true);
  });

  it('still rejects on a populated contradicting token even when the other side is empty', () => {
    expect(nameTokensMatch('Awais', '', 'Joe', 'Hio')).toBe(false);
  });
});
