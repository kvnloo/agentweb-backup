import { Request, Response } from 'express';

// ENG-892: the model picker stored whatever string the client sent. That is how
// `claude-sonnet-4-5` — a model that is not in the registry at all — ended up on
// real sessions and got booked as a line item in the daily cost report. The
// picker must only be able to persist a model that generation would actually
// accept, and it must persist it in its canonical form so the stored value is
// comparable to the per-message `llm` provenance.

const REGISTRY = [
  'gpt-5-chat-2',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'gemini-3.5-flash',
];
const ALIASES: Record<string, string> = {
  'claude-opus-4-8': 'anthropic.claude-opus-4-8',
};
const FALLBACK = 'gpt-5-chat-2';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    // Mirrors the real resolver: normalize legacy aliases, then validate against
    // the allow-list with an own-property check.
    resolveGenerationModel: jest.fn((model: string) => {
      const normalized = ALIASES[model] ?? model;
      if (normalized && REGISTRY.includes(normalized)) {
        return { model: normalized, fellBack: false, requestedModel: model };
      }
      return { model: FALLBACK, fellBack: true, requestedModel: model };
    }),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  },
}));

import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

const makeRes = () =>
  ({
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response);

describe('AgentModeController - llmModel picker validation (ENG-892)', () => {
  const ownerId = 'user-1';
  const sessionId = 'session-1';

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.getChatSession.mockResolvedValue({
      sessionId,
      userId: ownerId,
    } as any);
    mockChatbotDb.updateSessionLlmModel.mockImplementation(
      async (_id: string, llmModel: string) => ({ sessionId, llmModel } as any)
    );
  });

  const patch = (body: any, user: any = { userId: ownerId, isAdmin: false }) =>
    ({ params: { sessionId }, body, user } as unknown as Request);

  describe('updateSessionLlmModel', () => {
    it('rejects a model that is not in the registry instead of storing it', async () => {
      const res = makeRes();
      // The exact value observed on 6 real sessions in the measured window.
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'claude-sonnet-4-5' }) as any,
        res
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('rejects an inherited Object.prototype key masquerading as a model', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'constructor' }) as any,
        res
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('still rejects a missing llmModel', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(patch({}) as any, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('stores a valid registry model', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'gemini-3.5-flash' }) as any,
        res
      );

      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        sessionId,
        'gemini-3.5-flash'
      );
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('stores the canonical id for a legacy alias, not the alias itself', async () => {
      const res = makeRes();
      // Storing the raw alias would make llmModel differ from the per-message
      // `llm` (which records the resolved id) and fabricate a false mismatch.
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'claude-opus-4-8' }, { userId: ownerId, isAdmin: true }) as any,
        res
      );

      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        sessionId,
        'anthropic.claude-opus-4-8'
      );
    });

    it('still blocks opus for non-admins, evaluated on the canonical id', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'claude-opus-4-8' }) as any,
        res
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('still enforces session ownership', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'gemini-3.5-flash' }, { userId: 'someone-else', isAdmin: false }) as any,
        res
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });
  });

  describe('updateSharedSessionLlmModel', () => {
    it('rejects an unregistered model before touching the shared session', async () => {
      const res = makeRes();
      const req = {
        params: { shareId: sessionId },
        query: { conversable: 'token-1' },
        body: { llmModel: 'claude-sonnet-4-5' },
      } as unknown as Request;

      await agentModeController.updateSharedSessionLlmModel(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });
  });
});
