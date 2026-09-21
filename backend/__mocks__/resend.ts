// Jest manual mock for 'resend', wired via moduleNameMapper in jest.config.js.
//
// ENG-1112. `services/resendService.ts` is the only importer of the real SDK, and the
// SDK sends over the *global* `fetch` to https://api.resend.com. Nothing about the test
// harness stopped that request from leaving the box: `initializeResend()` pulls the key
// from Secrets Manager, and on any host where that secret resolves — a developer laptop,
// the swarm box, CI with AWS credentials — `new Resend(key)` is live. The suite looked
// green only because the key we happened to resolve was rejected by Resend, i.e. a
// configuration accident, not a control. With a valid RESEND_API_KEY in scope the same
// code path would have sent real mail to whatever address the fixture named.
//
// The two suites that genuinely exercise the SDK boundary
// (resendService.queue.test.ts, resendService.errorPropagation.test.ts) register their
// own jest.mock('resend', factory), which always takes precedence over this file. This
// mock is the floor for everyone else: any un-mocked send now fails loudly, at the SDK
// boundary, with a named error instead of quietly reaching a third-party API.
//
// Same shape and rationale as __mocks__/twitter-api-v2.ts.
class RealResendSdkReachedError extends Error {
  constructor(operation: string) {
    super(
      `resend's real SDK was reached via ${operation} during a test run. ` +
        `Tests must never issue a request to api.resend.com — real mail can leave the box. ` +
        `Mock '../services/resendService' (or '../services/emailService') in the calling ` +
        `test file instead of relying on the provider to reject the request.`
    );
    this.name = 'RealResendSdkReachedError';
  }
}

function throwingNamespace(namespace: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return (..._args: unknown[]) => {
          throw new RealResendSdkReachedError(`Resend.${namespace}.${String(prop)}()`);
        };
      },
    }
  );
}

export class Resend {
  emails = throwingNamespace('emails');
  batch = throwingNamespace('batch');
  domains = throwingNamespace('domains');
  contacts = throwingNamespace('contacts');
  audiences = throwingNamespace('audiences');
  apiKeys = throwingNamespace('apiKeys');

  constructor(..._args: unknown[]) {}
}

export { RealResendSdkReachedError };
