import { agentModeController } from '../controllers/agentModeController';

/**
 * ENG-9 — adminOnly must be enforced at the POINT OF USE, not just filtered from
 * the model picker. Model ids arrive straight in request bodies, so the
 * getSupportedModels() adminOnly filter alone is only a display filter.
 *
 * Behavioral contract:
 * 1. A non-admin setting a session model to an adminOnly registry model (e.g. an
 *    OpenRouter slug during staged rollout) gets 403 — before any DB access.
 * 2. A shared-link (unauthenticated) visitor can never set an adminOnly model.
 * 3. Non-restricted models pass the gate (request proceeds to normal handling).
 * 4. The pre-existing opus substring block is preserved unchanged.
 */

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn().mockResolvedValue(null), // gate-passing requests reach the DB → 404
    updateSessionLlmModel: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
  getEmmaSystemContext: jest.fn(),
}));

function fakeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('AgentModeController — adminOnly model gate at point of use (ENG-9)', () => {
  const OPENROUTER_SLUG = 'openai/gpt-5.5'; // adminOnly, does NOT contain "opus"

  describe('updateSessionLlmModel (authenticated)', () => {
    it('403s a non-admin setting an adminOnly OpenRouter slug (no opus substring)', async () => {
      const req: any = {
        params: { sessionId: 's1' },
        body: { llmModel: OPENROUTER_SLUG },
        user: { userId: 'u1', isAdmin: false },
      };
      const res = fakeRes();

      await agentModeController.updateSessionLlmModel(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      const { chatbotDb } = require('../services/chatbotService');
      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    });

    it('lets an admin set an adminOnly OpenRouter slug (passes gate, reaches DB)', async () => {
      const req: any = {
        params: { sessionId: 's1' },
        body: { llmModel: OPENROUTER_SLUG },
        user: { userId: 'u1', isAdmin: true },
      };
      const res = fakeRes();

      await agentModeController.updateSessionLlmModel(req, res);

      // DB mock returns null → 404 proves the request got PAST the gate.
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('lets a non-admin set a non-restricted model (passes gate, reaches DB)', async () => {
      const req: any = {
        params: { sessionId: 's1' },
        body: { llmModel: 'anthropic.claude-sonnet-4-6' },
        user: { userId: 'u1', isAdmin: false },
      };
      const res = fakeRes();

      await agentModeController.updateSessionLlmModel(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('preserves the pre-existing opus substring block for non-admins', async () => {
      const req: any = {
        params: { sessionId: 's1' },
        body: { llmModel: 'anthropic.claude-opus-4-8' },
        user: { userId: 'u1', isAdmin: false },
      };
      const res = fakeRes();

      await agentModeController.updateSessionLlmModel(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('updateSharedSessionLlmModel (unauthenticated shared link)', () => {
    it('403s an adminOnly OpenRouter slug from a shared-link visitor', async () => {
      const req: any = {
        params: { shareId: 'share1' },
        query: { conversable: 'token' },
        body: { llmModel: OPENROUTER_SLUG },
      };
      const res = fakeRes();

      await agentModeController.updateSharedSessionLlmModel(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      const { chatbotDb } = require('../services/chatbotService');
      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    });

    it('lets a non-restricted model through the gate (reaches DB)', async () => {
      const req: any = {
        params: { shareId: 'share1' },
        query: { conversable: 'token' },
        body: { llmModel: 'gemini-3.5-flash' },
      };
      const res = fakeRes();

      await agentModeController.updateSharedSessionLlmModel(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
