import { mergeFounders } from '../brandMarketStrategy';

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
