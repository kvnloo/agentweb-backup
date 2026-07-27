import '../emma/tools';
import { mcpToolRegistry } from '../mcp/server/registry';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { userDb } from '../services/db';
import * as governanceLabelService from '../services/linearGovernanceLabelService';

describe('manage_linear_governance_label exposure', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is exposed through the external MCP registry', () => {
    expect(mcpToolRegistry.getTool('manage_linear_governance_label')).toBeDefined();
    expect(mcpToolRegistry.getToolDefinitions().map(definition => definition.name))
      .toContain('manage_linear_governance_label');
  });

  it('is classified as an admin-only Emma tool', () => {
    expect(agentModeService.getAdminToolNames()).toContain('manage_linear_governance_label');
  });

  it('does not expose create, delete, workspace, team, or credentials arguments', () => {
    const schema = mcpToolRegistry.getTool('manage_linear_governance_label')!
      .definition.inputSchema as any;
    expect(schema.required).toEqual(['label_name', 'reason']);
    expect(Object.keys(schema.properties)).toEqual([
      'label_name',
      'name',
      'description',
      'color',
      'reason',
      'dry_run',
    ]);
  });

  it('attributes delegated Agent Mode calls to the admin stored on the session', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({
      userId: 'customer-1',
      email: 'customer@example.com',
      isAdmin: false,
    } as any);
    const sessionLookup = jest.spyOn(chatbotDb, 'getChatSession').mockResolvedValue({
      sessionId: 'session-1',
      delegateInfo: {
        isDelegated: true,
        adminUserId: 'admin-1',
        adminEmail: 'admin@example.com',
      },
    } as any);
    const manage = jest.spyOn(governanceLabelService, 'manageLinearGovernanceLabel')
      .mockResolvedValue({ verified: true } as any);

    await mcpToolRegistry.getTool('manage_linear_governance_label')!.execute(
      { label_name: 'Route: Emma', reason: 'Keep routing accurate', dry_run: true },
      { userId: 'customer-1', sessionId: 'session-1', isDelegatedAccess: true },
    );

    expect(sessionLookup).toHaveBeenCalledWith('session-1');
    expect(manage).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'admin@example.com',
    }));
  });

  it('fails closed when delegated Agent Mode context has no session identity', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({
      userId: 'customer-1',
      email: 'customer@example.com',
      isAdmin: false,
    } as any);
    const manage = jest.spyOn(governanceLabelService, 'manageLinearGovernanceLabel')
      .mockResolvedValue({ verified: true } as any);

    await expect(mcpToolRegistry.getTool('manage_linear_governance_label')!.execute(
      { label_name: 'Route: Emma', reason: 'Keep routing accurate', dry_run: true },
      { userId: 'customer-1', isDelegatedAccess: true },
    )).rejects.toThrow('Delegated administrator identity unavailable');
    expect(manage).not.toHaveBeenCalled();
  });

  it('fails closed when a delegated session lacks administrator attribution', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({
      userId: 'customer-1',
      email: 'customer@example.com',
      isAdmin: false,
    } as any);
    jest.spyOn(chatbotDb, 'getChatSession').mockResolvedValue({
      sessionId: 'session-1',
      delegateInfo: { isDelegated: true },
    } as any);
    const manage = jest.spyOn(governanceLabelService, 'manageLinearGovernanceLabel')
      .mockResolvedValue({ verified: true } as any);

    await expect(mcpToolRegistry.getTool('manage_linear_governance_label')!.execute(
      { label_name: 'Route: Emma', reason: 'Keep routing accurate', dry_run: true },
      { userId: 'customer-1', sessionId: 'session-1', isDelegatedAccess: true },
    )).rejects.toThrow('Delegated administrator identity unavailable');
    expect(manage).not.toHaveBeenCalled();
  });

  it('attributes direct administrator calls to the authenticated admin', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({
      userId: 'admin-1',
      email: 'admin@example.com',
      isAdmin: true,
    } as any);
    const manage = jest.spyOn(governanceLabelService, 'manageLinearGovernanceLabel')
      .mockResolvedValue({ verified: true } as any);

    await mcpToolRegistry.getTool('manage_linear_governance_label')!.execute(
      { label_name: 'Route: Emma', reason: 'Keep routing accurate', dry_run: true },
      { userId: 'admin-1' },
    );

    expect(manage).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'admin@example.com',
    }));
  });
});
