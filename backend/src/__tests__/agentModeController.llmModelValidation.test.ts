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
  'openrouter/example/admin-only-model',
  'internal-model',
  'admin-only-model',
];
const ALIASES: Record<string, string> = {
  'claude-opus-4-8': 'anthropic.claude-opus-4-8',
};
const FALLBACK = 'gpt-5-chat-2';
const ADMIN_ONLY = new Set(['openrouter/example/admin-only-model', 'admin-only-model']);
const INTERNAL_ONLY = new Set(['internal-model', 'live-model']);

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
    // ENG-2293: mirrors the real gate the controller now delegates to instead
    // of re-deriving a subset inline (allow-list membership was already
    // covered above; this adds adminOnly + internal/live; no model-name check).
    isModelSelectableBy: jest.fn((modelId: string, isAdmin: boolean) => {
      if (!REGISTRY.includes(modelId) || INTERNAL_ONLY.has(modelId)) return false;
      if (ADMIN_ONLY.has(modelId) && !isAdmin) return false;
      return true;
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
        'gemini-3.5-flash', undefined, 'user',
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
        'anthropic.claude-opus-4-8', undefined, 'user',
      );
    });

    // ENG-2028: flipped from 'still blocks opus for non-admins'. The name-based
    // Opus deny is gone; only registry adminOnly/internalOnly flags gate selection.
    it('allows opus for non-admins, evaluated on the canonical id', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'claude-opus-4-8' }) as any,
        res
      );

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(sessionId, 'anthropic.claude-opus-4-8', undefined, 'user');
    });

    it('still refuses registry-restricted models (internalOnly; adminOnly for non-admins)', async () => {
      for (const [model, admin, allowed] of [
        ['internal-model', false, false],
        ['internal-model', true, false],
        ['admin-only-model', false, false],
        ['admin-only-model', true, true],
      ] as const) {
        jest.clearAllMocks();
        const res = makeRes();
        await agentModeController.updateSessionLlmModel(
          patch({ llmModel: model }, { userId: ownerId, isAdmin: admin }) as any,
          res
        );
        if (allowed) {
          expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(sessionId, model, undefined, 'user');
        } else {
          expect(res.status).toHaveBeenCalledWith(403);
          expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
        }
      }
    });

    it('blocks an adminOnly model for non-admins even though it is a registered id (ENG-2293)', async () => {
      // Before this fix, only the opus-substring check ran here, so a
      // non-admin who named an adminOnly auto-added model directly (not
      // through the picker, which already hides it) still got a 200.
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'openrouter/example/admin-only-model' }) as any,
        res
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('allows an adminOnly model for admins', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel(
        patch({ llmModel: 'openrouter/example/admin-only-model' }, { userId: ownerId, isAdmin: true }) as any,
        res
      );

      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        sessionId,
        'openrouter/example/admin-only-model', undefined, 'user',
      );
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

    it('allows opus for shared viewers but refuses admin-only/internal models', async () => {
      const call = async (llmModel: string) => {
        jest.clearAllMocks();
        const res = makeRes();
        mockChatbotDb.getChatSession.mockResolvedValue({ sessionId, interactiveShareMetadata: { isActive: true, token: 'token-1', createdAt: new Date() } } as any);
        await agentModeController.updateSharedSessionLlmModel(
          { params: { shareId: sessionId }, query: { conversable: 'token-1' }, body: { llmModel } } as unknown as Request,
          res
        );
        return res;
      };
      const ok = await call('anthropic.claude-opus-5');
      expect(ok.status).not.toHaveBeenCalledWith(403);
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(sessionId, 'anthropic.claude-opus-5', undefined, 'user');
      for (const m of ['internal-model', 'admin-only-model']) {
        const r = await call(m);
        expect(r.status).toHaveBeenCalledWith(403);
        expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
      }
    });
  });
});
