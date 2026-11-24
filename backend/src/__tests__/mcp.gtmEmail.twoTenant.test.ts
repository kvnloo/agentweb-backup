/**
 * ENG-2840 (W2-4 follow-up): `send_gtm_status_report` proved through the REAL path (MCP client -> MCP server -> tool -> mcpFetch -> the real
 * Express app and gtmPlan routes -> the real report code -> in-memory DynamoDB), with two tenants. Only the mail service is a double, so
 * what each report would have sent is read off it.
 *
 * What this adds to the tool unit tests: that the cap is enforced where the recipients are resolved, that a key can email only the people on
 * its OWN user's plans (the plan owner check is on the route, not in the tool), and that the answer, the limits and the audit line agree
 * with what was actually sent. The scope gate itself is proven at the HTTP layer in mcp.gtmEmailScopeGate.test.ts.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__gtmEmailFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import app from '../app';
import { resendService } from '../services/resendService';
import { gtmEmailLimiter } from '../mcp/server/gtmEmailLimits';
import {
  connectCaller,
  installSelfCallFetch,
  seedTwoTenantWorld,
  TENANT_A,
  TENANT_B,
  type McpCaller,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__gtmEmailFake;
const SEEDED_AT = '2026-10-01T09:00:00.000Z';
const OWNER_A_EMAIL = `${TENANT_A.owner}@${TENANT_A.orgId}.test`;
const WITH_SCOPE = ['tools:read', 'tools:execute', 'gtm:email'];

const seedPlan = (t: typeof TENANT_A, planId: string, marker: string, phases?: any[]) => fake.seed('AW-GTMPlan', {
  planId,
  userId: t.owner,
  title: `${marker} launch`,
  description: `${marker} plan`,
  dri: `plan-poc@${marker.toLowerCase()}.test`,
  status: 'in_progress',
  phases: phases ?? [
    { id: `${planId}-ph1`, title: `${marker} Research`, description: null, dri: `phase-poc@${marker.toLowerCase()}.test`, dueDate: null, status: 'in_progress', workItems: [] },
    { id: `${planId}-ph2`, title: `${marker} Build`, description: null, dri: null, dueDate: null, status: 'in_progress', workItems: [] },
  ],
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
});
const phaseWithContact = (planId: string, i: number, marker: string) => ({
  id: `${planId}-ph${i}`, title: `Phase ${i}`, description: null, dri: `contact${i}@${marker.toLowerCase()}.test`, dueDate: null, status: 'in_progress', workItems: [],
});
const snapshot = () => JSON.stringify(fake.items('AW-GTMPlan'));

let restoreFetch: () => void;
let ownerA: McpCaller;          // tenant A's key, holds gtm:email
let ownerB: McpCaller;          // tenant B's key, holds gtm:email
let sendMail: jest.SpyInstance;
let info: jest.SpyInstance;

beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  ownerA = await connectCaller(TENANT_A.owner, { scopes: WITH_SCOPE });
  ownerB = await connectCaller(TENANT_B.owner, { scopes: WITH_SCOPE });
});
afterAll(async () => {
  await Promise.all([ownerA.close(), ownerB.close()]);
  restoreFetch();
});

let n = 0;
/** a message nobody has used, so one test's report never meets another test's cooldown */
const fresh = () => `message ${++n} ${Date.now()}`;
const sentTo = () => sendMail.mock.calls.map((c) => c[0].to).sort();
const auditLines = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"mcp_gtm_email"')).map((l) => JSON.parse(l));

beforeEach(() => {
  seedTwoTenantWorld(fake);
  fake.tables.get('AW-GTMPlan')?.clear();
  fake.tables.get('AW-Settings')?.clear();
  seedPlan(TENANT_A, 'plan-a1', 'ALPHA');
  seedPlan(TENANT_B, 'plan-b1', 'BRAVO');
  sendMail = jest.spyOn(resendService, 'sendSystemEmail').mockResolvedValue({ id: 'email-1' } as any);
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  sendMail.mockRestore();
  info.mockRestore();
});

describe('a key that holds gtm:email, on its own plans', () => {
  it('a phase report goes to the phase contact only, in the bulk lane, and the answer says what was sent', async () => {
    const message = fresh();
    const r = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_phase_poc: true, message });

    expect(r.isError).toBe(false);
    expect(r.json).toEqual({
      success: true,
      message: 'The phase status report was sent successfully to 1 recipient.',
      sent: 1, failed: 0, suppressed: 0,
    });
    expect(sentTo()).toEqual(['phase-poc@alpha.test']);
    expect(sendMail.mock.calls[0][0].lane).toBe('bulk');
    expect(sendMail.mock.calls[0][0].html).toContain(message);
  });

  it('a plan report goes to the plan contact and every phase contact, each once', async () => {
    const r = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a1', notify_plan_poc: true, notify_phase_pocs: true, message: fresh() });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ success: true, sent: 2, failed: 0 });
    expect(sentTo()).toEqual(['phase-poc@alpha.test', 'plan-poc@alpha.test']);
  });

  it('notify_user emails the account owner', async () => {
    const r = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_user: true, message: fresh() });
    expect(r.isError).toBe(false);
    expect(sentTo()).toEqual([OWNER_A_EMAIL]);
  });

  it('nobody is emailed that was not chosen: the plan and phase contacts stay out of a notify_user report', async () => {
    await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_user: true, message: fresh() });
    expect(sentTo()).not.toContain('plan-poc@alpha.test');
    expect(sentTo()).not.toContain('phase-poc@alpha.test');
  });

  it('writes one audit line with the plan, the people chosen and the counts, and never the message or an address', async () => {
    const message = `SECRET launch plan ${fresh()}`;
    await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_phase_poc: true, message });

    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'mcp_gtm_email', tool: 'send_gtm_status_report', userId: TENANT_A.owner, apiKeyId: `key-${TENANT_A.owner}`,
      outcome: 'ok', kind: 'phase', planId: 'plan-a1', phaseId: 'plan-a1-ph1', flags: ['notify_phase_poc'], sent: 1, failed: 0,
    });
    const text = JSON.stringify(info.mock.calls);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('phase-poc@alpha.test');
  });
});

describe('the recipient cap, on the real route', () => {
  it('a plan report that would reach 11 people sends NOTHING, and the answer says so', async () => {
    seedPlan(TENANT_A, 'plan-a-wide', 'ALPHA', Array.from({ length: 11 }, (_, i) => phaseWithContact('plan-a-wide', i + 1, 'ALPHA')));
    const r = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a-wide', notify_phase_pocs: true, message: fresh() });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('API error (400)');
    expect(r.text).toContain('it would go to 11 people and one call may email at most 10');
    expect(r.text).toContain('Nothing was emailed');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a plan report that reaches exactly 10 people is sent whole', async () => {
    seedPlan(TENANT_A, 'plan-a-ten', 'ALPHA', Array.from({ length: 10 }, (_, i) => phaseWithContact('plan-a-ten', i + 1, 'ALPHA')));
    const r = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a-ten', notify_phase_pocs: true, message: fresh() });

    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ success: true, sent: 10, failed: 0 });
    expect(sendMail).toHaveBeenCalledTimes(10);
  });

  it('a call refused for being over the cap gives its reservation back, so the same report can be retried at once after the plan is fixed', async () => {
    seedPlan(TENANT_A, 'plan-a-fix', 'ALPHA', Array.from({ length: 11 }, (_, i) => phaseWithContact('plan-a-fix', i + 1, 'ALPHA')));
    const args = { plan_id: 'plan-a-fix', notify_phase_pocs: true, message: fresh() };
    expect((await ownerA.call('send_gtm_status_report', args)).isError).toBe(true);
    const usedAfterRefusal = gtmEmailLimiter.used(`key-${TENANT_A.owner}`);

    // one phase contact is removed; the identical request now fits
    const row = fake.items('AW-GTMPlan').find((p: any) => p.planId === 'plan-a-fix');
    row.phases = row.phases.slice(0, 10);
    const again = await ownerA.call('send_gtm_status_report', args);
    expect(again.isError).toBe(false);
    expect(again.json).toMatchObject({ sent: 10 });
    expect(usedAfterRefusal).toBeLessThanOrEqual(gtmEmailLimiter.used(`key-${TENANT_A.owner}`));
  });
});

describe('a report to nobody', () => {
  it('a phase with no contact: the route answers 400, nothing is sent, and it can be retried at once', async () => {
    const args = { plan_id: 'plan-a1', phase_id: 'plan-a1-ph2', notify_phase_poc: true, message: fresh() };
    const r = await ownerA.call('send_gtm_status_report', args);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('API error (400)');
    expect(r.text).toContain('nobody was chosen to receive it');
    expect(sendMail).not.toHaveBeenCalled();

    const row = fake.items('AW-GTMPlan').find((p: any) => p.planId === 'plan-a1');
    row.phases[1].dri = 'late-contact@alpha.test';
    const retry = await ownerA.call('send_gtm_status_report', args);
    expect(retry.isError).toBe(false);
    expect(sentTo()).toEqual(['late-contact@alpha.test']);
  });
});

describe('one tenant can never email another tenant\'s people', () => {
  it("tenant B's key cannot send a report about tenant A's plan: the route refuses, nothing is sent, nothing is changed", async () => {
    const before = snapshot();
    const r = await ownerB.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_phase_poc: true, message: fresh() });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('API error (403)');
    expect(sendMail).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it("the same for a plan report, and the other way round (A cannot report on B's plan)", async () => {
    const asB = await ownerB.call('send_gtm_status_report', { plan_id: 'plan-a1', notify_plan_poc: true, message: fresh() });
    const asA = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-b1', notify_plan_poc: true, message: fresh() });
    for (const r of [asA, asB]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain('API error (403)');
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a plan that does not exist is a 404, and sends nothing', async () => {
    const r = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-nope', notify_user: true, message: fresh() });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('API error (404)');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a phase that is not in the plan is a 404, and sends nothing', async () => {
    const r = await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'phase-of-someone-else', notify_user: true, message: fresh() });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('API error (404)');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('the keys are counted apart: tenant A spending its limit does not touch tenant B', async () => {
    expect(gtmEmailLimiter.used(`key-${TENANT_B.owner}`)).toBe(0);
    await ownerA.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_phase_poc: true, message: fresh() });
    expect(gtmEmailLimiter.used(`key-${TENANT_B.owner}`)).toBe(0);
  });
});

describe('what the tool itself refuses, before the route is reached', () => {
  it('nobody chosen, a wrong choice, an unknown argument: refused, nothing sent, nothing changed', async () => {
    const before = snapshot();
    for (const args of [
      { plan_id: 'plan-a1' },
      { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_phase_pocs: true },
      { plan_id: 'plan-a1', notify_user: true, to: 'someone@else.test' },
      { plan_id: 'plan-a1', notify_user: 'yes' },
    ]) {
      const r = await ownerA.call('send_gtm_status_report', args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Nothing was (emailed|changed)/);
    }
    expect(sendMail).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('manage_gtm_items still refuses every email argument, even for a key that holds gtm:email, and points at the tool', async () => {
    const r = await ownerA.call('manage_gtm_items', { action: 'update_work_item', plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', work_item_id: 'x', status: 'completed', notify_user: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('emailing people is not available over MCP');
    expect(r.text).toContain('send_gtm_status_report');
    expect(r.text).toContain('gtm:email');
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('the limits, on the real route', () => {
  it('the same report is not sent twice in a row from the same key', async () => {
    const args = { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_phase_poc: true, message: fresh() };
    expect((await ownerA.call('send_gtm_status_report', args)).isError).toBe(false);
    const second = await ownerA.call('send_gtm_status_report', args);
    expect(second.isError).toBe(true);
    expect(second.text).toContain('identical report');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('a key that has used its hour is refused, and nothing more is sent', async () => {
    const key = `key-${TENANT_B.owner}`;
    seedPlan(TENANT_B, 'plan-b-ten', 'BRAVO', Array.from({ length: 10 }, (_, i) => phaseWithContact('plan-b-ten', i + 1, 'BRAVO')));
    for (let i = 0; i < 5; i++) {
      const r = await ownerB.call('send_gtm_status_report', { plan_id: 'plan-b-ten', notify_phase_pocs: true, message: fresh() });
      expect(r.isError).toBe(false);
    }
    expect(gtmEmailLimiter.used(key)).toBe(50);
    expect(sendMail).toHaveBeenCalledTimes(50);

    const sixth = await ownerB.call('send_gtm_status_report', { plan_id: 'plan-b-ten', notify_phase_pocs: true, message: fresh() });
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toContain('50 of the 50 emails');
    expect(sendMail).toHaveBeenCalledTimes(50);
    expect(auditLines().filter((l) => l.outcome === 'refused' && l.reason === 'budget')).toHaveLength(1);
  });
});

describe('who may reach the tool at all', () => {
  // The scope itself is checked per request at the HTTP layer (mcpServer.ts), by design for every opt-in scope: see
  // mcp.gtmEmailScopeGate.test.ts. This harness connects at the server core, below that layer. What the registry adds underneath, and what
  // this pins, is that a signed-in OAuth client can never reach the handler, even if the HTTP check were bypassed or a session were reused.
  it('a signed-in OAuth client is refused by the registry: it needs an aw_ key that holds gtm:email, and nothing is sent', async () => {
    const oauth = await connectCaller(TENANT_A.owner, { authMethod: 'oauth' });
    try {
      const before = snapshot();
      const r = await oauth.call('send_gtm_status_report', { plan_id: 'plan-a1', phase_id: 'plan-a1-ph1', notify_phase_poc: true, message: fresh() });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("needs an AgentWeb API key that holds the 'gtm:email' scope");
      expect(sendMail).not.toHaveBeenCalled();
      expect(snapshot()).toBe(before);
    } finally {
      await oauth.close();
    }
  });
});
