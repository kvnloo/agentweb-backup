import { mergeFounders, hasBlankFounderName, isScrapeFounderWrite } from '../brandMarketStrategy';

describe('mergeFounders (ENG-2875)', () => {
  const existing = [
    { name: 'Yuan Li', jobTitle: 'CEO', voiceExamples: 'post A' },
    { name: 'Naveed Ahmed', jobTitle: 'CTO' },
  ];

  it('removes founders omitted from the incoming list', () => {
    expect(mergeFounders(existing, [{ name: 'Yuan Li' }])).toEqual([
      { name: 'Yuan Li', jobTitle: 'CEO', voiceExamples: 'post A' },
    ]);
  });

  it('preserves untouched fields on a partial-field update (name match is case/space-insensitive)', () => {
    const result = mergeFounders(existing, [
      { name: ' yuan li ', voiceExamples: 'post B' },
      { name: 'Naveed Ahmed' },
    ]);
    expect(result[0]).toEqual({ name: ' yuan li ', jobTitle: 'CEO', voiceExamples: 'post B' });
    expect(result[1]).toEqual({ name: 'Naveed Ahmed', jobTitle: 'CTO' });
  });

  it('rename replaces the old entry with the new one', () => {
    expect(mergeFounders(existing, [{ name: 'Yuan Li' }, { name: 'Sam Ortiz', jobTitle: 'COO' }])).toEqual([
      { name: 'Yuan Li', jobTitle: 'CEO', voiceExamples: 'post A' },
      { name: 'Sam Ortiz', jobTitle: 'COO' },
    ]);
  });

  it('empty incoming list clears founders; nameless/duplicate entries are dropped', () => {
    expect(mergeFounders(existing, [])).toEqual([]);
    expect(mergeFounders(undefined, [{ name: 'A' }, { name: 'a' }, { jobTitle: 'x' }])).toEqual([{ name: 'A' }]);
  });

  it('additive mode (onboarding brand build) never removes stored founders', () => {
    expect(
      mergeFounders(existing, [{ name: 'yuan li', voiceExamples: 'post B' }, { name: 'Sam Ortiz' }], { additive: true }),
    ).toEqual([
      { name: 'yuan li', jobTitle: 'CEO', voiceExamples: 'post B' },
      { name: 'Naveed Ahmed', jobTitle: 'CTO' },
      { name: 'Sam Ortiz' },
    ]);
    expect(mergeFounders(existing, [], { additive: true })).toEqual(existing);
  });
});

describe('ENG-2875 founders write guards', () => {
  it('flags blank/missing founder names but allows an empty list', () => {
    expect(hasBlankFounderName([{ name: '  ' }])).toBe(true);
    expect(hasBlankFounderName([{ name: 'A' }, {}])).toBe(true);
    expect(hasBlankFounderName([])).toBe(false);
    expect(hasBlankFounderName([{ name: 'A' }])).toBe(false);
  });
  it('is additive for the claimed session during the automated turn only', () => {
    const claim = '2026-11-09T00:00:00Z';
    expect(isScrapeFounderWrite(claim, 'building')).toBe(true);
    // a later automated call in the same turn, after status flipped to ready
    expect(isScrapeFounderWrite(claim, 'ready', 0)).toBe(true);
    // a human has written in the session: ordinary edit, may remove founders
    expect(isScrapeFounderWrite(claim, 'ready', 1)).toBe(false);
    expect(isScrapeFounderWrite(claim, 'ready')).toBe(false);
    expect(isScrapeFounderWrite(undefined, 'building')).toBe(false);
  });
});
