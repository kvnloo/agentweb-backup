import { mcpToolRegistry } from '../mcp/server/registry';
import { emmaToolRegistry } from '../emma/registry';
import { evaluationStore } from '../services/evaluationStore';
import { userDb } from '../services/db';
import { runEvaluation } from '../services/evaluationService';
import '../mcp/server/evaluationTools';

jest.mock('../services/evaluationStore', () => ({ evaluationStore: {
  get: jest.fn(), provision: jest.fn(), revoke: jest.fn(), saveArtifact: jest.fn(),
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
  it('delegated staff cannot operate lifecycle controls', async () => {
    await expect(emmaToolRegistry.execute('evaluation_workspace', { action: 'revoke', evaluation_user_id: 'eval_test' }, { userId: 'admin', delegateInfo: { isDelegated: true } })).rejects.toThrow();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
  });
});
