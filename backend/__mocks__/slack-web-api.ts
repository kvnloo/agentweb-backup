// Jest manual mock for '@slack/web-api', wired via moduleNameMapper in jest.config.js.
//
// Root cause this exists for: @slack/web-api's compiled WebClient.js constructs a real
// axios client at `new WebClient(...)` time. Under this project's specific
// jest/ts-jest/dependency combination, that construction throws
// ("Cannot read properties of undefined (reading 'defaults')") purely as a test-harness
// artifact — confirmed NOT a real incompatibility: the same compiled code loads and runs
// fine outside Jest (`node -e "require('./dist/services/slackService.js')"`), and the
// actual server has always started fine. Every file that transitively imports
// slackService.ts (most of them via agentModeService.ts, which is imported very widely)
// was hitting this at module-load time, well before any test in the file even ran,
// regardless of whether that file exercises Slack behavior at all.
//
// Tests that actually exercise Slack behavior already provide their own
// jest.mock('@slack/web-api', factory) with per-test control over responses — that
// factory always takes precedence over this file when it registers successfully, so this
// mock has no effect on those. This exists purely so slackService.ts's module-level
// `new WebClient(...)` never touches the real package for every OTHER test file.
//
// Matches the same "throw loudly if actually reached" shape as __mocks__/twitter-api-v2.ts
// (RealTwitterSdkReachedError) — a test that genuinely calls a Slack method without its
// own mock should get a clear failure, not silently succeed against a fake response.
class RealSlackSdkReachedError extends Error {
  constructor(path: string) {
    super(
      `@slack/web-api's real WebClient was reached via ${path}() during a test run. ` +
        `The calling test file is missing (or failed to register) its own ` +
        `jest.mock('@slack/web-api', ...) — fix that instead of relying on this fallback mock.`
    );
    this.name = 'RealSlackSdkReachedError';
  }
}

function throwingNamespace(namespace: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, method) {
        return (..._args: unknown[]) => {
          throw new RealSlackSdkReachedError(`${namespace}.${String(method)}`);
        };
      },
    },
  );
}

export class WebClient {
  conversations = throwingNamespace('conversations');
  chat = throwingNamespace('chat');
  views = throwingNamespace('views');
  users = throwingNamespace('users');

  constructor(..._args: unknown[]) {}
}
