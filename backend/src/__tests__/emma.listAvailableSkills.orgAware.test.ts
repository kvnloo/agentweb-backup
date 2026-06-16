// Verifies Emma's list_available_skills tool honors org-sharing semantics:
//  - Passes orgId to skillService.getSkillsAvailableToUser when the caller
//    is in an org AND `shareSettings.skills` is effectively enabled for them
//    (plain members need enabled=true; editors and the org owner always do).
//  - Falls back to no-orgId (no org fanout) for non-org users, plain members
//    when the toggle is off, or when DB lookups fail.

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

jest.mock('../services/skillService', () => ({
  skillService: { getSkillsAvailableToUser: jest.fn() },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { skillService } from '../services/skillService';
import { userDb, orgDb } from '../services/db';

const ORG_ID = 'org-abc';
const PLAIN_MEMBER = { userId: 'member-1', orgId: ORG_ID, orgRole: 'member', isAdmin: false };
const ORG_OWNER = { userId: 'user-1', orgId: ORG_ID, orgRole: 'owner', isAdmin: false };
const EDITOR = { userId: 'editor-1', orgId: ORG_ID, orgRole: 'member', isAdmin: false };
const NON_ORG_USER = { userId: 'user-1', isAdmin: false };

const orgWithSkillsEnabled = {
  orgId: ORG_ID,
  ownerUserId: 'user-1',
  shareSettings: { skills: { enabled: true, editors: ['editor-1'] } },
};
const orgWithSkillsDisabled = {
  orgId: ORG_ID,
  ownerUserId: 'user-1',
  shareSettings: { skills: { enabled: false, editors: ['editor-1'] } },
};

describe('Emma list_available_skills - org-sharing toggle gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([]);
  });

  it('plain member + sharing enabled → orgId IS passed (org fanout active)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(PLAIN_MEMBER);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(orgWithSkillsEnabled);

    const tool = emmaToolRegistry.getTool('list_available_skills')!;
    await tool.execute({}, { userId: 'member-1' });

    expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', ORG_ID);
  });

  it('plain member + sharing disabled → orgId NOT passed (toggle hides org skills)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(PLAIN_MEMBER);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(orgWithSkillsDisabled);

    const tool = emmaToolRegistry.getTool('list_available_skills')!;
    await tool.execute({}, { userId: 'member-1' });

    expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', undefined);
  });

  it('editor + sharing disabled → orgId IS passed (editors immune to toggle)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(EDITOR);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(orgWithSkillsDisabled);

    const tool = emmaToolRegistry.getTool('list_available_skills')!;
    await tool.execute({}, { userId: 'editor-1' });

    expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('editor-1', ORG_ID);
  });

  it('org owner + sharing disabled → orgId IS passed (owner immune to toggle)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(ORG_OWNER);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(orgWithSkillsDisabled);

    const tool = emmaToolRegistry.getTool('list_available_skills')!;
    await tool.execute({}, { userId: 'user-1' });

    expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('user-1', ORG_ID);
  });

  it('non-org user → orgId undefined (does not break)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(NON_ORG_USER);
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(null);

    const tool = emmaToolRegistry.getTool('list_available_skills')!;
    const result = await tool.execute({}, { userId: 'user-1' });

    expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('user-1', undefined);
    expect(result.skills).toBeDefined();
  });

  it('userDb failure → orgId undefined, still lists skills (best-effort)', async () => {
    (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));
    (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([
      {
        skillId: 'pub-1',
        name: 'Published Skill',
        description: 'd',
        toolNames: ['t1'],
        ownerId: 'other',
        isPublished: true,
      },
    ]);

    const tool = emmaToolRegistry.getTool('list_available_skills')!;
    const result = await tool.execute({}, { userId: 'user-1' });

    expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('user-1', undefined);
    expect(result.skills.length).toBeGreaterThan(0);
  });

  it('orgDb failure → orgId undefined, still lists skills (best-effort)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(PLAIN_MEMBER);
    (orgDb.getOrgById as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));

    const tool = emmaToolRegistry.getTool('list_available_skills')!;
    const result = await tool.execute({}, { userId: 'user-1' });

    expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('user-1', undefined);
    expect(result.skills).toBeDefined();
  });
});
