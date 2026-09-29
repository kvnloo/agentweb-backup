import { admitReplyCandidates } from '../experiments/replyCandidateAdmission';

describe('A8 reply candidate admission', () => {
  const good = (id: string) => ({
    id,
    text: 'post ' + id,
    url: 'https://example.com/' + id,
    suggestedReply: 'reply ' + id,
  });

  it('hides incomplete candidates', () => {
    expect(admitReplyCandidates([
      good('a'),
      { id: 'b', text: 'missing link', suggestedReply: 'x' },
      good('c'),
    ], [])).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('filters candidates seen in the previous window', () => {
    expect(admitReplyCandidates([good('old'), good('fresh')], ['old']).map((x) => x.id))
      .toEqual(['fresh']);
  });

  it('caps the opening payload at five complete fresh candidates', () => {
    expect(admitReplyCandidates(Array.from({ length: 9 }, (_, i) => good(String(i))), []))
      .toHaveLength(5);
  });
});
