// Verifies Emma's create_skill tool stamps org ownership and enforces the
// same org create-permission gate as the REST route (POST /api/user-skills):
//  - The new skill is stamped with ownerId, visibility='private', and the
//    creator's orgId (so it participates in org fanout and editor/transfer logic).
//  - Org owners and listed skills editors may create; plain org members are
//    rejected ("Skills are managed by your org admin").
//  - Solo users (no org) may always create; the skill carries no orgId.

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
  // emma/tools.ts imports these named exports at module load
  accountMemoryDb: {},
  orgMemoryDb: {},
  crmDb: {},
}));

const mockCreateSkill = jest.fn();
const mockUpdateSkill = jest.fn();
jest.mock('../services/skillService', () => ({
  skillService: {
    createSkill: mockCreateSkill,
    updateSkill: mockUpdateSkill,
  },
}));

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { userDb, orgDb } from '../services/db';

const ORG_ID = 'org-abc';
const OWNER = { userId: 'owner-1', orgId: ORG_ID, orgRole: 'owner' };
const EDITOR = { userId: 'editor-1', orgId: ORG_ID, orgRole: 'member' };
const PLAIN_MEMBER = { userId: 'member-1', orgId: ORG_ID, orgRole: 'member' };
const SOLO = { userId: 'solo-1' };

const orgEnabledNoEditors = {
  orgId: ORG_ID,
  ownerUserId: 'owner-1',
  shareSettings: { skills: { enabled: true, editors: [] } },
};
const orgWithEditor = {
  orgId: ORG_ID,
  ownerUserId: 'owner-1',
  shareSettings: { skills: { enabled: false, editors: ['editor-1'] } },
};

const baseSkill = (id: string) => ({
  skillId: id,
  name: 'S',
  description: 'd',
  toolNames: ['read_brand_guidelines'],
  isPublished: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

function getTool() {
  const tool = emmaToolRegistry.getTool('create_skill');
  if (!tool) throw new Error('create_skill tool not registered');
  return tool;
}

describe('Emma create_skill — org ownership stamping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateSkill.mockResolvedValue(baseSkill('skill-new'));
    mockUpdateSkill.mockResolvedValue(undefined);
  });

  it('stamps ownerId, visibility=private and the creator orgId (org owner)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(OWNER);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(orgEnabledNoEditors);

    const res: any = await getTool().execute(
      { name: 'S', description: 'd', toolNames: ['read_brand_guidelines'] },
      { userId: OWNER.userId },
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSkill).toHaveBeenCalledTimes(1);
    const saved = mockUpdateSkill.mock.calls[0][0];
    expect(saved.ownerId).toBe(OWNER.userId);
    expect(saved.visibility).toBe('private');
    expect(saved.orgId).toBe(ORG_ID);
    expect(saved.isBuiltIn).toBe(false);
  });

  it('allows a listed skills editor to create even when enabled=false', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(EDITOR);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(orgWithEditor);

    const res: any = await getTool().execute(
      { name: 'S', description: 'd', toolNames: [] },
      { userId: EDITOR.userId },
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSkill).toHaveBeenCalledTimes(1);
    expect(mockUpdateSkill.mock.calls[0][0].orgId).toBe(ORG_ID);
  });

  it('rejects a plain org member (no editor/owner role) without creating a skill', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(PLAIN_MEMBER);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(orgEnabledNoEditors);

    const res: any = await getTool().execute(
      { name: 'S', description: 'd', toolNames: [] },
      { userId: PLAIN_MEMBER.userId },
    );

    expect(res.success).toBe(false);
    expect(String(res.error || res.message)).toMatch(/org admin|not authorized|permission/i);
    expect(mockCreateSkill).not.toHaveBeenCalled();
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });

  it('allows a solo user (no org) to create; skill carries no orgId', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(SOLO);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(null);

    const res: any = await getTool().execute(
      { name: 'S', description: 'd', toolNames: [] },
      { userId: SOLO.userId },
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSkill).toHaveBeenCalledTimes(1);
    expect(mockUpdateSkill.mock.calls[0][0].orgId).toBeUndefined();
  });

  it('requires user context', async () => {
    await expect(
      getTool().execute({ name: 'S', description: 'd', toolNames: [] }, {}),
    ).rejects.toThrow(/Authentication required/i);
  });
});
