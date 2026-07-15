import { HumanEvalCandidate, HumanEvalService, parseHumanEvalCategoryFilter } from '../services/humanEvalService';

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
    scan: jest.fn((_params: any) => ({
      promise: async () => ({ Items: [...items.values()] }),
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
    postSlackMessage: jest.fn(async (channelId: string, _text: string) => ({ channel: channelId, ts: '1780000000.123456' })),
    getSlackUserDisplayName: jest.fn(async () => 'Matthew Wilmer'),
    getSlackUserEmail: jest.fn(async () => 'matthew@agentweb.pro'),
    resolveSlackMentionsInText: jest.fn(async (text: string) => text),
  };

  const chatbot = {
    addMessageToSession: jest.fn(async () => ({})),
    createOrReuseInteractiveShare: jest.fn(async (sessionId: string) => `https://app.agentweb.pro/ishare/${sessionId}?conversable=token-123`),
  };

  const learning = {
    recordFeedback: jest.fn(async () => undefined),
  };

  const actions = {
    run: jest.fn(async () => undefined),
  };

  const assetStore = {
    uploadInlineImage: jest.fn(async () => ({
      url: 'https://files.example.com/human-eval/ad.jpg',
      key: 'human-eval/ad.jpg',
      byteLength: 3,
      mimeType: 'image/jpeg',
    })),
  };

  const telemetry = {
    recordAssetEvent: jest.fn(async () => undefined),
  };

  const service = new HumanEvalService(
    db as any,
    settingsService as any,
    slack,
    chatbot,
    learning,
    actions,
    assetStore,
    telemetry,
  );
  return { service, db, settingsService, slack, chatbot, learning, actions, assetStore, telemetry, items, settings };
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

  it('uses an interactive share link for associated Agent Mode chats', async () => {
    const { service, slack, chatbot } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'lead_enrichment',
      outputSummary: 'Lead enrichment completed.',
      sessionId: 'session-123',
    });

    expect(chatbot.createOrReuseInteractiveShare).toHaveBeenCalledWith('session-123');
    expect(candidate.chatUrl).toBe('https://app.agentweb.pro/ishare/session-123?conversable=token-123');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('*Chat:* <https://app.agentweb.pro/ishare/session-123?conversable=token-123|open associated chat>'),
    );
  });

  it('stores reviewer-safe share links on session-backed candidates', async () => {
    const { service } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Image generated.',
      sessionId: 'image-session',
    });

    expect(candidate.chatUrl).toContain('/ishare/image-session?conversable=');
    expect(candidate.chatUrl).not.toContain('/agent-mode/image-session');
  });

  it('does not post private Agent Mode links for automatic lead enrichment evals', async () => {
    const { service, slack } = makeHarness();

    await service.createCandidate({
      reviewType: 'lead_enrichment',
      outputSummary: 'Lead enrichment completed.',
      sessionId: 'lead-session',
      originalRequest: 'enrich_leads_execute feedback rerun list=list_123',
    });

    const postedMessage = slack.postSlackMessage.mock.calls[0][1];
    expect(postedMessage).toContain('/ishare/lead-session?conversable=');
    expect(postedMessage).not.toContain('/agent-mode/lead-session');
  });

  it('preserves an explicit chat URL without creating a new interactive share', async () => {
    const { service, chatbot } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'landing_page',
      outputSummary: 'Landing page generated.',
      sessionId: 'session-123',
      chatUrl: 'https://app.agentweb.pro/custom-review-link',
    });

    expect(chatbot.createOrReuseInteractiveShare).not.toHaveBeenCalled();
    expect(candidate.chatUrl).toBe('https://app.agentweb.pro/custom-review-link');
  });

  it('falls back to an encoded direct Agent Mode link when interactive share creation fails', async () => {
    const { service, chatbot } = makeHarness();
    chatbot.createOrReuseInteractiveShare.mockRejectedValueOnce(new Error('share failed'));

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Image generated.',
      sessionId: 'session with spaces',
    });

    expect(candidate.chatUrl).toBe('http://localhost:5174/agent-mode/session%20with%20spaces');
  });

  it('omits the associated chat line when no session or chat URL is available', async () => {
    const { service, slack, chatbot } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'lead_enrichment',
      outputSummary: 'Lead enrichment completed.',
    });

    expect(chatbot.createOrReuseInteractiveShare).not.toHaveBeenCalled();
    expect(candidate.chatUrl).toBeUndefined();
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.not.stringContaining('open associated chat'),
    );
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

  it('uploads inline image data before posting a human eval Slack message', async () => {
    const { service, slack, assetStore, telemetry, items } = makeHarness();
    const dataUri = 'data:image/jpeg;base64,/9j/';

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: `Output was ${dataUri}`,
      artifactUrl: dataUri,
      sessionId: 'session-image',
      userId: 'user-image',
    });

    expect(assetStore.uploadInlineImage).toHaveBeenCalledWith(
      dataUri,
      expect.objectContaining({
        candidateId: candidate.candidateId,
        reviewType: 'creative_image',
        userId: 'user-image',
      }),
    );
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('<https://files.example.com/human-eval/ad.jpg|open output>'),
    );
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.not.stringContaining('data:image/jpeg;base64'),
    );
    expect(items.get(candidate.candidateId)?.artifactUrl).toBe('https://files.example.com/human-eval/ad.jpg');
    expect(items.get(candidate.candidateId)?.outputSummary).not.toContain('data:image/jpeg;base64');
    expect(telemetry.recordAssetEvent).toHaveBeenCalledWith(
      'human_eval_asset_inline_image_uploaded',
      expect.objectContaining({
        candidateId: candidate.candidateId,
        reviewType: 'creative_image',
        mimeType: 'image/jpeg',
      }),
    );
  });

  it('does not let telemetry failures block a valid inline image eval', async () => {
    const { service, slack, telemetry } = makeHarness();
    const dataUri = 'data:image/jpeg;base64,/9j/';
    telemetry.recordAssetEvent.mockRejectedValue(new Error('Dynamo down'));

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Generated ad creative.',
      artifactUrl: dataUri,
      sessionId: 'session-image',
      userId: 'user-image',
    });

    expect(candidate.artifactUrl).toBe('https://files.example.com/human-eval/ad.jpg');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('<https://files.example.com/human-eval/ad.jpg|open output>'),
    );
  });

  it('fails closed and records telemetry when inline image upload fails', async () => {
    const { service, slack, db, assetStore, telemetry } = makeHarness();
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    assetStore.uploadInlineImage.mockRejectedValueOnce(new Error('S3 upload failed'));

    await expect(service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Generated ad creative.',
      artifactUrl: dataUri,
      sessionId: 'session-image',
      userId: 'user-image',
    })).rejects.toThrow('Human eval image artifact could not be uploaded');

    expect(slack.postSlackMessage).not.toHaveBeenCalled();
    expect(db.put).not.toHaveBeenCalled();
    expect(telemetry.recordAssetEvent).toHaveBeenCalledWith(
      'human_eval_asset_delivery_failed',
      expect.objectContaining({
        reviewType: 'creative_image',
        reason: 'inline_image_upload_failed',
        errorClass: expect.any(String),
      }),
    );
  });

  it('rejects unsupported data artifacts before Slack can render raw data', async () => {
    const { service, slack, db, assetStore, telemetry } = makeHarness();

    await expect(service.createCandidate({
      reviewType: 'landing_page',
      outputSummary: 'Generated HTML.',
      artifactUrl: 'data:text/html;base64,PGh0bWw+',
      sessionId: 'session-html',
      userId: 'user-html',
    })).rejects.toThrow('Human eval artifact must be a fetchable URL');

    expect(assetStore.uploadInlineImage).not.toHaveBeenCalled();
    expect(slack.postSlackMessage).not.toHaveBeenCalled();
    expect(db.put).not.toHaveBeenCalled();
    expect(telemetry.recordAssetEvent).toHaveBeenCalledWith(
      'human_eval_asset_delivery_failed',
      expect.objectContaining({
        reviewType: 'landing_page',
        reason: 'unsupported_data_uri',
      }),
    );
  });

  it('sanitizes the nested action.artifactUrl so a raw image binary never persists in the queue item', async () => {
    const { service, assetStore, items } = makeHarness();
    const dataUri = 'data:image/jpeg;base64,/9j/';

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Generated ad creative.',
      artifactUrl: dataUri,
      sessionId: 'session-image',
      userId: 'user-image',
      action: {
        type: 'agent_mode_image_revision',
        sessionId: 'session-image',
        userId: 'user-image',
        artifactUrl: dataUri,
        filename: 'ad.jpg',
      },
    });

    const stored = items.get(candidate.candidateId);
    // Both the top-level artifact and the nested action copy become the uploaded S3 URL.
    expect(stored?.artifactUrl).toBe('https://files.example.com/human-eval/ad.jpg');
    expect(stored?.action).toMatchObject({
      type: 'agent_mode_image_revision',
      artifactUrl: 'https://files.example.com/human-eval/ad.jpg',
    });
    // The raw base64 binary is nowhere in the persisted item (the exact gap this closes).
    expect(JSON.stringify(stored)).not.toContain('data:image/jpeg;base64');
    // The data URI duplicated across both fields only hits S3 once.
    expect(assetStore.uploadInlineImage).toHaveBeenCalledTimes(1);
  });

  it('drops a data: URI chatUrl and falls back to a real session share link', async () => {
    const { service, slack, chatbot, telemetry, items } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'lead_enrichment',
      outputSummary: 'Lead enrichment completed.',
      chatUrl: 'data:image/png;base64,iVBORw0KGgo=',
      sessionId: 'session-chat',
    });

    // The data: URI never reaches Slack or the persisted item.
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.not.stringContaining('data:image/png;base64'),
    );
    expect(items.get(candidate.candidateId)?.chatUrl).not.toContain('data:image');
    // It is dropped, so the chat link falls back to the session interactive-share link.
    expect(chatbot.createOrReuseInteractiveShare).toHaveBeenCalledWith('session-chat');
    expect(candidate.chatUrl).toBe('https://app.agentweb.pro/ishare/session-chat?conversable=token-123');
    expect(telemetry.recordAssetEvent).toHaveBeenCalledWith(
      'human_eval_asset_delivery_failed',
      expect.objectContaining({ reason: 'unsupported_chat_url_data_uri' }),
    );
  });

  it('redacts inline image data from originalRequest before Slack and storage', async () => {
    const { service, slack, items } = makeHarness();
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

    const candidate = await service.createCandidate({
      reviewType: 'landing_page',
      outputSummary: 'Generated landing page.',
      originalRequest: `Make it look like ${dataUri}`,
      artifactUrl: 'https://example.com/landing',
      sessionId: 'session-ask',
      userId: 'user-ask',
    });

    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.not.stringContaining('data:image/png;base64'),
    );
    const stored = items.get(candidate.candidateId);
    expect(stored?.originalRequest).not.toContain('data:image/png;base64');
    expect(stored?.originalRequest).toContain('inline image data redacted');
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

  it('stores a normalized category and surfaces a bold Ad tag in the Slack post', async () => {
    const { service, slack, items } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Meta ad image for BodyLever.',
      artifactUrl: 'https://example.com/ad.png',
      category: 'ad',
    });

    expect(candidate.category).toBe('ad');
    expect(items.get(candidate.candidateId)?.category).toBe('ad');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('*Category:* Ad'),
    );
  });

  it('surfaces an Organic Post tag for organic_post images', async () => {
    const { service, slack } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'LinkedIn post image.',
      category: 'organic_post',
    });

    expect(candidate.category).toBe('organic_post');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('*Category:* Organic Post'),
    );
  });

  it('labels creative images with no category as Uncategorized without breaking enqueue', async () => {
    const { service, slack, items } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Image generated with no flow context.',
    });

    expect(candidate.category).toBe('uncategorized');
    expect(items.get(candidate.candidateId)?.category).toBe('uncategorized');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('*Category:* Uncategorized'),
    );
  });

  it('normalizes unknown category values fail-open to uncategorized instead of throwing', async () => {
    const { service, slack } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Image generated.',
      category: 'banner!!weirdness',
    });

    expect(candidate.category).toBe('uncategorized');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('*Category:* Uncategorized'),
    );
  });

  it('accepts human-friendly category spellings like "Organic Post"', async () => {
    const { service } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'creative_image',
      outputSummary: 'Image generated.',
      category: ' Organic Post ',
    });

    expect(candidate.category).toBe('organic_post');
  });

  it('does not render a category tag on non-image reviews without an explicit category', async () => {
    const { service, slack, items } = makeHarness();

    const candidate = await service.createCandidate({
      reviewType: 'lead_enrichment',
      outputSummary: 'Lead enrichment completed.',
    });

    // Stored (filterable) but not rendered — Ad/Organic is an image distinction.
    expect(items.get(candidate.candidateId)?.category).toBe('uncategorized');
    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.not.stringContaining('*Category:*'),
    );
  });

  it('renders the category tag on non-image reviews when explicitly categorized', async () => {
    const { service, slack } = makeHarness();

    await service.createCandidate({
      reviewType: 'landing_page',
      outputSummary: 'Ad landing page generated.',
      category: 'ad',
    });

    expect(slack.postSlackMessage).toHaveBeenCalledWith(
      'C_EVAL',
      expect.stringContaining('*Category:* Ad'),
    );
  });

  it('lists candidates filtered by category, treating legacy records without the field as uncategorized', async () => {
    const { service, items } = makeHarness();

    const base = {
      reviewer: 'matt' as const,
      status: 'pending' as const,
      outputSummary: 'summary',
      slackChannel: 'C_EVAL',
      slackMessageTs: '178.0',
      feedback: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    items.set('cand-ad', {
      ...base,
      candidateId: 'cand-ad',
      reviewType: 'creative_image',
      category: 'ad',
      createdAt: '2026-07-03T00:00:00.000Z',
    } as any);
    items.set('cand-organic', {
      ...base,
      candidateId: 'cand-organic',
      reviewType: 'creative_image',
      category: 'organic_post',
      createdAt: '2026-07-02T00:00:00.000Z',
    } as any);
    // Legacy record written before the category field existed.
    items.set('cand-legacy', {
      ...base,
      candidateId: 'cand-legacy',
      reviewType: 'creative_image',
      createdAt: '2026-07-01T00:00:00.000Z',
    } as any);

    const ads = await service.listCandidates({ category: 'ad' });
    expect(ads.map((c) => c.candidateId)).toEqual(['cand-ad']);

    const uncategorized = await service.listCandidates({ category: 'uncategorized' });
    expect(uncategorized.map((c) => c.candidateId)).toEqual(['cand-legacy']);

    const all = await service.listCandidates();
    expect(all.map((c) => c.candidateId)).toEqual(['cand-ad', 'cand-organic', 'cand-legacy']);
  });

  it('strictly parses category filter values: friendly spellings map, near-misses return null', () => {
    // Recognized spellings (case/space/hyphen tolerant) map to the canonical value.
    expect(parseHumanEvalCategoryFilter('ad')).toBe('ad');
    expect(parseHumanEvalCategoryFilter('Ad')).toBe('ad');
    expect(parseHumanEvalCategoryFilter('Organic Post')).toBe('organic_post');
    expect(parseHumanEvalCategoryFilter('organic-post')).toBe('organic_post');
    expect(parseHumanEvalCategoryFilter('UNCATEGORIZED')).toBe('uncategorized');

    // Anything else is null so the read path can reject instead of coercing —
    // a filter must never silently return the wrong record set.
    expect(parseHumanEvalCategoryFilter('ads')).toBeNull();
    expect(parseHumanEvalCategoryFilter('orgnic_post')).toBeNull();
    expect(parseHumanEvalCategoryFilter('')).toBeNull();
    expect(parseHumanEvalCategoryFilter('organic post extra')).toBeNull();
  });

  it('lists candidates newest-first with a limit and supports status/reviewType filters', async () => {
    const { service, items } = makeHarness();

    const base = {
      reviewer: 'matt' as const,
      outputSummary: 'summary',
      slackChannel: 'C_EVAL',
      slackMessageTs: '178.0',
      feedback: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    items.set('old-pending', {
      ...base,
      candidateId: 'old-pending',
      reviewType: 'creative_image',
      status: 'pending',
      category: 'ad',
      createdAt: '2026-07-01T00:00:00.000Z',
    } as any);
    items.set('new-pending', {
      ...base,
      candidateId: 'new-pending',
      reviewType: 'creative_image',
      status: 'pending',
      category: 'ad',
      createdAt: '2026-07-04T00:00:00.000Z',
    } as any);
    items.set('reviewed-landing', {
      ...base,
      candidateId: 'reviewed-landing',
      reviewType: 'landing_page',
      status: 'reviewed',
      category: 'uncategorized',
      createdAt: '2026-07-03T00:00:00.000Z',
    } as any);

    const limited = await service.listCandidates({ limit: 1 });
    expect(limited.map((c) => c.candidateId)).toEqual(['new-pending']);

    const reviewed = await service.listCandidates({ status: 'reviewed' });
    expect(reviewed.map((c) => c.candidateId)).toEqual(['reviewed-landing']);

    const landing = await service.listCandidates({ reviewType: 'landing_page' });
    expect(landing.map((c) => c.candidateId)).toEqual(['reviewed-landing']);
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
