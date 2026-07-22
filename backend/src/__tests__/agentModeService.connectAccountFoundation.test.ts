import { AgentModeService } from '../services/agentModeService';

describe('connect_account foundation access', () => {
  it('offers the connection handoff to every authenticated Emma session', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('connect_account');
  });

  it('cannot be stripped by a stale foundation-tools database override', () => {
    const mandatory = (AgentModeService as any).MANDATORY_FOUNDATION_TOOLS as string[];

    expect(mandatory).toContain('connect_account');
  });
});
