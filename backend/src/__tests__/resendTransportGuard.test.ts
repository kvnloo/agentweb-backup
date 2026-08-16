/**
 * ENG-1112 — no backend test may issue a request to api.resend.com.
 *
 * The Resend SDK sends over the *global* `fetch`. `resendService.initializeResend()`
 * pulls the API key from Secrets Manager, so on any host where `dev/AgentWeb/Resend`
 * resolves — a developer laptop, the swarm box, CI with AWS credentials — an un-mocked
 * send was a live HTTPS POST to Resend's production API. The suite read green only
 * because the key we happened to resolve was rejected; with a valid key in scope the
 * same code path sends real mail to whatever address a fixture names. That is a
 * configuration accident, not a control.
 *
 * This suite is the control. It deliberately makes the environment as *permissive* as
 * possible — `getSecret` resolves a well-formed key, exactly the condition under which
 * the old code would have sent — and then asserts that the transport still never fires.
 *
 * Deliberately no `jest.mock('../services/resendService')` and no
 * `jest.mock('resend', ...)` here: the point is to exercise the real service against
 * whatever the harness resolves `resend` to. That is `__mocks__/resend.ts` via
 * `moduleNameMapper`, which fails loudly instead of reaching the network.
 */

// `export {}` at the bottom keeps this file a module. Without it TypeScript treats a
// file with no top-level import/export as a script sharing one global scope, and
// `mockGetSecret` collides with the identically-named const in
// resendService.queue.test.ts (TS2451).
const mockGetSecret = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getSecret: (...args: any[]) => mockGetSecret(...args),
}));

/** Every URL the code under test tried to fetch. */
const attemptedFetches: string[] = [];
/** The subset that is this issue's subject: anything aimed at Resend. */
const resendAttempts = () => attemptedFetches.filter((u) => u.includes('api.resend.com'));
const realFetch = global.fetch;

/**
 * Fail-loudly transport guard. Any host at all is unexpected here — this suite must
 * make zero outbound requests — so the guard throws rather than returning a plausible
 * `ok` response, which would let a live-send regression pass quietly.
 */
function installFetchGuard() {
  attemptedFetches.length = 0;
  global.fetch = jest.fn((input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    attemptedFetches.push(String(url));
    throw new Error(
      `resendTransportGuard.test.ts attempted a live network call to ${url}. ` +
        `Backend tests must not reach third-party APIs — least of all api.resend.com, ` +
        `where the request sends real mail.`
    );
  }) as unknown as typeof fetch;
}

describe('ENG-1112: the Resend transport is unreachable from tests', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    installFetchGuard();
    // The permissive case: a well-formed key IS available. This is the environment in
    // which the pre-ENG-1112 code sent for real.
    mockGetSecret.mockResolvedValue('re_a_valid_looking_key_0123456789');
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('rejects a send with a named error instead of POSTing to api.resend.com', async () => {
    const { resendService } = await import('../services/resendService');

    await expect(
      resendService.sendEmail({
        from: 'AgentWeb <no-reply@agentweb.pro>',
        to: 'nobody@example.com',
        subject: 'ENG-1112 guard',
        html: '<p>should never leave the box</p>',
      })
    ).rejects.toThrow(/real SDK was reached/i);

    expect(attemptedFetches).toEqual([]);
  });

  it('names the offending operation so the failure is diagnosable', async () => {
    const { resendService } = await import('../services/resendService');

    await expect(
      resendService.sendSystemEmail({
        to: 'nobody@example.com',
        subject: 'ENG-1112 guard — system email',
        text: 'should never leave the box',
      })
    ).rejects.toThrow(/Resend\.emails\.send\(\)/);

    expect(attemptedFetches).toEqual([]);
  });

  it('blocks the domain-management calls too, not just sends', async () => {
    const { resendService } = await import('../services/resendService');

    // These helpers swallow to null/[] by design (legacy contract), so assert on the
    // absence of traffic rather than on a thrown error.
    await expect(resendService.createDomain('example.com')).resolves.toBeNull();
    await expect(resendService.listDomains()).resolves.toEqual([]);

    expect(attemptedFetches).toEqual([]);
  });

  it('keeps emailService.sendEmail best-effort — swallowed, but still no Resend traffic', async () => {
    // `emailService.sendEmail` deliberately swallows send failures (ENG-164), which is
    // exactly why a live-send regression here is invisible from the caller's side. The
    // guarantee that matters is therefore about the wire, not the return value.
    const { emailService } = await import('../services/emailService');

    await expect(
      emailService.sendEmail(
        'nobody@example.com',
        'ENG-1112 guard — best effort',
        'should never leave the box',
        '<p>should never leave the box</p>'
      )
    ).resolves.toBeUndefined();

    // Scoped to Resend on purpose. Importing emailService transitively loads
    // `services/docsKnowledgeSource.ts`, which prefetches
    // https://docs.agentweb.pro/llms-full.txt at module-load time — a separate live-fetch
    // leak of the same class, out of ENG-1112's scope. The guard above still blocks it,
    // so nothing leaves the box either way; asserting on it here would tie this control
    // to an unrelated defect.
    expect(resendAttempts()).toEqual([]);
  });
});

export {};
