/**
 * ENG-669: an approval-inbox resume refused because the session's model is outside the owner's plan leaves the
 * refusal in the chat AND pushes it live (session-message-appended), exactly like a successful resume pushes its
 * reply, so an open chat shows it without a reload. A failure to save never emits; a failure to emit never throws.
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
  modelUnavailableBody: (e: any) => jest.requireActual('../services/agentMode/modelUnavailable').buildModelUnavailableBody(e),
}));

import { resumeOriginSession } from '../services/approvalInboxExecution';
import { chatbotDb } from '../services/chatbotService';
import { generateSessionResponse, releaseSessionGeneration } from '../controllers/agentModeController';
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';

const mockDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const REFUSAL = "The model you selected (gpt-5.5) isn't included in your plan, so nothing was sent to a different model. Choose another model, or upgrade your plan to use this one.";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (mockDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId: 's1', userId: 'owner-1', llmModel: 'gpt-5.5' });
  (mockDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
  (generateSessionResponse as jest.Mock).mockRejectedValue(new ModelUnavailableError('gpt-5.5', 'not_in_plan', {
    model: 'gpt-5.5', tier: 'Free', allowedModels: [], upgradeRequired: ['Pro'],
  }));
});
afterEach(() => jest.restoreAllMocks());

it('saves the refusal and pushes it live to the owner', async () => {
  await resumeOriginSession('s1', 'Approved: send the email');
  expect(mockDb.addMessageToSession).toHaveBeenCalledWith('s1', expect.objectContaining({
    role: 'assistant', content: REFUSAL, metadata: expect.objectContaining({ isErrorMessage: true }),
  }));
  expect(mockTo).toHaveBeenCalledWith('user:owner-1');
  expect(mockEmit).toHaveBeenCalledWith('session-message-appended', { sessionId: 's1', message: { role: 'assistant', content: REFUSAL } });
  expect(releaseSessionGeneration).toHaveBeenCalledWith('s1');
});

it('does not emit a refusal that could not be saved, and never throws', async () => {
  (mockDb.addMessageToSession as jest.Mock).mockImplementation(async (_id: string, message: any) => {
    if (message.role === 'assistant') throw new Error('ddb down');
  });
  await expect(resumeOriginSession('s1', 'Approved')).resolves.toBeUndefined();
  expect(mockEmit).not.toHaveBeenCalled();
});

it('a failed emit never throws', async () => {
  mockTo.mockImplementationOnce(() => { throw new Error('socket down'); });
  await expect(resumeOriginSession('s1', 'Approved')).resolves.toBeUndefined();
});
