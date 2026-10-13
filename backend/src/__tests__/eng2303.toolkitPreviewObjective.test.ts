/**
 * ENG-2303 P3: the Meta Toolkit preview (AgentModeService.previewToolkitMetaWrite) runs the
 * shared write gate sessionless. It must never auto-provision an Emma chat session, never
 * dispatch, and must require an explicit, valid objective for CAMPAIGN CREATE (shown in the
 * bound preview the user approves) instead of the Emma transcript/deck objective gate.
 */
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));
jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return { ...actual, metaService: { createCampaign: jest.fn() } };
});
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token') }));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    getChatSession: jest.fn().mockResolvedValue(null),
    updateSessionObjectiveConfirmation: jest.fn(),
    createChatSession: jest.fn().mockResolvedValue({ sessionId: 'auto-created-session' }),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { chatbotDb } from '../services/chatbotService';

describe('ENG-2303 toolkit preview: sessionless, objective explicit', () => {
  let service: AgentModeService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: '111', accessToken: 'tok', connection: { config: {} } });
    jest.spyOn(service as any, 'buildMetaWriteConfirmation').mockResolvedValue({ summary: 'Create campaign "Phoenix" in act_111', target: { account_id: '111' }, tenancyRefused: false });
    jest.spyOn(service as any, 'resolveMetaWriteManifestDigest').mockResolvedValue('digest');
    jest.spyOn(service as any, 'claimMetaWriteManifestGrant').mockResolvedValue({ granted: true, digest: 'x' });
  });

  const params = (extra: any = {}) => ({ name: 'Phoenix', special_ad_categories: ['NONE'], status: 'PAUSED', ...extra });

  it('with an explicit objective: halts with a preview + dispatch payload, no session, no create, no grant claim', async () => {
    const res: any = await service.previewToolkitMetaWrite('user123', 'CAMPAIGN', 'CREATE', '111', undefined, undefined, undefined, params({ objective: 'OUTCOME_LEADS' }));
    expect(res.awaitingUserConfirmation).toBe(true);
    expect(res.metaWriteDispatch).toMatchObject({ entity_type: 'CAMPAIGN', action: 'CREATE', params: expect.objectContaining({ objective: 'OUTCOME_LEADS', status: 'PAUSED' }) });
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(metaService.createCampaign).not.toHaveBeenCalled();
    expect((service as any).claimMetaWriteManifestGrant).not.toHaveBeenCalled();
  });

  it.each([undefined, 'OUTCOME_WHATEVER'])('missing/invalid objective (%p) is a validation error, never a session', async (objective) => {
    const res: any = await service.previewToolkitMetaWrite('user123', 'CAMPAIGN', 'CREATE', '111', undefined, undefined, undefined, params({ objective }));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^PARAM_VALIDATION_ERROR: CAMPAIGN CREATE needs an explicit objective/);
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(metaService.createCampaign).not.toHaveBeenCalled();
  });
});
