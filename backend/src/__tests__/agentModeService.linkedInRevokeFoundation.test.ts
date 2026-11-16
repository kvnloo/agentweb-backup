import { AgentModeService } from '../services/agentModeService';

describe('LinkedIn Outreach inspect/revoke foundation access (ENG-1153)', () => {
  const tools = ['inspect_linkedin_account', 'revoke_linkedin_account'];

  it('offers both tools to every authenticated Emma chat session', () => {
    for (const t of tools) expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain(t);
  });

  it('cannot be stripped by a stale foundation-tools database override', () => {
    const mandatory = (AgentModeService as any).MANDATORY_FOUNDATION_TOOLS as string[];
    for (const t of tools) expect(mandatory).toContain(t);
  });
});
