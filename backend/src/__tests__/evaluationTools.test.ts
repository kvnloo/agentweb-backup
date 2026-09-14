import { mcpToolRegistry } from '../mcp/server/registry';
import { emmaToolRegistry } from '../emma/registry';
import { evaluationStore } from '../services/evaluationStore';
import { userDb } from '../services/db';
import '../mcp/server/evaluationTools';

jest.mock('../services/evaluationStore', () => ({ evaluationStore: {
  get: jest.fn(), provision: jest.fn(), revoke: jest.fn(), review: jest.fn(),
} }));
jest.mock('../services/db', () => ({ userDb: { getUserByIdConsistent: jest.fn() } }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));

const provision = { email: 'candidate@example.invalid', displayName: 'Synthetic', password: 'Synthetic-password-123!', expiresAt: Date.now() + 3600000, brandGuidelines: { brandName: 'Synthetic Co' } };

describe('ENG-1907 sandbox lifecycle tool (admin-only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({ userId: 'admin', isAdmin: true, isActive: true });
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'active', expiresAt: Date.now() + 60000 });
    (evaluationStore.provision as jest.Mock).mockResolvedValue({ userId: 'eval_new', audit: { action: 'provision' } });
    (evaluationStore.revoke as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked', audit: { action: 'revoke' } });
  });
  it.each([['MCP', mcpToolRegistry], ['Emma', emmaToolRegistry]] as const)('%s exposes admin provision and audited revoke', async (_name, registry) => {
    await registry.execute('evaluation_workspace', { action: 'provision', provision }, { userId: 'admin' });
    expect(evaluationStore.provision).toHaveBeenCalledWith('admin', provision);
    const result = await registry.execute('evaluation_workspace', { action: 'revoke', evaluation_user_id: 'eval_test' }, { userId: 'admin' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'revoked', audit: { action: 'revoke' } });
  });
  it('the tool describes the sandbox lifecycle, not a candidate workspace', () => {
    const description = mcpToolRegistry.getTool('evaluation_workspace')!.definition.description as string;
    expect(description.toLowerCase()).toContain('sandbox');
    expect(description).not.toContain('Simulation complete');
    expect(mcpToolRegistry.getTool('evaluation_workspace')!.definition.inputSchema.properties.action.enum).toEqual(['provision', 'revoke', 'review']);
  });
  it.each([
    { action: 'provision', provision }, { action: 'revoke', evaluation_user_id: 'other' }, { action: 'review', evaluation_user_id: 'eval_test' },
    { action: 'inspect' }, { action: 'simulate', command: { operation: 'query' } }, { action: 'analyze', prompt: 'case' },
  ])('a sandbox principal is denied %p by the lifecycle class in both registries', async args => {
    await expect(emmaToolRegistry.execute('evaluation_workspace', args, { userId: 'eval_test' })).rejects.toThrow();
    await expect(mcpToolRegistry.execute('evaluation_workspace', args, { userId: 'eval_test', externalMcp: true })).rejects.toThrow();
    expect(evaluationStore.provision).not.toHaveBeenCalled();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
    expect(evaluationStore.review).not.toHaveBeenCalled();
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
  it('a non-admin customer cannot provision or revoke', async () => {
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({ userId: 'customer', isAdmin: false, isActive: true });
    await expect(emmaToolRegistry.execute('evaluation_workspace', { action: 'provision', provision }, { userId: 'customer' })).rejects.toThrow();
    await expect(emmaToolRegistry.execute('evaluation_workspace', { action: 'revoke', evaluation_user_id: 'eval_test' }, { userId: 'customer' })).rejects.toThrow();
    expect(evaluationStore.provision).not.toHaveBeenCalled();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
  });
  it('Emma exposes explicit review access without using an org or production tool', async () => {
    (evaluationStore.review as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'active', audit: [], truncated: false });
    const result = await emmaToolRegistry.execute('evaluation_workspace', { action: 'review', evaluation_user_id: 'eval_test' }, { userId: 'admin' });
    expect(evaluationStore.review).toHaveBeenCalledWith('admin', 'eval_test');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ userId: 'eval_test', audit: [] });
  });
  it('review rejects unknown arguments before reading anything', async () => {
    await expect(emmaToolRegistry.execute('evaluation_workspace', { action: 'review', evaluation_user_id: 'eval_test', artifact_id: 'x' }, { userId: 'admin' })).rejects.toThrow();
    expect(evaluationStore.review).not.toHaveBeenCalled();
  });
  it('unknown actions are refused', async () => {
    await expect(emmaToolRegistry.execute('evaluation_workspace', { action: 'reset' }, { userId: 'admin' })).rejects.toThrow();
  });
});
