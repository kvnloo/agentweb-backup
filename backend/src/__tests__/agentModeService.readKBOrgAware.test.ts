// Regression test for H2 — Emma's readSingleKnowledgeBaseFile must honor
// shareSettings.knowledgeBase: editors and plain members (when the toggle is
// on) of the SAME org can read a private KB; cross-org callers and plain
// members with the toggle off remain blocked. The fix added an org-aware
// canViewItem check parallel to the user-facing /knowledge-base route.

import { AgentModeService } from '../services/agentModeService';

jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
    updateTask: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
    getOrgMembers: jest.fn(),
  },
}));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: jest.fn(() => ({ file: jest.fn() })),
  })),
}));

jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(() => Promise.resolve('mock-private-key')),
}));

const ORG_ID = 'org-shared';
const OWNER_ID = 'owner-user';
const EDITOR_ID = 'editor-user';
const PLAIN_MEMBER_ID = 'plain-user';
const OUTSIDER_ID = 'outsider-user';
const KB_ID = 'kb-task-1';

function orgWith(enabled: boolean, editors: string[] = []) {
  return {
    orgId: ORG_ID,
    ownerUserId: OWNER_ID,
    shareSettings: { knowledgeBase: { enabled, editors } },
  };
}

describe('AgentModeService.readSingleKnowledgeBaseFile — org sharing', () => {
  let svc: AgentModeService;
  const { taskDb, userDb, orgDb } = require('../services/db');

  // The KB task is private and owned by OWNER_ID. We force size=0 so the
  // function short-circuits BEFORE hitting GCS — that way the test only
  // exercises the auth check, not file fetch.
  const privateKbTask = {
    taskId: KB_ID,
    userId: OWNER_ID,
    knowledgeBaseType: 'private',
    knowledgeBaseSize: 0,
    knowledgeBase: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AgentModeService();
    taskDb.getTaskById.mockResolvedValue(privateKbTask);
    userDb.getUserById.mockImplementation(async (id: string) => {
      if (id === OWNER_ID) return { userId: OWNER_ID, orgId: ORG_ID, orgRole: 'owner' };
      if (id === EDITOR_ID) return { userId: EDITOR_ID, orgId: ORG_ID, orgRole: 'member' };
      if (id === PLAIN_MEMBER_ID) return { userId: PLAIN_MEMBER_ID, orgId: ORG_ID, orgRole: 'member' };
      if (id === OUTSIDER_ID) return { userId: OUTSIDER_ID, orgId: 'other-org', orgRole: 'member' };
      return null;
    });
  });

  it('blocks cross-org callers regardless of shareSettings', async () => {
    orgDb.getOrgById.mockResolvedValue(orgWith(true, [EDITOR_ID]));
    const res = await svc.readSingleKnowledgeBaseFile(KB_ID, 'knowledge-base.txt', OUTSIDER_ID);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Not authorized/i);
  });

  it('blocks plain member when shareSettings.knowledgeBase.enabled is false', async () => {
    orgDb.getOrgById.mockResolvedValue(orgWith(false, []));
    const res = await svc.readSingleKnowledgeBaseFile(KB_ID, 'knowledge-base.txt', PLAIN_MEMBER_ID);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Not authorized/i);
  });

  it('allows plain member when shareSettings.knowledgeBase.enabled is true', async () => {
    orgDb.getOrgById.mockResolvedValue(orgWith(true, []));
    const res = await svc.readSingleKnowledgeBaseFile(KB_ID, 'knowledge-base.txt', PLAIN_MEMBER_ID);
    // Auth passes — we then short-circuit on "empty or does not exist" because size=0
    expect(res.success).toBe(false);
    expect(res.message).not.toMatch(/Not authorized/i);
    expect(res.message).toMatch(/empty|does not exist/i);
  });

  it('allows listed editor regardless of toggle', async () => {
    orgDb.getOrgById.mockResolvedValue(orgWith(false, [EDITOR_ID]));
    const res = await svc.readSingleKnowledgeBaseFile(KB_ID, 'knowledge-base.txt', EDITOR_ID);
    expect(res.success).toBe(false);
    expect(res.message).not.toMatch(/Not authorized/i);
    expect(res.message).toMatch(/empty|does not exist/i);
  });

  it('allows org owner regardless of toggle and editors list', async () => {
    // Caller is a DIFFERENT user who happens to be org owner; KB is owned by another member
    userDb.getUserById.mockImplementation(async (id: string) => {
      if (id === 'admin-owner') return { userId: 'admin-owner', orgId: ORG_ID, orgRole: 'owner' };
      if (id === OWNER_ID) return { userId: OWNER_ID, orgId: ORG_ID, orgRole: 'member' };
      return null;
    });
    orgDb.getOrgById.mockResolvedValue(orgWith(false, []));
    const res = await svc.readSingleKnowledgeBaseFile(KB_ID, 'knowledge-base.txt', 'admin-owner');
    expect(res.success).toBe(false);
    expect(res.message).not.toMatch(/Not authorized/i);
    expect(res.message).toMatch(/empty|does not exist/i);
  });

  it('public KBs are accessible to any user (unchanged)', async () => {
    taskDb.getTaskById.mockResolvedValue({ ...privateKbTask, knowledgeBaseType: 'public' });
    orgDb.getOrgById.mockResolvedValue(orgWith(false, []));
    const res = await svc.readSingleKnowledgeBaseFile(KB_ID, 'knowledge-base.txt', OUTSIDER_ID);
    expect(res.message).not.toMatch(/Not authorized/i);
  });

  it('owner reading their own KB is unchanged', async () => {
    const res = await svc.readSingleKnowledgeBaseFile(KB_ID, 'knowledge-base.txt', OWNER_ID);
    expect(res.message).not.toMatch(/Not authorized/i);
    expect(res.message).toMatch(/empty|does not exist/i);
  });
});
