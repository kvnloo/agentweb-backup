import {
  REPLY_GUY_CANDIDATE_COUNT,
  CONTAINER_FETCH_FAILED_MESSAGE,
  selectReplyCandidates,
  renderReplyGuyOpening,
  isPostShapedDraft,
  renderPostIdeasOpening,
} from '../utils/containerPayload';

const cand = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  postText: `Post body ${id} about attribution windows`,
  url: `https://x.com/someone/status/${id}`,
  suggestedReply: `Good point on ${id}; we saw the same with 3-day windows.`,
  ...over,
});

describe('reply-guy container payload (ENG-715 AC1/AC2/AC4)', () => {
  it('keeps exactly 5 complete candidates', () => {
    const raw = Array.from({ length: 8 }, (_, i) => cand(String(i)));
    const out = selectReplyCandidates(raw);
    expect(out).toHaveLength(REPLY_GUY_CANDIDATE_COUNT);
    expect(out.map(c => c.id)).toEqual(['0', '1', '2', '3', '4']);
  });

  it.each([
    ['post text', { postText: '  ' }],
    ['link', { url: undefined }],
    ['non-http link', { url: 'javascript:alert(1)' }],
    ['suggested reply', { suggestedReply: '' }],
  ])('drops a candidate missing %s', (_label, over) => {
    const out = selectReplyCandidates([cand('bad', over), cand('ok')]);
    expect(out.map(c => c.id)).toEqual(['ok']);
  });

  it('does not repeat candidates from the previous run and dedupes within a run', () => {
    const out = selectReplyCandidates([cand('a'), cand('b'), cand('b'), cand('c')], { previousIds: ['a'] });
    expect(out.map(c => c.id)).toEqual(['b', 'c']);
  });

  it('treats the same URL under a different ID as the same post', () => {
    const sameUrl = { url: 'https://x.com/someone/status/z' };
    const out = selectReplyCandidates([cand('p', sameUrl), cand('q', sameUrl), cand('r')]);
    expect(out.map(c => c.id)).toEqual(['p', 'r']);
    const prev = selectReplyCandidates([cand('n', sameUrl), cand('m')], { previousIds: [sameUrl.url] });
    expect(prev.map(c => c.id)).toEqual(['m']);
  });

  it('renders every shown candidate with text, link and reply', () => {
    const text = renderReplyGuyOpening({ ok: true, candidates: [cand('1'), cand('2', { url: '' })] });
    expect(text).toContain('Post body 1');
    expect(text).toContain('https://x.com/someone/status/1');
    expect(text).toContain('Suggested reply: Good point on 1');
    expect(text).not.toContain('Post body 2');
  });

  it('degrades loudly on fetch failure and when nothing usable remains', () => {
    expect(renderReplyGuyOpening({ ok: false })).toBe(CONTAINER_FETCH_FAILED_MESSAGE);
    expect(renderReplyGuyOpening({ ok: true, candidates: [cand('x', { postText: '' })] }))
      .toBe(CONTAINER_FETCH_FAILED_MESSAGE);
    expect(CONTAINER_FETCH_FAILED_MESSAGE.trim().length).toBeGreaterThan(0);
  });
});

describe('post-ideas container payload (ENG-715 AC3/AC4)', () => {
  const news = [
    { title: 'Meta shortens default attribution window', url: 'https://news.example/meta-attr', summary: 'Default moves from 7 to 1 day click.' },
    { title: 'Google Ads adds PMax channel reporting', url: 'https://news.example/pmax' },
  ];

  it('opens with news items usable as angles and no drafted post copy', () => {
    const text = renderPostIdeasOpening({ ok: true, items: news });
    expect(text).toContain('Meta shortens default attribution window');
    expect(text).toContain('https://news.example/pmax');
    expect(isPostShapedDraft(text)).toBe(false);
  });

  it('drops any item that carries a post-shaped draft', () => {
    const drafted = { title: 'Big news', url: 'https://news.example/x', summary: "🚀 Here's my take: attribution is dead. Thoughts? #marketing #ads" };
    const text = renderPostIdeasOpening({ ok: true, items: [drafted, news[1]] });
    expect(text).not.toContain('Big news');
    expect(isPostShapedDraft(text)).toBe(false);
  });

  it.each([
    "Draft post: Attribution windows just changed. Here's why it matters 👇",
    'Hot take: PMax is finally transparent. What do you think? #ppc',
    'Tweet: Meta just cut attribution to 1 day.\n\n1/ Here is what that means',
  ])('flags post-shaped drafts: %s', s => {
    expect(isPostShapedDraft(s)).toBe(true);
  });

  it('does not flag plain news summaries', () => {
    expect(isPostShapedDraft('Default moves from 7 to 1 day click for new campaigns.')).toBe(false);
  });

  it('degrades loudly on fetch failure or empty news', () => {
    expect(renderPostIdeasOpening({ ok: false })).toBe(CONTAINER_FETCH_FAILED_MESSAGE);
    expect(renderPostIdeasOpening({ ok: true, items: [] })).toBe(CONTAINER_FETCH_FAILED_MESSAGE);
  });
});
