/**
 * ENG-1853 — route-level tests for the Approval Desk's first-ever HTTP
 * surface over approvalInboxService. Verification section's own explicit
 * ask: "a logged-in Matt cannot see/act on Harsha's queue" — every
 * authorization case below exists to prove exactly that, not just that the
 * routes return 200 on the happy path.
 *
 * Mocks authenticateToken to decode a REAL JWT (same pattern as
 * adminUsage.costAggregation.test.ts) so the real isAdmin middleware
 * genuinely gates on req.user.isAdmin — the non-admin -> 403 and
 * missing-token -> 401 cases exercise real middleware wiring, not a
 * re-declaration of it.
 */

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import approvalDeskRoutes from '../routes/approvalDesk';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ message: 'Unauthorized' });
    }
  },
}));

jest.mock('../services/approverDirectory', () => ({
  getApproverForEmail: jest.fn(),
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: {
    listPendingForApprover: jest.fn(),
    listAwaitingDispatchForApprover: jest.fn(),
    listByManifest: jest.fn(),
    getDecision: jest.fn(),
    claimDecision: jest.fn(),
  },
}));

jest.mock('../services/approvalInboxExecution', () => ({
  executeResolvedDecision: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    executeApprovalInboxMetaWriteManifest: jest.fn(),
  },
}));

import { getApproverForEmail } from '../services/approverDirectory';
import { approvalInboxService } from '../services/approvalInboxService';
import { executeResolvedDecision } from '../services/approvalInboxExecution';
import { agentModeService } from '../services/agentModeService';

const mockGetApproverForEmail = getApproverForEmail as jest.Mock;
const mockListPendingForApprover = approvalInboxService.listPendingForApprover as jest.Mock;
const mockListAwaitingDispatch = approvalInboxService.listAwaitingDispatchForApprover as jest.Mock;
const mockListByManifest = approvalInboxService.listByManifest as jest.Mock;
const mockGetDecision = approvalInboxService.getDecision as jest.Mock;
const mockClaimDecision = approvalInboxService.claimDecision as jest.Mock;
const mockExecuteResolvedDecision = executeResolvedDecision as jest.Mock;
const mockExecuteManifest = agentModeService.executeApprovalInboxMetaWriteManifest as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/approval-desk', approvalDeskRoutes);

const mattToken = jwt.sign({ userId: 'u-matt', email: 'matt@example.com', isAdmin: true }, JWT_SECRET);
const nonAdminToken = jwt.sign({ userId: 'u-plain', email: 'plain@example.com', isAdmin: false }, JWT_SECRET);

function decisionFor(id: string, approver: string, overrides: Partial<any> = {}) {
  return {
    decisionId: id,
    gateType: 'meta_write',
    audience: 'team',
    approver,
    status: 'pending_team_review',
    subjectLabel: `Account for ${approver}`,
    businessImpact: 'A change is waiting.',
    evidencePacket: {},
    manifestId: 'manifest-1',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListAwaitingDispatch.mockResolvedValue([]);
  mockGetApproverForEmail.mockImplementation(async (email: string) => (email === 'matt@example.com' ? 'matt' : undefined));
});

describe('auth gating (shared across every route)', () => {
  it('401s with no token', async () => {
    const res = await request(app).get('/api/approval-desk/queue');
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin caller', async () => {
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${nonAdminToken}`);
    expect(res.status).toBe(403);
  });

  it('403s an admin whose login email is not a named reviewer', async () => {
    const unnamedAdminToken = jwt.sign({ userId: 'u-x', email: 'someone-else@example.com', isAdmin: true }, JWT_SECRET);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${unnamedAdminToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /queue', () => {
  it('groups the caller\'s own pending decisions by manifestId', async () => {
    mockListPendingForApprover.mockResolvedValue([
      decisionFor('d1', 'matt', { manifestId: 'm1', subjectLabel: 'Haven' }),
      decisionFor('d2', 'matt', { manifestId: 'm1', subjectLabel: 'Haven' }),
      decisionFor('d3', 'matt', { manifestId: 'm2', subjectLabel: 'Every' }),
    ]);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(200);
    expect(mockListPendingForApprover).toHaveBeenCalledWith('matt');
    expect(res.body.manifests).toHaveLength(2);
    const haven = res.body.manifests.find((m: any) => m.manifestId === 'm1');
    expect(haven.itemCount).toBe(2);
  });

  it('labels a Meta write group by its ad account when the producer label has no company name', async () => {
    mockListPendingForApprover.mockResolvedValue([
      decisionFor('d1', 'matt', {
        manifestId: 'm1',
        subjectLabel: 'Meta Ads · Account 1339414687604223',
        metaWriteDispatch: { resolvedAccountId: 'act_1339414687604223' },
      }),
    ]);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(200);
    expect(res.body.manifests[0].accountLabel).toBe('Ad account 1339414687604223');
  });

  it('keeps a fully answered packet in the queue until Approve All has dispatched it, and says so', async () => {
    mockListPendingForApprover.mockResolvedValue([]);
    mockListAwaitingDispatch.mockResolvedValue([
      decisionFor('d1', 'matt', { manifestId: 'm1', status: 'dispatching', verdict: 'approve' }),
      decisionFor('d2', 'matt', { manifestId: 'm1', status: 'dispatching', verdict: 'approve' }),
    ]);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(200);
    expect(res.body.manifests).toHaveLength(1);
    expect(res.body.manifests[0]).toMatchObject({ manifestId: 'm1', itemCount: 2, pendingCount: 0, readyToDispatchCount: 2 });
  });

  it('counts pending and ready-to-dispatch items separately within one packet', async () => {
    mockListPendingForApprover.mockResolvedValue([decisionFor('d1', 'matt', { manifestId: 'm1' })]);
    mockListAwaitingDispatch.mockResolvedValue([decisionFor('d2', 'matt', { manifestId: 'm1', status: 'dispatching', verdict: 'approve' })]);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${mattToken}`);
    expect(res.body.manifests[0]).toMatchObject({ itemCount: 2, pendingCount: 1, readyToDispatchCount: 1 });
  });

  it('files act_333 and 333 under ONE account group', async () => {
    mockListPendingForApprover.mockResolvedValue([
      decisionFor('d1', 'matt', { manifestId: 'm1', metaWriteDispatch: { resolvedAccountId: 'act_333' } }),
      decisionFor('d2', 'matt', { manifestId: 'm2', metaWriteDispatch: { resolvedAccountId: '333' } }),
    ]);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${mattToken}`);
    expect(res.body.manifests.map((m: any) => m.accountId)).toEqual(['333', '333']);
  });

  it('does not file a packet that spans two ad accounts under the first one', async () => {
    mockListPendingForApprover.mockResolvedValue([
      decisionFor('d1', 'matt', { manifestId: 'm1', metaWriteDispatch: { resolvedAccountId: 'act_ALPHA' } }),
      decisionFor('d2', 'matt', { manifestId: 'm1', metaWriteDispatch: { resolvedAccountId: 'act_BETA' } }),
    ]);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${mattToken}`);
    const m = res.body.manifests[0];
    expect(m.accountId).toBeNull();
    expect(m.accountLabel).toBeNull();
    expect(m.accountIds.sort()).toEqual(['ALPHA', 'BETA']);
  });

  it('excludes pre-existing decisions with no manifestId instead of surfacing a dead-end entry (found live on env1)', async () => {
    mockListPendingForApprover.mockResolvedValue([
      decisionFor('legacy-1', 'matt', { manifestId: undefined as any }),
      decisionFor('d1', 'matt', { manifestId: 'm1' }),
    ]);
    const res = await request(app).get('/api/approval-desk/queue').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(200);
    expect(res.body.manifests).toHaveLength(1);
    expect(res.body.manifests[0].manifestId).toBe('m1');
  });
});

describe('GET /manifest/:manifestId — Matt cannot see Harsha\'s items', () => {
  it('only returns the caller\'s own decisions within a shared manifest', async () => {
    mockListByManifest.mockResolvedValue([
      decisionFor('d1', 'matt', { manifestId: 'm1' }),
      decisionFor('d2', 'harsha', { manifestId: 'm1' }),
    ]);
    const res = await request(app).get('/api/approval-desk/manifest/m1').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].decisionId).toBe('d1');
  });

  it('passes a chatUrl on the customer-portal origin through, and drops any other (agent-authored) link', async () => {
    const original = process.env.CUSTOMER_FRONTEND_URL;
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    try {
      mockListByManifest.mockResolvedValue([
        decisionFor('d1', 'matt', { manifestId: 'm1', evidencePacket: { chatUrl: 'https://app.agentweb.pro/agent-mode/s1' } }),
        decisionFor('d2', 'matt', { manifestId: 'm1', evidencePacket: { chatUrl: 'https://evil.example.com/agent-mode/s1', researchSummary: 'keep me' } }),
        decisionFor('d3', 'matt', { manifestId: 'm1', evidencePacket: { chatUrl: 'javascript:alert(1)' } }),
      ]);
      const res = await request(app).get('/api/approval-desk/manifest/m1').set('Authorization', `Bearer ${mattToken}`);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.decisions.map((d: any) => [d.decisionId, d]));
      expect(byId.d1.evidencePacket.chatUrl).toBe('https://app.agentweb.pro/agent-mode/s1');
      expect(byId.d2.evidencePacket.chatUrl).toBeUndefined();
      expect(byId.d2.evidencePacket.researchSummary).toBe('keep me');
      expect(byId.d3.evidencePacket.chatUrl).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.CUSTOMER_FRONTEND_URL;
      else process.env.CUSTOMER_FRONTEND_URL = original;
    }
  });

  it('404s when every item in the manifest belongs to a different approver', async () => {
    mockListByManifest.mockResolvedValue([decisionFor('d1', 'harsha', { manifestId: 'm1' })]);
    const res = await request(app).get('/api/approval-desk/manifest/m1').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /decision/:decisionId/verdict', () => {
  it('400s on an invalid verdict value', async () => {
    const res = await request(app)
      .post('/api/approval-desk/decision/d1/verdict')
      .set('Authorization', `Bearer ${mattToken}`)
      .send({ verdict: 'yolo' });
    expect(res.status).toBe(400);
    expect(mockGetDecision).not.toHaveBeenCalled();
  });

  it('404s rather than acting when the decision belongs to a different approver (Matt cannot act on Harsha\'s item)', async () => {
    mockGetDecision.mockResolvedValue(decisionFor('d1', 'harsha'));
    const res = await request(app)
      .post('/api/approval-desk/decision/d1/verdict')
      .set('Authorization', `Bearer ${mattToken}`)
      .send({ verdict: 'approve' });
    expect(res.status).toBe(404);
    expect(mockClaimDecision).not.toHaveBeenCalled();
  });

  it('claims the decision and runs the same execution path Slack itself runs', async () => {
    const existing = decisionFor('d1', 'matt');
    mockGetDecision.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, status: 'dispatching', verdict: 'approve' });
    mockClaimDecision.mockResolvedValue({ claimed: true, decision: { ...existing, status: 'dispatching', verdict: 'approve' } });

    const res = await request(app)
      .post('/api/approval-desk/decision/d1/verdict')
      .set('Authorization', `Bearer ${mattToken}`)
      .send({ verdict: 'approve' });

    expect(res.status).toBe(200);
    expect(mockClaimDecision).toHaveBeenCalledWith('d1', 'approve', 'matt', undefined);
    expect(mockExecuteResolvedDecision).toHaveBeenCalled();
  });
});

describe('POST /manifest/:manifestId/approve-all', () => {
  it('409s when the caller\'s own items still need an individual answer', async () => {
    mockListByManifest.mockResolvedValue([
      decisionFor('d1', 'matt', { status: 'dispatching' }),
      decisionFor('d2', 'matt', { status: 'pending_team_review' }),
    ]);
    const res = await request(app).post('/api/approval-desk/manifest/m1/approve-all').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(409);
    expect(mockExecuteManifest).not.toHaveBeenCalled();
  });

  it('dispatches once every caller-owned item is individually resolved', async () => {
    mockListByManifest.mockResolvedValue([decisionFor('d1', 'matt', { status: 'dispatching' })]);
    mockExecuteManifest.mockResolvedValue({ outcome: 'executed', summary: { status: 'fully_applied', items: [] } });

    const res = await request(app).post('/api/approval-desk/manifest/m1/approve-all').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(200);
    expect(mockExecuteManifest).toHaveBeenCalledWith('m1', 'matt');
    expect(res.body.summary.status).toBe('fully_applied');
  });

  it('second-review fix: a not_all_resolved outcome from the executor itself carries a real message, not a bare 409', async () => {
    mockListByManifest.mockResolvedValue([decisionFor('d1', 'matt', { status: 'dispatching' })]);
    mockExecuteManifest.mockResolvedValue({ outcome: 'not_all_resolved', unresolved: ['d1'] });

    const res = await request(app).post('/api/approval-desk/manifest/m1/approve-all').set('Authorization', `Bearer ${mattToken}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toEqual(expect.stringContaining('d1'));
  });
});
