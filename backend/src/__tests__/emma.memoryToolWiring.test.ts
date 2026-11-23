/**
 * ENG-2840 (W2-1): the four registered memory tools call the right body in emma/impl/memory.ts.
 *
 * The bodies have their own tests (emma/impl/__tests__/memory.test.ts). This file drives the tools through the registry, the way an agent
 * run does, so a swapped or dropped delegation in emma/tools.ts (delete_org_memory wired to the account delete, say) cannot pass.
 */
const mockAddAccount = jest.fn();
const mockAddOrg = jest.fn();
const mockDeleteAccount = jest.fn();
const mockDeleteOrg = jest.fn();
const mockGetUser = jest.fn();
const mockGetOrg = jest.fn();

jest.mock('../services/db', () => ({
  accountMemoryDb: { addMemory: (...a: any[]) => mockAddAccount(...a), deleteMemory: (...a: any[]) => mockDeleteAccount(...a) },
  orgMemoryDb: { addMemory: (...a: any[]) => mockAddOrg(...a), deleteMemory: (...a: any[]) => mockDeleteOrg(...a) },
  userDb: { getUserById: (...a: any[]) => mockGetUser(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrg(...a) },
  crmDb: {},
}));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/accountSummaryService', () => ({ getAccountSummary: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
}));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) } }));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

const run = (name: string, args: any, context: any = { userId: 'u1', sessionId: 's1' }) => emmaToolRegistry.getTool(name)!.execute(args, context);

describe('the registered memory tools run the shared bodies', () => {
  beforeEach(() => {
    mockAddAccount.mockReset().mockResolvedValue({ memoryId: 'm1' });
    mockAddOrg.mockReset().mockResolvedValue({ memoryId: 'o1' });
    mockDeleteAccount.mockReset().mockResolvedValue(true);
    mockDeleteOrg.mockReset().mockResolvedValue(true);
    mockGetUser.mockReset().mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: 'admin' });
    mockGetOrg.mockReset().mockResolvedValue({ orgId: 'org1', ownerUserId: 'owner1' });
  });

  it('registers all four, and says owners AND admins may delete org memories', () => {
    for (const name of ['save_memory', 'delete_memory', 'save_org_memory', 'delete_org_memory']) {
      expect(emmaToolRegistry.getTool(name)).toBeTruthy();
    }
    expect(emmaToolRegistry.getTool('delete_org_memory')!.definition.description).toMatch(/owners and admins/);
  });

  it('save_memory writes to the ACCOUNT table only', async () => {
    const res: any = await run('save_memory', { content: 'a fact', category: 'insight' });
    expect(res).toMatchObject({ success: true, memoryId: 'm1' });
    expect(mockAddAccount).toHaveBeenCalledWith('u1', 'insight', 'a fact', 's1', undefined);
    expect(mockAddOrg).not.toHaveBeenCalled();
  });

  it('save_org_memory writes to the ORG table only', async () => {
    const res: any = await run('save_org_memory', { content: 'an org fact', category: 'workflow' });
    expect(res).toMatchObject({ success: true, memoryId: 'o1' });
    expect(mockAddOrg).toHaveBeenCalledWith('org1', 'workflow', 'an org fact', 'u1', undefined);
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('delete_memory deletes from the ACCOUNT table only', async () => {
    expect(await run('delete_memory', { memoryId: 'm1' })).toEqual({ success: true, message: 'Memory m1 deleted.' });
    expect(mockDeleteAccount).toHaveBeenCalledWith('u1', 'm1');
    expect(mockDeleteOrg).not.toHaveBeenCalled();
  });

  it('delete_org_memory deletes from the ORG table only', async () => {
    expect(await run('delete_org_memory', { memoryId: 'o1' })).toEqual({ success: true, message: 'Org memory o1 deleted.' });
    expect(mockDeleteOrg).toHaveBeenCalledWith('org1', 'o1');
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('the new answers reach the agent: a missing id is "not found", an invalid category is an error before any write', async () => {
    mockDeleteAccount.mockResolvedValue(false);
    expect(await run('delete_memory', { memoryId: 'gone' })).toEqual({ success: false, message: 'Memory gone was not found; nothing was deleted.' });
    await expect(run('save_memory', { content: 'x', category: 'nope' })).rejects.toThrow('Invalid category: nope');
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('all four still need an identity', async () => {
    for (const [name, args] of [['save_memory', { content: 'x', category: 'insight' }], ['delete_memory', { memoryId: 'm' }], ['save_org_memory', { content: 'x', category: 'insight' }], ['delete_org_memory', { memoryId: 'm' }]] as const) {
      await expect(run(name, args, {})).rejects.toThrow('Authentication required');
    }
  });
});
