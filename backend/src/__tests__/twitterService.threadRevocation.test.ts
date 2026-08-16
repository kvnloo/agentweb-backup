import { twitterService } from '../services/twitterService';

/**
 * ENG-827 (Greptile, security) — a thread is N public writes, not one.
 *
 * The dispatcher's consent check covers the call, and the manage-post check covers the
 * first tweet. Neither covers tweets 2..N: a ten-tweet thread is ten separate posts
 * spread over as long as the API takes, and an owner who revokes after the first one
 * had the remaining nine go out under a decision they had already withdrawn.
 *
 * Already-posted tweets cannot be un-posted, so the contract under revocation is
 * "stop, and report what actually went out" — never "claim the thread".
 */

describe('postThread stops when consent is withdrawn mid-thread (ENG-827)', () => {
  let postTweetSpy: jest.SpyInstance;

  beforeEach(() => {
    let n = 0;
    postTweetSpy = jest
      .spyOn(twitterService, 'postTweet')
      .mockImplementation(async () => ({ id: `t${++n}`, text: `tweet ${n}` }) as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('posts every tweet while consent stands', async () => {
    const result = await twitterService.postThread('owner', 'acct', ['a', 'b', 'c'], async () => null);
    expect(postTweetSpy).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(3);
  });

  it('STOPS after the tweet that was already public when consent is withdrawn', async () => {
    const withdrawn = { success: false as const, error: 'consent withdrawn' };
    // Authorized for the first gap, withdrawn from then on.
    let checks = 0;
    const result = await twitterService.postThread('owner', 'acct', ['a', 'b', 'c', 'd'], async () =>
      ++checks === 1 ? null : withdrawn
    );

    // Tweet 1 posted before any re-check; tweet 2 after the passing check; then stop.
    expect(postTweetSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('stops before the SECOND tweet when consent is already withdrawn', async () => {
    const result = await twitterService.postThread('owner', 'acct', ['a', 'b', 'c'], async () => ({
      success: false as const,
      error: 'consent withdrawn',
    }));

    // The first tweet is unavoidable — the caller checked immediately before it.
    expect(postTweetSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it('never re-checks before the FIRST tweet — the caller just did', async () => {
    const check = jest.fn(async () => null);
    await twitterService.postThread('owner', 'acct', ['a'], check);
    expect(check).not.toHaveBeenCalled();
    expect(postTweetSpy).toHaveBeenCalledTimes(1);
  });

  it('posts the whole thread when no hook is supplied (interactive path unchanged)', async () => {
    const result = await twitterService.postThread('owner', 'acct', ['a', 'b']);
    expect(postTweetSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });
});
