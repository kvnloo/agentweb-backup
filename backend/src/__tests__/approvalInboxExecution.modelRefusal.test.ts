/**
 * ENG-669: an approval-inbox resume refused because the session's model is outside the owner's plan leaves the
 * refusal in the chat AND pushes it live (session-message-appended), exactly like a successful resume pushes its
 * reply, so an open chat shows it without a reload. The refusal is recorded ONCE (recordModelRefusal reuses the one
 * generateSessionResponse may already have saved; its real behaviour is covered in
 * agentModeController.modelProvenance.test.ts) and the emit carries its messageIndex and error flag. A failure to save
 * never emits; a failure to emit never throws; any other refusal (the tier allowlist is off) adds nothing new.
 */
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock('../server', () => ({ io: { to: (...a: unknown[]) => mockTo(...(a as [])) } }));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSessionRecord: jest.fn(), addMessageToSession: jest.fn() },
}));
jest.mock('../services/approvalInboxService', () => ({ approvalInboxService: {} }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { getDefaultModel: jest.fn(async () => 'default-model') },
}));
jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
  tryClaimSessionGeneration: jest.fn(() => true),
  releaseSessionGeneration: jest.fn(),
  recordModelRefusal: jest.fn(),
}));

import { resumeOriginSession } from '../services/approvalInboxExecution';
import { chatbotDb } from '../services/chatbotService';
import { generateSessionResponse, recordModelRefusal, releaseSessionGeneration } from '../controllers/agentModeController';
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';

const mockDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockRecord = recordModelRefusal as jest.Mock;
const REFUSAL = "The model you selected (gpt-5.5) isn't included in your plan, so nothing was sent to a different model. Choose another model, or upgrade your plan to use this one.";
const refused = new ModelUnavailableError('gpt-5.5', 'not_in_plan', { model: 'gpt-5.5', tier: 'Free', allowedModels: [], upgradeRequired: ['Pro'] });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (mockDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId: 's1', userId: 'owner-1', llmModel: 'gpt-5.5' });
  (mockDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
  (generateSessionResponse as jest.Mock).mockRejectedValue(refused);
  mockRecord.mockResolvedValue({ content: REFUSAL, messageIndex: 12 });
});
afterEach(() => jest.restoreAllMocks());

it('records the refusal once and pushes it live to the owner with its messageIndex and error flag', async () => {
  await resumeOriginSession('s1', 'Approved: send the email');
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect(mockRecord).toHaveBeenCalledWith('s1', refused);
  // Nothing else in the resume saves an assistant message (only the passive model-only note).
  expect((mockDb.addMessageToSession as jest.Mock).mock.calls.filter(([, m]) => m.role === 'assistant')).toHaveLength(0);
  expect(mockTo).toHaveBeenCalledWith('user:owner-1');
  expect(mockEmit).toHaveBeenCalledTimes(1);
  expect(mockEmit).toHaveBeenCalledWith('session-message-appended', {
    sessionId: 's1', message: { role: 'assistant', content: REFUSAL, messageIndex: 12, metadata: { isErrorMessage: true } },
  });
  expect(releaseSessionGeneration).toHaveBeenCalledWith('s1');
});

it('does not emit a refusal that could not be saved, and never throws', async () => {
  mockRecord.mockResolvedValue(undefined);
  await expect(resumeOriginSession('s1', 'Approved')).resolves.toBeUndefined();
  expect(mockEmit).not.toHaveBeenCalled();
});

it('a failed emit never throws', async () => {
  mockTo.mockImplementationOnce(() => { throw new Error('socket down'); });
  await expect(resumeOriginSession('s1', 'Approved')).resolves.toBeUndefined();
});

it('any other model refusal (all a switched-off allowlist can produce) records and emits nothing new', async () => {
  (generateSessionResponse as jest.Mock).mockRejectedValue(new ModelUnavailableError('retired-9', 'not_served'));
  await resumeOriginSession('s1', 'Approved');
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockEmit).not.toHaveBeenCalled();
});
