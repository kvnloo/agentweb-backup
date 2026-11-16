import { parseWithImagesQuery, applyWithImagesQuery, WITH_IMAGES_MAX_LIMIT } from '../withImagesQuery';

const file = (url: string, fav = false) => ({ url, filename: url.split('/').pop(), is_favorited: fav });
const task = (id: string, t: string, files: any[]) => ({ taskId: id, taskName: id, latestExecutionTime: t, executions: [{ executionId: `e-${id}`, result_files: files }] });

const result = {
  a: task('a', '2024-01-01', [file('u/a1.png', true), file('u/a2.png')]),
  b: task('b', '2024-01-03', [file('u/b1.png')]),
  c: task('c', '2024-01-02', [file('u/c1.png', true)]),
};

describe('parseWithImagesQuery (ENG-2386)', () => {
  it('returns null when no params (backward compatible)', () => {
    expect(parseWithImagesQuery({})).toBeNull();
  });
  it('parses flags, limit and cursor; clamps limit', () => {
    expect(parseWithImagesQuery({ favorites: 'true', limit: '9999', cursor: '2' }))
      .toEqual({ favorites: true, approved: false, limit: WITH_IMAGES_MAX_LIMIT, cursor: 2 });
  });
  it('rejects invalid limit/cursor', () => {
    expect(parseWithImagesQuery({ limit: '0' })).toEqual({ error: expect.any(String) });
    expect(parseWithImagesQuery({ limit: 'x' })).toEqual({ error: expect.any(String) });
    expect(parseWithImagesQuery({ cursor: '-1' })).toEqual({ error: expect.any(String) });
  });
});

describe('applyWithImagesQuery (ENG-2386)', () => {
  it('rejects empty, whitespace-only, or repeated limit/cursor', () => {
    for (const q of [{ limit: '' }, { limit: '  ' }, { cursor: '' }, { cursor: ' ' }, { limit: ['1', '2'] }]) {
      expect(parseWithImagesQuery(q)).toHaveProperty('error');
    }
  });
  it('favorites keeps only favorited files and drops empty tasks', () => {
    const r = applyWithImagesQuery(result, { favorites: true, approved: false, cursor: 0 });
    expect(Object.keys(r.tasks)).toEqual(['c', 'a']);
    expect(r.tasks.a.executions?.[0].result_files?.map((f) => f.url)).toEqual(['u/a1.png']);
    expect(r.nextCursor).toBeNull();
  });
  it('approved uses approval status map', () => {
    const r = applyWithImagesQuery(result, { favorites: false, approved: true, cursor: 0 }, { 'u/b1.png': 'approved', 'u/a2.png': 'pending' });
    expect(Object.keys(r.tasks)).toEqual(['b']);
  });
  it('limit + cursor round-trip covers every task exactly once, newest first', () => {
    const seen: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const r = applyWithImagesQuery(result, { favorites: false, approved: false, limit: 2, cursor });
      seen.push(...Object.keys(r.tasks));
      expect(r.total).toBe(3);
      cursor = r.nextCursor;
    }
    expect(seen).toEqual(['b', 'c', 'a']);
  });
  it('does not mutate the input', () => {
    const before = JSON.stringify(result);
    applyWithImagesQuery(result, { favorites: true, approved: true, limit: 1, cursor: 0 }, {});
    expect(JSON.stringify(result)).toBe(before);
  });
});
