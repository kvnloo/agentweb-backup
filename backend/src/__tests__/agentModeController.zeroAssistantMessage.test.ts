// ENG-826: a zero-output scheduled run must explain its failure honestly. A
// deterministic provider/validation error (e.g. the gemini-3.5-flash union-schema
// 400) must NOT be reported with the "split into smaller batches" budget advice —
// that mislabels the transcript and sends debuggers down the wrong path. Only
// genuine budget/size-shaped failures keep the original guidance.

// Mock dependencies so the controller module imports cleanly (mirrors the
// calculateNextRunTime test setup).
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getMarketingSystemPrompt: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
  },
}));

// Import after mocks
import { zeroAssistantIncompleteMessage } from '../controllers/agentModeController';

// The two distinct messages are private; assert on stable substrings instead.
const BUDGET_MARKER = 'split the request into smaller batches';
const SYSTEM_MARKER = 'not a time or size limit';

const isBudgetMessage = (m: string) => m.includes(BUDGET_MARKER);
const isSystemMessage = (m: string) => m.includes(SYSTEM_MARKER);

describe('zeroAssistantIncompleteMessage classification', () => {
  describe('budget/size-shaped failures keep the "split into smaller batches" guidance', () => {
    it('classifies a context-limit error as budget', () => {
      const err = new Error("Request exceeds the model's maximum context length");
      const msg = zeroAssistantIncompleteMessage(err);
      expect(isBudgetMessage(msg)).toBe(true);
      expect(isSystemMessage(msg)).toBe(false);
    });

    it('classifies a worker-shutdown / OOM replacement as budget', () => {
      expect(isBudgetMessage(zeroAssistantIncompleteMessage(new Error('Worker shutdown')))).toBe(true);
      expect(
        isBudgetMessage(zeroAssistantIncompleteMessage(new Error('Worker process exited with code 137'))),
      ).toBe(true);
    });

    it('classifies a zero-assistant-output run (ran but emitted nothing) as budget', () => {
      const msg = zeroAssistantIncompleteMessage({ code: 'ZERO_ASSISTANT_OUTPUT' });
      expect(isBudgetMessage(msg)).toBe(true);
    });

    it('classifies a generation-timeout as budget', () => {
      const err = Object.assign(new Error('generation timed out'), { isGenerationTimeout: true });
      expect(isBudgetMessage(zeroAssistantIncompleteMessage(err))).toBe(true);
    });
  });

  describe('deterministic system/provider failures get the honest system-error message', () => {
    it('classifies the gemini-3.5-flash union-schema 400 (generic user message) as system, NOT budget', () => {
      // This is exactly the message stored on the ENG-826 failing sessions.
      const err = new Error(
        'I encountered an issue processing your request. Please try rephrasing your question.',
      );
      const msg = zeroAssistantIncompleteMessage(err);
      expect(isSystemMessage(msg)).toBe(true);
      expect(isBudgetMessage(msg)).toBe(false);
      // The misleading budget cause must be absent.
      expect(msg).not.toContain('time or memory budget');
    });

    it('does not mistake a schema-validation 400 (in originalMessage) for a context-limit error', () => {
      const err = Object.assign(new Error('generic wrapper'), {
        originalMessage:
          "Invalid JSON payload received. Unknown name \"type\": Proto field is not repeating, cannot start list.",
      });
      expect(isSystemMessage(zeroAssistantIncompleteMessage(err))).toBe(true);
    });

    it('classifies an auth failure as system', () => {
      expect(isSystemMessage(zeroAssistantIncompleteMessage(new Error('401 Unauthorized')))).toBe(true);
    });

    it('falls back to the system message for a null/undefined error', () => {
      expect(isSystemMessage(zeroAssistantIncompleteMessage(null))).toBe(true);
      expect(isSystemMessage(zeroAssistantIncompleteMessage(undefined))).toBe(true);
    });
  });
});
