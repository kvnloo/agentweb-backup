jest.mock('../controllers/agentModeController', () => ({
  runVerifiedChat: jest.fn().mockResolvedValue({ success: true, toolCalls: [] }),
}));

jest.mock('../services/v0Service', () => ({
  iterateLandingPage: jest.fn().mockResolvedValue({ id: 'page-1' }),
  deployLandingPage: jest.fn().mockResolvedValue({ id: 'page-1', status: 'deployed' }),
}));

jest.mock('../emma/enrichmentToolRunner', () => ({
  runEmmaEnrichment: jest.fn().mockResolvedValue({
    runId: 'rerun-1',
    processedCount: 2,
    failedCount: 0,
  }),
}));

jest.mock('../services/autoHumanEvalService', () => ({
  enqueueAutoHumanEval: jest.fn().mockResolvedValue(null),
}));

import { runVerifiedChat } from '../controllers/agentModeController';
import { runEmmaEnrichment } from '../emma/enrichmentToolRunner';
import { enqueueAutoHumanEval } from '../services/autoHumanEvalService';
import { runHumanEvalFeedbackAction } from '../services/humanEvalActionService';
import { deployLandingPage, iterateLandingPage } from '../services/v0Service';
import type { HumanEvalCandidate, HumanEvalFeedback } from '../services/humanEvalService';

const feedback: HumanEvalFeedback = {
  feedbackId: 'C1:178.1',
  slackUserId: 'U1',
  slackUserDisplayName: 'Matt',
  text: 'Make the hero more concrete and move the CTA above the fold.',
  createdAt: '2026-06-23T00:00:00.000Z',
};

function candidate(overrides: Partial<HumanEvalCandidate>): HumanEvalCandidate {
  return {
    candidateId: 'candidate-1',
    reviewType: 'landing_page',
    reviewer: 'matt',
    status: 'pending',
    outputSummary: 'summary',
    slackChannel: 'C_EVAL',
    slackMessageTs: '178.0',
    feedback: [],
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runHumanEvalFeedbackAction', () => {
  it('revises image artifacts through Agent Mode generate_image', async () => {
    await runHumanEvalFeedbackAction(
      candidate({
        reviewType: 'creative_image',
        userId: 'user-1',
        sessionId: 'session-1',
        artifactUrl: 'https://example.com/image.png',
        action: {
          type: 'agent_mode_image_revision',
          userId: 'user-1',
          sessionId: 'session-1',
          artifactUrl: 'https://example.com/image.png',
          filename: 'image.png',
        },
      }),
      feedback,
    );

    expect(runVerifiedChat).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: expect.stringContaining('https://example.com/image.png'),
      requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
    }));
    // ENG-634 (narrowed): a single-purpose image-revision flow does NOT enable the
    // completion gate — a free-text "shall I proceed?" halt doesn't occur here, and
    // structured questions are still handled by the park/auto-take path. The gate is
    // reserved for resultEndpoint (arbitrary configured prompts).
    expect((runVerifiedChat as jest.Mock).mock.calls[0][0].completionGate).toBeUndefined();
  });

  it('iterates and deploys landing pages from Matt feedback', async () => {
    await runHumanEvalFeedbackAction(
      candidate({
        userId: 'user-1',
        action: {
          type: 'landing_page_iteration_deploy',
          landingPageId: 'page-1',
          userId: 'user-1',
        },
      }),
      feedback,
    );

    expect(iterateLandingPage).toHaveBeenCalledWith(
      'page-1',
      'user-1',
      expect.stringContaining('Human eval feedback from Matt'),
    );
    expect(deployLandingPage).toHaveBeenCalledWith('page-1', 'user-1');
  });

  it('reruns lead enrichment from Fangfang feedback and sends the rerun back to eval', async () => {
    await runHumanEvalFeedbackAction(
      candidate({
        reviewType: 'lead_enrichment',
        reviewer: 'fangfang',
        userId: 'user-1',
        sessionId: 'session-1',
        action: {
          type: 'lead_enrichment_rerun',
          listId: 'list-1',
          leadId: 'lead-1',
          userId: 'user-1',
          outputFields: [{ name: 'industry', instruction: 'classify industry' }],
          toolName: 'enrich_lead_custom',
        },
      }),
      { ...feedback, slackUserDisplayName: 'Fangfang', text: 'Industry should be fintech.' },
    );

    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-1',
      userId: 'user-1',
      mode: 'enrich',
      leadIds: ['lead-1'],
      outputFields: [expect.objectContaining({
        name: 'industry',
        instruction: expect.stringContaining('Industry should be fintech.'),
        overwrite_policy: 'always_overwrite',
      })],
    }));
    expect(enqueueAutoHumanEval).toHaveBeenCalledWith(expect.objectContaining({
      reviewType: 'lead_enrichment',
      userId: 'user-1',
      sessionId: 'session-1',
      sourceKey: expect.stringContaining('lead-enrichment-feedback:candidate-1:C1:178.1:rerun-1'),
    }));
  });

  it('carries the original candidate category onto the feedback-rerun eval', async () => {
    await runHumanEvalFeedbackAction(
      candidate({
        reviewType: 'lead_enrichment',
        reviewer: 'fangfang',
        userId: 'user-1',
        category: 'ad',
        action: {
          type: 'lead_enrichment_rerun',
          listId: 'list-1',
          userId: 'user-1',
          outputFields: [{ name: 'industry', instruction: 'classify industry' }],
          toolName: 'enrich_lead_custom',
        },
      }),
      { ...feedback, slackUserDisplayName: 'Fangfang', text: 'Fix industry.' },
    );

    expect(enqueueAutoHumanEval).toHaveBeenCalledWith(expect.objectContaining({
      category: 'ad',
    }));
  });
});
