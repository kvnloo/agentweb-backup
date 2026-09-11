import { mcpToolRegistry } from '../mcp/server/registry';
import { emmaToolRegistry } from '../emma/registry';
import { evaluationStore } from '../services/evaluationStore';
import { userDb } from '../services/db';
import { runEvaluation } from '../services/evaluationService';
import '../mcp/server/evaluationTools';

jest.mock('../services/evaluationStore', () => ({ evaluationStore: {
  get: jest.fn(), provision: jest.fn(), revoke: jest.fn(), saveArtifact: jest.fn(), simulate: jest.fn(), review: jest.fn(),
} }));
jest.mock('../services/db', () => ({ userDb: { getUserByIdConsistent: jest.fn() } }));
jest.mock('../services/evaluationService', () => ({ runEvaluation: jest.fn() }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));

describe('ENG-1870 Emma-operable lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({ userId: 'admin', isAdmin: true, isActive: true });
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'active', expiresAt: Date.now() + 60000, materials: [] });
    (evaluationStore.provision as jest.Mock).mockResolvedValue({ userId: 'eval_new', audit: { action: 'provision' } });
    (evaluationStore.revoke as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked', audit: { action: 'revoke' } });
    (runEvaluation as jest.Mock).mockResolvedValue({ text: 'Synthetic strategy' });
  });
  it.each([['MCP', mcpToolRegistry], ['Emma', emmaToolRegistry]] as const)('%s exposes admin provision and audited revoke', async (_name, registry) => {
    await registry.execute('evaluation_workspace', { action: 'provision', provision: { displayName: 'Synthetic' } }, { userId: 'admin' });
    expect(evaluationStore.provision).toHaveBeenCalledWith('admin', { displayName: 'Synthetic' });
    const result = await registry.execute('evaluation_workspace', { action: 'revoke', evaluation_user_id: 'eval_test' }, { userId: 'admin' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'revoked', audit: { action: 'revoke' } });
  });
  it('evaluation analysis runs only for its authenticated identity', async () => {
    await emmaToolRegistry.execute('evaluation_workspace', { action: 'analyze', prompt: 'Synthetic case' }, { userId: 'eval_test' });
    expect(runEvaluation).toHaveBeenCalledWith('eval_test', { action: 'analyze', prompt: 'Synthetic case' });
  });
  it.each([{ action: 'provision', provision: {} }, { action: 'revoke', evaluation_user_id: 'other' }, { action: 'analyze', userId: 'other', prompt: 'case' }])('evaluation cannot elevate with %p', async args => {
    await expect(emmaToolRegistry.execute('evaluation_workspace', args, { userId: 'eval_test' })).rejects.toThrow();
    expect(evaluationStore.provision).not.toHaveBeenCalled();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
    expect(runEvaluation).not.toHaveBeenCalled();
  });
  it.each([{ externalMcp: true }, { isInternal: true }])('transport without delegation provenance cannot mutate lifecycle: %p', async flags => {
    await expect(mcpToolRegistry.execute('evaluation_workspace', { action: 'revoke', evaluation_user_id: 'eval_test' }, { userId: 'admin', ...flags })).rejects.toThrow();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
  });
  it('wrong-type admin flags cannot authorize lifecycle mutations', async () => {
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({ userId: 'admin', isAdmin: 'false', isActive: true });
    await expect(emmaToolRegistry.execute('evaluation_workspace', { action: 'revoke', evaluation_user_id: 'eval_test' }, { userId: 'admin' })).rejects.toThrow();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
  });
  it('delegated staff cannot operate lifecycle controls', async () => {
    await expect(emmaToolRegistry.execute('evaluation_workspace', { action: 'revoke', evaluation_user_id: 'eval_test' }, { userId: 'admin', delegateInfo: { isDelegated: true } })).rejects.toThrow();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
  });
  it.each([['Emma', emmaToolRegistry], ['MCP', mcpToolRegistry]] as const)('%s runs simulator commands through the evaluation boundary', async (_name, registry) => {
    (evaluationStore.simulate as jest.Mock).mockResolvedValue({ ok: true, disclosure: 'Simulation complete — not sent to Meta' });
    const command = { operation: 'create', kind: 'campaign', fields: { name: 'Proposal', objective: 'LEADS' } };
    const response = await registry.execute('evaluation_workspace', { action: 'simulate', command }, { userId: 'eval_test' });
    expect(evaluationStore.simulate).toHaveBeenCalledWith('eval_test', command);
    expect(JSON.parse(response.content[0].text).disclosure).toBe('Simulation complete — not sent to Meta');
    expect(runEvaluation).not.toHaveBeenCalled();
  });
  it('Emma exposes explicit review access without using an org or production tool', async () => {
    (evaluationStore.review as jest.Mock).mockResolvedValue({ userId: 'eval_test', audit: [] });
    await emmaToolRegistry.execute('evaluation_workspace', { action: 'review', evaluation_user_id: 'eval_test' }, { userId: 'admin' });
    expect(evaluationStore.review).toHaveBeenCalledWith('admin', 'eval_test');
  });

  it('Emma candidate inspect exposes a safe view without review assignments', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'active', expiresAt: Date.now()+60000, provisionedBy: 'private-admin', reviewerUserIds: ['private-reviewer'], simulation: { seed: [], objects: [] }, materials: [] });
    const result = await emmaToolRegistry.execute('evaluation_workspace', { action: 'inspect' }, { userId: 'eval_test' });
    const view = JSON.parse(result.content[0].text);
    expect(view.reviewerUserIds).toBeUndefined(); expect(view.provisionedBy).toBeUndefined(); expect(view.simulation.seed).toBeUndefined();
  });

});
