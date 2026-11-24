/**
 * ENG-2840 (W2-4 follow-up): `send_gtm_status_report` for outside agents. What each call sends to the route the portal uses, what is
 * refused before anything is sent, how the limits are taken and given back, and what the audit line holds. No network: the self-call is a
 * double. The scope gate is proven at the HTTP layer in mcp.gtmEmailScopeGate.test.ts and the plan owner check on the real route in
 * mcp.gtmEmail.twoTenant.test.ts.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { gtmEmailRequest, sendGtmStatusReport } from '../gtmEmailTool';
import { GtmEmailLimiter, GTM_EMAIL_MAX_RECIPIENTS } from '../gtmEmailLimits';

const mockFetch = mcpFetch as jest.Mock;
const context = { userId: 'user-1', sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true };

let info: jest.SpyInstance;
beforeEach(() => {
  mockFetch.mockReset();
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => info.mockRestore());

const auditLines = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"mcp_gtm_email"')).map((l) => JSON.parse(l));
const answer = (sent: number, failed = 0, suppressed = 0) => ({ success: true, message: `The report was sent successfully to ${sent} recipient.`, sent, failed, suppressed });
const args = { plan_id: 'plan-1', phase_id: 'phase-1', notify_phase_poc: true };

describe('gtmEmailRequest: the request a call builds', () => {
  it('a phase report goes to the phase route with only the chosen people, the message, and the cap', () => {
    const r = gtmEmailRequest({ plan_id: 'plan-1', phase_id: 'phase-1', notify_user: true, notify_phase_poc: true, message: '  Weekly update  ' });
    expect(r.kind).toBe('phase');
    expect(r.path).toBe('/api/gtm-plan/plan-1/phases/phase-1/send-status-report');
    expect(r.body).toEqual({ notifications: { notifyUser: true, notifyPhasePoc: true, maxRecipients: 10 }, message: 'Weekly update' });
    expect(r.flags).toEqual({ notify_user: true, notify_phase_poc: true });
  });

  it('a plan report (no phase_id) goes to the plan route', () => {
    const r = gtmEmailRequest({ plan_id: 'plan-1', notify_plan_poc: true, notify_phase_pocs: true });
    expect(r.kind).toBe('plan');
    expect(r.path).toBe('/api/gtm-plan/plan-1/send-status-report');
    expect(r.body).toEqual({ notifications: { notifyPlanPoc: true, notifyPhasePocs: true, maxRecipients: 10 } });
  });

  it('the cap is always sent, and is the cap the limits module names', () => {
    expect(GTM_EMAIL_MAX_RECIPIENTS).toBe(10);
    for (const a of [args, { plan_id: 'p', notify_user: true }]) {
      expect((gtmEmailRequest(a).body as any).notifications.maxRecipients).toBe(GTM_EMAIL_MAX_RECIPIENTS);
    }
  });

  it('a choice that is false, or null, is not sent', () => {
    const r = gtmEmailRequest({ plan_id: 'p', phase_id: 'ph', notify_user: false, notify_plan_poc: null, notify_phase_poc: true });
    expect(r.body).toEqual({ notifications: { notifyPhasePoc: true, maxRecipients: 10 } });
    expect(r.flags).toEqual({ notify_phase_poc: true });
  });

  it('phase_id null means a plan report, the way agents write "none"', () => {
    const r = gtmEmailRequest({ plan_id: 'p', phase_id: null, notify_user: true });
    expect(r.kind).toBe('plan');
    expect(r.path).toBe('/api/gtm-plan/p/send-status-report');
  });

  it('ids are written into the path escaped', () => {
    const r = gtmEmailRequest({ plan_id: 'a/b?c', phase_id: 'x#y', notify_phase_poc: true });
    expect(r.path).toBe('/api/gtm-plan/a%2Fb%3Fc/phases/x%23y/send-status-report');
  });

  it('a message that is only spaces is no message; a message at the limit is kept; one over is refused', () => {
    expect(gtmEmailRequest({ plan_id: 'p', notify_user: true, message: '   \n ' }).body).toEqual({ notifications: { notifyUser: true, maxRecipients: 10 } });
    expect(gtmEmailRequest({ plan_id: 'p', notify_user: true, message: null }).message).toBeUndefined();
    const atLimit = 'x'.repeat(2000);
    expect((gtmEmailRequest({ plan_id: 'p', notify_user: true, message: atLimit }).body as any).message).toBe(atLimit);
    expect(() => gtmEmailRequest({ plan_id: 'p', notify_user: true, message: 'x'.repeat(2001) })).toThrow('message is too long (2001 characters; the most is 2000). Nothing was emailed.');
  });

  describe('what a call may send at most (what it reserves against the hour)', () => {
    it('one email for each person chosen in a phase report, at most 3', () => {
      expect(gtmEmailRequest({ plan_id: 'p', phase_id: 'ph', notify_phase_poc: true }).reserve).toBe(1);
      expect(gtmEmailRequest({ plan_id: 'p', phase_id: 'ph', notify_user: true, notify_plan_poc: true, notify_phase_poc: true }).reserve).toBe(3);
    });
    it('for a plan report: one each for the owner and the plan contact, and the whole cap for "every phase contact"', () => {
      expect(gtmEmailRequest({ plan_id: 'p', notify_user: true, notify_plan_poc: true }).reserve).toBe(2);
      expect(gtmEmailRequest({ plan_id: 'p', notify_phase_pocs: true }).reserve).toBe(10);
      expect(gtmEmailRequest({ plan_id: 'p', notify_user: true, notify_plan_poc: true, notify_phase_pocs: true }).reserve).toBe(10); // never above the cap
    });
  });
});

describe('gtmEmailRequest: what is refused before anything is sent', () => {
  it.each([
    ['nobody chosen', { plan_id: 'p' }, 'choose who gets the report'],
    ['every choice false', { plan_id: 'p', notify_user: false, notify_plan_poc: false }, 'choose who gets the report'],
    ['no plan_id', { notify_user: true }, 'plan_id is required and must be text'],
    ['an empty plan_id', { plan_id: '', notify_user: true }, 'plan_id is required and must be text'],
    ['a plan_id that is not text', { plan_id: 5, notify_user: true }, 'plan_id is required and must be text'],
    ['a plan_id with a space', { plan_id: 'a b', notify_user: true }, 'plan_id is not a valid id'],
    ['an empty phase_id (not "none")', { plan_id: 'p', phase_id: '', notify_user: true }, 'phase_id is required and must be text'],
    ['a phase_id that is an object', { plan_id: 'p', phase_id: {}, notify_user: true }, 'phase_id is required and must be text'],
    ['notify_phase_pocs on a phase report', { plan_id: 'p', phase_id: 'ph', notify_phase_pocs: true }, 'notify_phase_pocs is for a whole-plan report'],
    ['notify_phase_poc on a plan report', { plan_id: 'p', notify_phase_poc: true }, 'notify_phase_poc is for one phase'],
    ['a choice written as text', { plan_id: 'p', notify_user: 'true' }, 'notify_user must be true or false'],
    ['a choice written as a number', { plan_id: 'p', notify_user: 1 }, 'notify_user must be true or false'],
    ['a choice written as an object', { plan_id: 'p', notify_plan_poc: {} }, 'notify_plan_poc must be true or false'],
    ['a message that is not text', { plan_id: 'p', notify_user: true, message: 5 }, 'message must be text'],
    ['a message that is a list', { plan_id: 'p', notify_user: true, message: ['hi'] }, 'message must be text'],
  ])('%s', (_name, input, text) => {
    expect(() => gtmEmailRequest(input)).toThrow(text as string);
    expect(() => gtmEmailRequest(input)).toThrow('Nothing was');
  });

  it.each(['to', 'recipients', 'recipient', 'email', 'cc', 'subject', 'html', 'orgId', 'userId', 'notifications', 'maxRecipients', 'include_summary', 'notify_item_poc'])(
    'an argument that is not an input is refused by name: %s', (key) => {
      expect(() => gtmEmailRequest({ plan_id: 'p', notify_user: true, [key]: 'x' })).toThrow(`"${key}" is not an input of send_gtm_status_report`);
    });

  it('names every input it does take, so the refusal teaches', () => {
    expect(() => gtmEmailRequest({ plan_id: 'p', notify_user: true, to: 'a@b.io' }))
      .toThrow('Its inputs are: plan_id, phase_id, notify_user, notify_plan_poc, notify_phase_poc, notify_phase_pocs, message');
  });

  it('no arguments at all, and arguments that are not an object, are refused', () => {
    expect(() => gtmEmailRequest(undefined)).toThrow('plan_id is required');
    expect(() => gtmEmailRequest(null)).toThrow('plan_id is required');
    expect(() => gtmEmailRequest([])).toThrow('the arguments must be an object');
    expect(() => gtmEmailRequest('plan-1')).toThrow('the arguments must be an object');
  });
});

describe('sendGtmStatusReport: one call', () => {
  it('sends one POST to the route as the caller, and returns what the route answered', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(1));

    const result = await sendGtmStatusReport(args, context, limiter);

    expect(result).toEqual(answer(1));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/api/gtm-plan/plan-1/phases/phase-1/send-status-report');
    expect(call.body).toEqual({ notifications: { notifyPhasePoc: true, maxRecipients: 10 } });
    expect(call.context).toMatchObject({ userId: 'user-1', sessionId: 'sess-1' });
  });

  it('settles the hour to what was attempted: delivered, refused and held back all count', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(2, 1, 1));
    await sendGtmStatusReport({ plan_id: 'p', notify_phase_pocs: true }, context, limiter); // reserved 10
    expect(limiter.used('key-1')).toBe(4);
  });

  it('keeps the whole reservation when the route did not say what it sent (the cautious reading)', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue({ success: true, message: 'ok' });
    await sendGtmStatusReport({ plan_id: 'p', notify_phase_pocs: true }, context, limiter);
    expect(limiter.used('key-1')).toBe(10);
    mockFetch.mockResolvedValue({ success: true, sent: 'many', failed: -1 });
    await sendGtmStatusReport({ plan_id: 'p2', notify_phase_pocs: true }, context, limiter);
    expect(limiter.used('key-1')).toBe(20);
  });

  it('refuses a report identical to one from the same key within 10 minutes, and does not call the route', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(1));
    await sendGtmStatusReport(args, context, limiter);
    await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow(/identical report .* Nothing was emailed/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a different message makes it a different report', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(1));
    await sendGtmStatusReport({ ...args, message: 'one' }, context, limiter);
    await sendGtmStatusReport({ ...args, message: 'two' }, context, limiter);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses once the key has used its hour, and does not call the route', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(10));
    for (let i = 0; i < 5; i++) await sendGtmStatusReport({ plan_id: `plan-${i}`, notify_phase_pocs: true }, context, limiter); // 5 x 10
    await expect(sendGtmStatusReport({ plan_id: 'plan-6', notify_phase_pocs: true }, context, limiter)).rejects.toThrow(/already sent, or has in flight, 50 of the 50 emails/);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('small reports use the hour slowly: 50 single-recipient reports fit, the 51st does not', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(1));
    for (let i = 0; i < 50; i++) await sendGtmStatusReport({ plan_id: `plan-${i}`, notify_user: true }, context, limiter);
    await expect(sendGtmStatusReport({ plan_id: 'plan-50', notify_user: true }, context, limiter)).rejects.toThrow('50 of the 50 emails');
  });

  it('each key has its own hour and its own cooldown', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(1));
    await sendGtmStatusReport(args, { ...context, apiKeyId: 'key-1' }, limiter);
    await sendGtmStatusReport(args, { ...context, apiKeyId: 'key-2' }, limiter);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('a caller with no key id is counted per user, not all together', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(1));
    await sendGtmStatusReport(args, { userId: 'user-1' }, limiter);
    await sendGtmStatusReport(args, { userId: 'user-2' }, limiter);
    expect(limiter.used('user:user-1')).toBe(1);
    expect(limiter.used('user:user-2')).toBe(1);
    await expect(sendGtmStatusReport(args, { userId: 'user-1' }, limiter)).rejects.toThrow('identical report');
  });

  describe('when the route answers with an error', () => {
    it('a 4xx (nobody to email, over the cap, not your plan) sent nothing: the hour and the cooldown are given back', async () => {
      const limiter = new GtmEmailLimiter();
      mockFetch.mockRejectedValueOnce(new Error('API error (400): The phase status report was not sent: it would go to 12 people and one call may email at most 10. Nothing was emailed.'));
      await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow('API error (400)');
      expect(limiter.used('key-1')).toBe(0);

      mockFetch.mockResolvedValueOnce(answer(1)); // the same report, retried at once, after fixing the plan
      await expect(sendGtmStatusReport(args, context, limiter)).resolves.toEqual(answer(1));
    });

    it.each([403, 404])('a %s (not your plan, no such plan) also gives everything back', async (status) => {
      const limiter = new GtmEmailLimiter();
      mockFetch.mockRejectedValueOnce(new Error(`API error (${status}): nope`));
      await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow(`API error (${status})`);
      expect(limiter.used('key-1')).toBe(0);
    });

    it('a 5xx is ambiguous (the mail service may have taken some): the reservation and the cooldown are kept', async () => {
      const limiter = new GtmEmailLimiter();
      mockFetch.mockRejectedValue(new Error('API error (502): The phase status report could not be sent: the mail service refused all 1 email'));
      await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow('API error (502)');
      expect(limiter.used('key-1')).toBe(1);
      await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow('identical report');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('a failure that is not an HTTP answer (a timeout, a broken connection) is ambiguous too', async () => {
      const limiter = new GtmEmailLimiter();
      mockFetch.mockRejectedValue(new Error('MCP self-call POST /api/gtm-plan/plan-1/phases/phase-1/send-status-report failed after 1 attempt(s) [correlationId=x]: ECONNRESET'));
      await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow('ECONNRESET');
      expect(limiter.used('key-1')).toBe(1);
      await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow('identical report');
    });

    it('the original error reaches the agent unchanged', async () => {
      const limiter = new GtmEmailLimiter();
      const original = new Error('API error (403): You do not have permission to access this plan');
      mockFetch.mockRejectedValue(original);
      await expect(sendGtmStatusReport(args, context, limiter)).rejects.toBe(original);
    });
  });

  it('refuses an invalid call before it touches the limits or the route', async () => {
    const limiter = new GtmEmailLimiter();
    await expect(sendGtmStatusReport({ plan_id: 'p' }, context, limiter)).rejects.toThrow('choose who gets the report');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(limiter.used('key-1')).toBe(0);
  });
});

describe('the audit line', () => {
  it('one line for an attempt that sent: who, which plan and phase, which people were chosen, the outcome and the counts', async () => {
    mockFetch.mockResolvedValue(answer(2, 1, 0));
    await sendGtmStatusReport({ plan_id: 'plan-9', phase_id: 'phase-9', notify_user: true, notify_phase_poc: true }, context, new GtmEmailLimiter());

    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: 'mcp_gtm_email', tool: 'send_gtm_status_report', userId: 'user-1', apiKeyId: 'key-1', external: true,
      outcome: 'ok', kind: 'phase', planId: 'plan-9', phaseId: 'phase-9', flags: ['notify_user', 'notify_phase_poc'],
      sent: 2, failed: 1, suppressed: 0,
    });
  });

  it('never holds the message, and never an address, in any outcome', async () => {
    const limiter = new GtmEmailLimiter();
    const secret = { plan_id: 'plan-1', notify_user: true, message: 'CONFIDENTIAL launch moves to 3 March, tell jane.doe@example.com' };
    mockFetch.mockResolvedValueOnce(answer(1));
    await sendGtmStatusReport(secret, context, limiter);
    await expect(sendGtmStatusReport(secret, context, limiter)).rejects.toThrow(); // cooldown
    mockFetch.mockRejectedValueOnce(new Error('API error (502): refused'));
    await expect(sendGtmStatusReport({ ...secret, message: 'CONFIDENTIAL again' }, context, limiter)).rejects.toThrow();
    await expect(sendGtmStatusReport({ plan_id: 'plan-1', message: 'CONFIDENTIAL third' }, context, limiter)).rejects.toThrow(); // invalid

    const text = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(auditLines()).toHaveLength(4);
    expect(text).not.toContain('CONFIDENTIAL');
    expect(text).not.toContain('jane.doe');
    expect(text).not.toContain('@');
  });

  it('records a refusal by a limit with the reason', async () => {
    const limiter = new GtmEmailLimiter();
    mockFetch.mockResolvedValue(answer(1));
    await sendGtmStatusReport(args, context, limiter);
    await expect(sendGtmStatusReport(args, context, limiter)).rejects.toThrow();

    const refused = auditLines().find((l) => l.outcome === 'refused');
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'cooldown', planId: 'plan-1', phaseId: 'phase-1', apiKeyId: 'key-1' });
  });

  it('records a route error with its HTTP status', async () => {
    mockFetch.mockRejectedValue(new Error('API error (404): GTM Plan not found'));
    await expect(sendGtmStatusReport(args, context, new GtmEmailLimiter())).rejects.toThrow();
    expect(auditLines()[0]).toMatchObject({ outcome: 'error', status: 404, planId: 'plan-1' });
  });

  it('records an invalid call too, so a probing agent leaves a trace', async () => {
    await expect(sendGtmStatusReport({ plan_id: 'p', to: 'a@b.io' }, context, new GtmEmailLimiter())).rejects.toThrow();
    expect(auditLines()[0]).toMatchObject({ outcome: 'refused', reason: 'invalid', userId: 'user-1', apiKeyId: 'key-1' });
  });
});

describe('the tool as registered', () => {
  const tool = mcpToolRegistry.getTool('send_gtm_status_report') as any;

  it('is behind the gtm:email scope, for aw_ keys only, and is a write', () => {
    expect(tool).toBeDefined();
    expect(tool.requiredScope).toBe('gtm:email');
    expect(tool.apiKeyOnly).toBe(true);
    expect(tool.readOnly).toBe(false);
    expect(tool.requiresUserAccount).toBe(true);
    expect(tool.internalOnly).toBeUndefined(); // the scope is what gates it; internalOnly would refuse every external key
  });

  it('says in its description who it emails, how much, and that nobody is emailed by default', () => {
    const d = tool.definition.description as string;
    expect(d).toContain('gtm:email');
    expect(d).toContain('nobody is emailed by default');
    expect(d).toContain('at most 10 people per call');
    expect(d).toContain('about 50 emails an hour per key');
    expect(d).toContain('10 minutes');
    expect(d).toContain('2000 characters');
  });

  it('declares plan_id as the only required input and bounds the message', () => {
    expect(tool.definition.inputSchema.required).toEqual(['plan_id']);
    expect(Object.keys(tool.definition.inputSchema.properties)).toEqual(['plan_id', 'phase_id', 'notify_user', 'notify_plan_poc', 'notify_phase_poc', 'notify_phase_pocs', 'message']);
    expect(tool.definition.inputSchema.properties.message.maxLength).toBe(2000);
    for (const flag of ['notify_user', 'notify_plan_poc', 'notify_phase_poc', 'notify_phase_pocs']) {
      expect(tool.definition.inputSchema.properties[flag].type).toBe('boolean');
    }
  });

  it('execute runs a call and wraps the answer as MCP text', async () => {
    mockFetch.mockResolvedValue(answer(1));
    const result = await tool.execute({ plan_id: 'plan-exec', notify_user: true }, { ...context, apiKeyId: 'key-exec' });
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(answer(1));
  });
});
