import { AgentModeService } from '../services/agentModeService';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

// ENG-673: Emma can do whatever the CRM dialog can do with a Smartlead push, so every tool must be offered in a chat, and none of them may be
// reachable from a share-link visitor (who runs as the owner's userId).
describe('Smartlead push tools: foundation access (ENG-673)', () => {
  const tools = [
    'list_smartlead_campaigns', 'get_smartlead_campaign_stats', 'preview_smartlead_push', 'start_smartlead_push', 'get_smartlead_push_status',
    'pause_smartlead_push', 'resume_smartlead_push', 'cancel_smartlead_push', 'release_leads_from_smartlead',
  ];

  it('offers every tool to authenticated Emma chat sessions', () => {
    for (const t of tools) expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain(t);
  });

  it('keeps every tool away from share-link visitors', () => {
    for (const t of tools) expect(SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS.has(t)).toBe(true);
  });
});
