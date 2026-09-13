import { metaService } from '../services/metaService';
import { installMetaSandboxInterceptor, uninstallMetaSandboxInterceptor, getInterceptorAudit, resetInterceptorAuditForTests } from '../services/sandbox/metaInterceptor';
import { mintSandboxToken } from '../services/sandbox/sentinel';

/**
 * ENG-1909 finding: `sendCapiLeadEvent` (metaService.ts, the sole CAPI send function every
 * caller — webhooks.ts's lead forward, calendlyWebhook.ts, metaConversionRelay.ts,
 * auth.ts's signup — shares) posts to `https://graph.facebook.com/<v>/<pixelId>/events` via
 * the global `fetch`, with `access_token` in the JSON body. None of those four callers' route
 * or tool paths are denylisted for a sandbox account (`isSandboxDeniedRoute` does not cover
 * public webhooks, and no `SANDBOX_TOOL_CLASSES` entry covers CRM/lead-list management), and
 * `getMetaAccountCredentials` resolves the OWNING account's own connected Meta credential —
 * so for a sandbox-owned lead list, `accessToken` here genuinely is that account's own
 * sentinel token (`sbx.<userId>.<hex>`), not a fixed system-level app token. This is
 * therefore a REACHABLE path for a sandbox account, and it must never let that sentinel
 * reach the real network. It already doesn't: the fetch is `graph.facebook.com` with the
 * sentinel in the JSON body, which the process-level interceptor's fetch wrapper already
 * classifies and simulates — proven here directly, end to end, against the real
 * `sendCapiLeadEvent`, rather than left as a code-reading inference.
 */
const USER = 'eval_9c8b7a65-1111-4222-8333-444455556666';
const SBX = mintSandboxToken(USER);
const REAL = 'EAABsbCS1iHgBAO7ZCZCrealtoken';

const seen: any[] = [];
const handle = jest.fn(async (req: any) => {
  seen.push(req);
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events_received: 1, fbtrace_id: 'sandbox' }) };
});

afterAll(async () => { uninstallMetaSandboxInterceptor(); });
beforeEach(() => { uninstallMetaSandboxInterceptor(); resetInterceptorAuditForTests(); seen.length = 0; handle.mockClear(); installMetaSandboxInterceptor({ handle }); });

describe('CAPI send never reaches the real network for a sandbox principal', () => {
  it('a sandbox sentinel token is caught and simulated, not sent to graph.facebook.com', async () => {
    const result = await metaService.sendCapiLeadEvent('120210000000000001', SBX, {
      eventId: 'evt-1', email: 'candidate@example.invalid', eventTimeSeconds: Math.floor(Date.now() / 1000),
    });
    expect(handle).toHaveBeenCalledTimes(1);
    const req = seen[0];
    expect(req.userId).toBe(USER);
    expect(req.path).toBe('120210000000000001/events');
    // `SimRequest.token` legitimately carries the sentinel (that's how the simulator would
    // resolve which account's dataset to answer from) — what must be scrubbed is the wire
    // payload, exactly like every other simulated write: the JSON body access_token is gone.
    expect(req.json?.access_token).toBeUndefined();
    expect(JSON.stringify(req.json)).not.toContain(SBX);
    expect(getInterceptorAudit().simulated).toBe(1);
    expect(result.success).toBe(true);
  });

  it('a real account token is completely unaffected — reaches the real client (passthrough), interceptor never invoked', async () => {
    // Never make a real call to graph.facebook.com from a test. Substitute the underlying
    // fetch BEFORE installing the interceptor, so `state.originalFetch` captures this stub —
    // proving passthrough means proving the WRAPPED fetch still calls through to it,
    // classification never routes the request to `handle`, with no real network egress.
    // uninstall FIRST — it unconditionally restores `globalThis.fetch` to whatever it
    // captured as "original" at the last install, which would otherwise wipe out a stub
    // assigned before it. Only after that restore is `globalThis.fetch` safe to override.
    uninstallMetaSandboxInterceptor();
    const originalFetch = globalThis.fetch;
    const stub = jest.fn(async (_url?: unknown, _init?: unknown) => new Response(JSON.stringify({ events_received: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = stub as unknown as typeof fetch;
    installMetaSandboxInterceptor({ handle });
    try {
      const result = await metaService.sendCapiLeadEvent('120210000000000001', REAL, {
        eventId: 'evt-2', email: 'customer@example.com', eventTimeSeconds: Math.floor(Date.now() / 1000),
      });
      expect(stub).toHaveBeenCalledTimes(1);
      expect(String(stub.mock.calls[0][0])).toContain('graph.facebook.com');
      expect(handle).not.toHaveBeenCalled();
      const audit = getInterceptorAudit();
      expect(audit.simulated).toBe(0);
      expect(audit.backstopHits).toBe(0);
      expect(result.success).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
