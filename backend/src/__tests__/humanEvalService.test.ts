import { HumanEvalCandidate, HumanEvalService } from '../services/humanEvalService';

function makeHarness() {
  const items = new Map<string, HumanEvalCandidate>();
  const settings = new Map<string, string>();

  settings.set('human_eval_slack_channel', 'C_EVAL');
  settings.set('human_eval_reviewer_matt_slack_user_id', 'U_MATT');
  settings.set('human_eval_reviewer_fangfang_slack_user_id', 'U_FANGFANG');

  const db = {
    put: jest.fn((params: any) => ({
      promise: async () => {
        items.set(params.Item.candidateId, params.Item);
      },
    })),
    get: jest.fn((params: any) => ({
      promise: async () => ({ Item: items.get(params.Key.candidateId) }),
    })),
    update: jest.fn((params: any) => ({
      promise: async () => {
        const item = items.get(params.Key.candidateId);
        if (!item) return;
        const feedback = params.ExpressionAttributeValues[':feedback'];
        item.feedback = [...(item.feedback || []), ...feedback];
        item.status = params.ExpressionAttributeValues[':status'];
        item.updatedAt = params.ExpressionAttributeValues[':updatedAt'];
        items.set(item.candidateId, item);
      },
    })),
  };

  const settingsService = {
    getSetting: jest.fn(async (name: string) => {
      const settingValue = settings.get(name);
      return settingValue ? { settingValue } : null;
    }),
    setSetting: jest.fn(async (name: string, value: string) => {
      settings.set(name, value);
    }),
  };

  const slack = {
    postSlackMessage: jest.fn(async (channelId: string) => ({ channel: channelId, ts: '1780000000.123456' })),
    getSlackUserDisplayName: jest.fn(async () => 'Matthew Wilmer'),
    getSlackUserEmail: jest.fn(async () => 'matthew@agentweb.pro'),
    resolveSlackMentionsInText: jest.fn(async (text: string) => text),
  };

  const chatbot = {
    addMessageToSession: jest.fn(async () => ({})),
  };

  const learning = {
    recordFeedback: jest.fn(async () => undefined),
  };

  const actions = {
    run: jest.fn(async () => undefined),
  };

  const service = new HumanEvalService(db as any, settingsService as any, slack, chatbot, learning, actions);
  return { service, db, settingsService, slack, chatbot, learning, actions, items, settings };
}

describe('HumanEvalService', () => {
  it('routes creative images to Matt and posts a Slack thread-native candidate', async () => {
    const { service, slack, settings, items } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Generated two Meta image ad variants for BodyLever.',
      artifactUrl: 'https://example.com/ad.png',
      sessionId: 'session-1',
      userId: 'user-1',
      originalRequest: 'Create ad creatives.',
    });

    expect(candidate.reviewer).toBe('matt');
    expect(candidate.reviewerSlackUserId).toBe('U_MATT');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('<@U_MATT>'),
    );
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('Reply in this thread with free-form feedback'),
    );
    expect(settings.get('human_eval_thread_C_EVAL_1780000000.123456')).toBe(candidate.candidateId);
    expect(items.get(candidate.candidateId)?.artifactUrl).toBe('https://example.com/ad.png');
  });

  it('routes lead enrichment to Fangfang', async () => {
    const { service, slack } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'lead_enrichment',
      outputSummary: 'Enriched Sail to Sunset attendee list.',
      artifactUrl: 'https://example.com/leads.csv',
    });

    expect(candidate.reviewer).toBe('fangfang');
    expect(candidate.reviewerSlackUserId).toBe('U_FANGFANG');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('<@U_FANGFANG>'),
    );
  });

  it('captures Slack thread replies as durable feedback and injects a session learning note', async () => {
    const { service, chatbot, learning, actions, items } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'landing_page',
      outputSummary: 'Landing page for webinar registration.',
      artifactUrl: 'https://example.com/landing',
      sessionId: 'session-2',
      userId: 'user-2',
      action: {
        type: 'landing_page_iteration_deploy',
        landingPageId: 'page-1',
        userId: 'user-2',
      },
    });

    const handled = await service.handleSlackThreadReply({
      channel: candidate.slackChannel,
      threadTs: candidate.slackMessageTs,
      messageTs: '1780000001.000001',
      slackUserId: 'U_MATT',
      text: 'Hero is clear, but mobile hierarchy fails and CTA is too low.',
    });

    expect(handled).toBe(true);
    const updated = items.get(candidate.candidateId)!;
    expect(updated.status).toBe('reviewed');
    expect(updated.feedback).toHaveLength(1);
    expect(updated.feedback[0].text).toContain('mobile hierarchy fails');
    expect(chatbot.addMessageToSession).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('[Human Eval Feedback] Matt reviewed landing page.'),
        metadata: expect.objectContaining({
          source: 'human-eval-slack-thread',
          humanEvalCandidateId: candidate.candidateId,
        }),
      }),
    );
    expect(learning.recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: candidate.candidateId }),
      expect.objectContaining({ text: expect.stringContaining('mobile hierarchy fails') }),
    );
    expect(actions.run).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: candidate.candidateId }),
      expect.objectContaining({ text: expect.stringContaining('mobile hierarchy fails') }),
    );
  });

  it('ignores replies for unrelated Slack threads', async () => {
    const { service, chatbot } = makeHarness();

    const handled = await service.handleSlackThreadReply({
      channel: 'C_OTHER',
      threadTs: '111.222',
      messageTs: '111.333',
      slackUserId: 'U_MATT',
      text: 'not an eval',
    });

    expect(handled).toBe(false);
    expect(chatbot.addMessageToSession).not.toHaveBeenCalled();
  });
});
