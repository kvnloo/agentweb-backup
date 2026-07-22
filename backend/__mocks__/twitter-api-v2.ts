// Jest manual mock for 'twitter-api-v2', wired via moduleNameMapper in jest.config.js.
//
// Each twitter test file already provides its own detailed jest.mock('twitter-api-v2', factory)
// with per-test control over responses — that factory always takes precedence over this file
// when it registers successfully, so this mock has no effect on normal test runs.
//
// This exists purely as a safety net: if a test's own mock factory ever fails to register for a
// given run (e.g. a Jest module-resolution/worker-recycling edge case), module resolution falls
// back to whatever moduleNameMapper points 'twitter-api-v2' at — this file — instead of the real
// package. Without it, that fallback would be the actual SDK, which can reach X's live API and
// silently return production error responses instead of a clear test failure.
class RealTwitterSdkReachedError extends Error {
  constructor(method: string) {
    super(
      `twitter-api-v2's real SDK was reached via TwitterApi.${method}() during a test run. ` +
        `The calling test file is missing (or failed to register) its own ` +
        `jest.mock('twitter-api-v2', ...) — fix that instead of relying on this fallback mock.`
    );
    this.name = 'RealTwitterSdkReachedError';
  }
}

const throwingHandler: ProxyHandler<object> = {
  get(_target, prop) {
    return (..._args: unknown[]) => {
      throw new RealTwitterSdkReachedError(String(prop));
    };
  },
};

export class TwitterApi {
  v1 = new Proxy({}, throwingHandler);
  v2 = new Proxy({}, throwingHandler);

  constructor(..._args: unknown[]) {}

  generateOAuth2AuthLink(..._args: unknown[]): never {
    throw new RealTwitterSdkReachedError('generateOAuth2AuthLink');
  }

  loginWithOAuth2(..._args: unknown[]): never {
    throw new RealTwitterSdkReachedError('loginWithOAuth2');
  }

  refreshOAuth2Token(..._args: unknown[]): never {
    throw new RealTwitterSdkReachedError('refreshOAuth2Token');
  }
}
