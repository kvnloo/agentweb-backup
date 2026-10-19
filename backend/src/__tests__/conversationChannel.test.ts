/**
 * Unit tests for the ENG-272 conversation channel extraction:
 * `services/conversation/sessionResponder.ts` (transport-neutral core) and
 * `services/conversation/slackChannelAdapter.ts` (Slack implementation).
 *
 * The core is exercised against a fake adapter — which is the point of the
 * port: the product pipeline is now testable without any transport at all.
 *
 * Layout follows the ENG-266 extraction's tests (sendAsSender.test.ts):
 * FAIL cases first, then edges, then SUCCESS.
 */

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionTitle: jest.fn(),
    updateSessionGtmWorkItem: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionSlackThread: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { setSetting: jest.fn() },
}));

jest.mock('../services/gtmPlanService', () => ({
  ensureGtmWorkItemForSlackSession: jest.fn(),
}));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
  // ENG-669: the real single producer of the model_unavailable wording.
  modelUnavailableBody: (e: any) => jest.requireActual('../services/agentMode/modelUnavailable').buildModelUnavailableBody(e),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getDefaultModel: jest.fn().mockResolvedValue('default-model') },
}));

const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({ chat: { postMessage: mockPostMessage } })),
}));

jest.mock('../services/slackService', () => ({
  postThreadResponse: jest.fn(),
  resolveSlackFileUrl: jest.fn(),
  downloadSlackFile: jest.fn(),
}));

jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

import { handleSessionResponse } from '../services/conversation/sessionResponder';
import { slackChannelAdapter, renderOutboundForSlack } from '../services/conversation/slackChannelAdapter';
import type { ConversationChannelAdapter, ConversationRef } from '../services/conversation/channelPort';

const { chatbotDb } = require('../services/chatbotService');
const { settingsService } = require('../services/settingsService');
const { ensureGtmWorkItemForSlackSession } = require('../services/gtmPlanService');
const { generateSessionResponse } = require('../controllers/agentModeController');
const slackService = require('../services/slackService');
const { uploadFileToS3 } = require('../utils/s3Utils');

const REF: ConversationRef = { transport: 'slack', conversationId: 'C1', threadId: 'T1' };

function makeAdapter(overrides: Partial<ConversationChannelAdapter> = {}): ConversationChannelAdapter {
  return {
    transport: 'slack',
    persistThreadBinding: jest.fn(),
    postReply: jest.fn(),
    postContextLinks: jest.fn(),
    fetchAttachments: jest.fn().mockResolvedValue([]),
    renderOutbound: jest.fn((r: any) => r.content),
    gtmTrackerLink: jest.fn(() => 'https://portal/gtm-plan?planId=p&phaseId=ph'),
    ...overrides,
  } as ConversationChannelAdapter;
}

function baseParams(over: any = {}) {
  return {
    session: { sessionId: 's1', llmModel: 'gpt-4o' },
    user: { userId: 'u1' },
    ref: REF,
    rawMessage: 'hello there',
    userMessage: 'John: hello there',
    ...over,
  };
}

describe('handleSessionResponse — FAIL cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ensureGtmWorkItemForSlackSession.mockResolvedValue(null);
    chatbotDb.createOrReuseInteractiveShare.mockResolvedValue('https://ishare/1');
  });

  it('still persists the error message when posting the error reply also fails', async () => {
    // The realistic case: generation failed because the transport is down, so the
    // error reply fails too. Persistence must still happen and nothing may escape.
    generateSessionResponse.mockRejectedValue(new Error('boom'));
    const adapter = makeAdapter({
      postReply: jest.fn().mockRejectedValue(new Error('slack 503')),
    });

    await expect(handleSessionResponse(baseParams(), adapter)).resolves.toBeUndefined();

    expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith('s1', expect.objectContaining({
      role: 'assistant',
      content: 'Sorry, I encountered an error processing your request. Please try again.',
    }));
  });

  it("ENG-669: a session model outside the owner's plan is reported as such (thread + session), not as a generic error", async () => {
    const { ModelUnavailableError } = jest.requireActual('../services/agentMode/modelUnavailable');
    generateSessionResponse.mockRejectedValue(new ModelUnavailableError('gpt-4o', 'not_in_plan', {
      model: 'gpt-4o', tier: 'Free', allowedModels: [], upgradeRequired: ['Pro'],
    }));
    const adapter = makeAdapter();
    await expect(handleSessionResponse(baseParams(), adapter)).resolves.toBeUndefined();
    const refusal = "The model you selected (gpt-4o) isn't included in your plan, so nothing was sent to a different model. Choose another model, or upgrade your plan to use this one.";
    expect(adapter.postReply).toHaveBeenCalledWith(REF, refusal);
    expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith('s1', expect.objectContaining({ role: 'assistant', content: refusal }));
  });

  it('reports the failure into the thread when attachment resolution throws', async () => {
    // main widened this try (ENG-1644-era refactor) so a failure before generation
    // cannot escape and leak the caller's claimed progress indicator.
    const adapter = makeAdapter({
      fetchAttachments: jest.fn().mockRejectedValue(new Error('slack files.info down')),
    });

    await expect(handleSessionResponse(baseParams(), adapter)).resolves.toBeUndefined();

    expect(adapter.postReply).toHaveBeenCalledWith(
      REF,
      'Sorry, I encountered an error while processing your request. Please try again.'
    );
  });

  it('reports the failure into the thread instead of throwing when generation rejects', async () => {
    generateSessionResponse.mockRejectedValue(new Error('boom'));
    const adapter = makeAdapter();

    await expect(handleSessionResponse(baseParams(), adapter)).resolves.toBeUndefined();

    expect(adapter.postReply).toHaveBeenCalledWith(
      REF,
      'Sorry, I encountered an error while processing your request. Please try again.'
    );
  });

  it('swallows a failure to persist partial usage rather than losing the error reply', async () => {
    const err: any = new Error('boom');
    err.partialUsageMessages = [{ role: 'assistant', content: 'x' }];
    generateSessionResponse.mockRejectedValue(err);
    chatbotDb.addMessagesToSession.mockRejectedValue(new Error('dynamo down'));
    const adapter = makeAdapter();

    await expect(handleSessionResponse(baseParams(), adapter)).resolves.toBeUndefined();

    expect(adapter.postReply).toHaveBeenCalledWith(REF, expect.stringContaining('Sorry, I encountered an error'));
  });

  it('handles a rejection that carries no error object at all', async () => {
    generateSessionResponse.mockRejectedValue(undefined);
    const adapter = makeAdapter();

    await expect(handleSessionResponse(baseParams(), adapter)).resolves.toBeUndefined();

    expect(chatbotDb.addMessagesToSession).not.toHaveBeenCalled();
    expect(adapter.postReply).toHaveBeenCalledWith(REF, expect.stringContaining('Sorry, I encountered an error'));
  });

  it('does not persist partial usage when the error carries an empty batch', async () => {
    const err: any = new Error('boom');
    err.partialUsageMessages = [];
    generateSessionResponse.mockRejectedValue(err);

    await handleSessionResponse(baseParams(), makeAdapter());

    expect(chatbotDb.addMessagesToSession).not.toHaveBeenCalled();
  });

  it('swallows a failure to save the error message onto the session', async () => {
    generateSessionResponse.mockRejectedValue(new Error('boom'));
    chatbotDb.addMessageToSession.mockRejectedValue(new Error('dynamo down'));
    const adapter = makeAdapter();

    await expect(handleSessionResponse(baseParams(), adapter)).resolves.toBeUndefined();
  });

  it('still delivers the response when GTM tracking rejects', async () => {
    ensureGtmWorkItemForSlackSession.mockRejectedValue(new Error('gtm down'));
    generateSessionResponse.mockResolvedValue({ content: 'done' });
    const adapter = makeAdapter();

    await handleSessionResponse(baseParams(), adapter);

    expect(adapter.postReply).toHaveBeenCalledWith(REF, 'done');
    expect(adapter.postContextLinks).toHaveBeenCalledWith(REF, {
      ishareLink: 'https://ishare/1',
      gtmTrackerLink: null,
    });
  });
});

describe('handleSessionResponse — edges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ensureGtmWorkItemForSlackSession.mockResolvedValue(null);
    chatbotDb.createOrReuseInteractiveShare.mockResolvedValue('https://ishare/1');
    generateSessionResponse.mockResolvedValue({ content: 'done' });
  });

  it('truncates a long raw message to a 50-character session title', async () => {
    const long = 'x'.repeat(80);
    await handleSessionResponse(baseParams({ rawMessage: long }), makeAdapter());

    expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith('s1', 'x'.repeat(47) + '...');
  });

  it('leaves a short raw message as the title verbatim', async () => {
    await handleSessionResponse(baseParams(), makeAdapter());
    expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith('s1', 'hello there');
  });

  it('resolves and persists a default model when the session has none', async () => {
    await handleSessionResponse(baseParams({ session: { sessionId: 's1' } }), makeAdapter());

    expect(chatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('s1', 'default-model', undefined, 'system');
    expect(generateSessionResponse).toHaveBeenCalledWith('s1', 'John: hello there', 'u1', 'default-model', []);
  });

  it('does not rewrite the model when the session already has one', async () => {
    await handleSessionResponse(baseParams(), makeAdapter());
    expect(chatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('posts the fallback text when generation returns no content', async () => {
    generateSessionResponse.mockResolvedValue({ content: '' });
    const adapter = makeAdapter();

    await handleSessionResponse(baseParams(), adapter);

    expect(adapter.postReply).toHaveBeenCalledWith(
      REF,
      'I completed the task but was unable to format a response. Please check the portal for results or try again.'
    );
    expect(adapter.renderOutbound).not.toHaveBeenCalled();
  });
});

describe('handleSessionResponse — SUCCESS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatbotDb.createOrReuseInteractiveShare.mockResolvedValue('https://ishare/1');
    generateSessionResponse.mockResolvedValue({ content: 'done' });
  });

  it('binds the thread, stamps GTM, renders through the adapter and posts both links', async () => {
    ensureGtmWorkItemForSlackSession.mockResolvedValue({ planId: 'p', phaseId: 'ph', workItemId: 'w' });
    const adapter = makeAdapter();

    await handleSessionResponse(baseParams({ isAdminChannel: true, adminEmail: 'a@b.com' }), adapter);

    expect(adapter.persistThreadBinding).toHaveBeenCalledWith(REF, 's1', 'u1');
    expect(chatbotDb.updateSessionGtmWorkItem).toHaveBeenCalledWith('s1', {
      planId: 'p', phaseId: 'ph', workItemId: 'w',
    });
    expect(adapter.gtmTrackerLink).toHaveBeenCalledWith('p', 'ph', true);
    expect(adapter.renderOutbound).toHaveBeenCalledWith({ content: 'done' });
    expect(adapter.postContextLinks).toHaveBeenCalledWith(REF, {
      ishareLink: 'https://ishare/1',
      gtmTrackerLink: 'https://portal/gtm-plan?planId=p&phaseId=ph',
    });
  });

  it('passes adapter-resolved attachments through to generation', async () => {
    ensureGtmWorkItemForSlackSession.mockResolvedValue(null);
    const attachment = { url: 'https://s3/a.png', filename: 'a.png', mimetype: 'image/png' };
    const adapter = makeAdapter({ fetchAttachments: jest.fn().mockResolvedValue([attachment]) });

    await handleSessionResponse(baseParams({ files: [{ name: 'a.png' }] }), adapter);

    expect(adapter.fetchAttachments).toHaveBeenCalledWith([{ name: 'a.png' }], 'u1');
    expect(generateSessionResponse).toHaveBeenCalledWith('s1', 'John: hello there', 'u1', 'gpt-4o', [attachment]);
  });
});

describe('slackChannelAdapter', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('renderOutbound', () => {
    it('returns empty string when the response has no content', () => {
      expect(renderOutboundForSlack({})).toBe('');
    });

    it('resolves citation markers into markdown links', () => {
      const out = renderOutboundForSlack({
        content: 'Revenue grew{{cite:1}}.',
        responseMessages: [
          { role: 'assistant', metadata: { citations: [{ id: 1, url: 'https://ex.com/a', siteName: 'Example' }] } },
        ],
      });
      expect(out).toBe('Revenue grew ([Example](https://ex.com/a)).');
    });

    it('strips a marker that has no matching citation rather than inventing a source', () => {
      expect(renderOutboundForSlack({ content: 'Claim{{cite:9}}.' })).toBe('Claim.');
    });

    it('tolerates non-array citation metadata', () => {
      const out = renderOutboundForSlack({
        content: 'Plain text',
        responseMessages: [{ role: 'assistant', metadata: { citations: 'nope' } }],
      });
      expect(out).toBe('Plain text');
    });

    it('returns empty string for a null/undefined response', () => {
      expect(renderOutboundForSlack(undefined)).toBe('');
      expect(renderOutboundForSlack(null)).toBe('');
    });

    it('tolerates null entries and an assistant message carrying no metadata', () => {
      const out = renderOutboundForSlack({
        content: 'Plain text',
        responseMessages: [null, { role: 'user' }, { role: 'assistant' }],
      });
      expect(out).toBe('Plain text');
    });
  });

  describe('gtmTrackerLink', () => {
    it('points admin channels at the partner portal gtm-ops page', () => {
      expect(slackChannelAdapter.gtmTrackerLink('p', 'ph', true)).toContain('/gtm-ops?planId=p&phaseId=ph');
    });

    it('points regular users at the customer portal gtm-plan page', () => {
      expect(slackChannelAdapter.gtmTrackerLink('p', 'ph', false)).toContain('/gtm-plan?planId=p&phaseId=ph');
    });

    it('honours the configured portal URLs', () => {
      const prevAdmin = process.env.FRONTEND_URL;
      const prevUser = process.env.CUSTOMER_FRONTEND_URL;
      process.env.FRONTEND_URL = 'https://partner.example';
      process.env.CUSTOMER_FRONTEND_URL = 'https://app.example';
      try {
        expect(slackChannelAdapter.gtmTrackerLink('p', 'ph', true)).toBe('https://partner.example/gtm-ops?planId=p&phaseId=ph');
        expect(slackChannelAdapter.gtmTrackerLink('p', 'ph')).toBe('https://app.example/gtm-plan?planId=p&phaseId=ph');
      } finally {
        process.env.FRONTEND_URL = prevAdmin;
        process.env.CUSTOMER_FRONTEND_URL = prevUser;
      }
    });
  });

  describe('persistThreadBinding', () => {
    it('writes the legacy slackThread field and slack_thread_* mapping key unchanged', async () => {
      await slackChannelAdapter.persistThreadBinding(REF, 's1', 'u1');

      expect(chatbotDb.updateSessionSlackThread).toHaveBeenCalledWith('s1', { channel: 'C1', threadTs: 'T1' });
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'slack_thread_C1_T1',
        JSON.stringify({ sessionId: 's1', userId: 'u1' }),
        'Slack thread to session mapping',
        'system'
      );
    });
  });

  describe('postReply', () => {
    it('posts into the thread', async () => {
      await slackChannelAdapter.postReply(REF, 'hi');
      expect(slackService.postThreadResponse).toHaveBeenCalledWith('C1', 'T1', 'hi');
    });
  });

  describe('postContextLinks', () => {
    it('posts nothing when there is no iShare link', async () => {
      await slackChannelAdapter.postContextLinks(REF, { ishareLink: null, gtmTrackerLink: 'https://g' });
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('posts a single element when only the iShare link exists', async () => {
      await slackChannelAdapter.postContextLinks(REF, { ishareLink: 'https://i' });
      const arg = mockPostMessage.mock.calls[0][0];
      expect(arg.blocks[0].elements).toHaveLength(1);
      expect(arg.thread_ts).toBe('T1');
    });

    it('appends the GTM element when a tracker link exists', async () => {
      await slackChannelAdapter.postContextLinks(REF, { ishareLink: 'https://i', gtmTrackerLink: 'https://g' });
      const arg = mockPostMessage.mock.calls[0][0];
      expect(arg.blocks[0].elements).toHaveLength(2);
      expect(arg.blocks[0].elements[1].text).toContain('https://g');
    });
  });

  describe('fetchAttachments', () => {
    it('returns an empty list when there are no files', async () => {
      await expect(slackChannelAdapter.fetchAttachments(undefined, 'u1')).resolves.toEqual([]);
      await expect(slackChannelAdapter.fetchAttachments([], 'u1')).resolves.toEqual([]);
    });

    it('skips a file whose upload reports failure', async () => {
      slackService.resolveSlackFileUrl.mockResolvedValue('https://files/a');
      slackService.downloadSlackFile.mockResolvedValue(Buffer.from('x'));
      uploadFileToS3.mockResolvedValue({ success: false });

      await expect(slackChannelAdapter.fetchAttachments([{ name: 'a.png' }], 'u1')).resolves.toEqual([]);
    });

    it('skips a file that throws while downloading but keeps the rest', async () => {
      slackService.resolveSlackFileUrl.mockImplementation(async (f: any) => f.name);
      slackService.downloadSlackFile.mockImplementation(async (n: string) => {
        if (n === 'bad') throw new Error('nope');
        return Buffer.from('x');
      });
      uploadFileToS3.mockResolvedValue({ success: true, url: 'https://s3/ok' });

      const out = await slackChannelAdapter.fetchAttachments(
        [{ name: 'bad' }, { name: 'good', mimetype: 'image/png', size: 4 }],
        'u1'
      );

      expect(out).toEqual([{ url: 'https://s3/ok', filename: 'good', size: 4, mimetype: 'image/png' }]);
    });

    it('defaults filename and mimetype when Slack omits them', async () => {
      slackService.resolveSlackFileUrl.mockResolvedValue('https://files/a');
      slackService.downloadSlackFile.mockResolvedValue(Buffer.from('x'));
      uploadFileToS3.mockResolvedValue({ success: true, url: 'https://s3/ok' });

      const out = await slackChannelAdapter.fetchAttachments([{}], 'u1');

      expect(out).toEqual([
        { url: 'https://s3/ok', filename: 'attachment', size: undefined, mimetype: 'application/octet-stream' },
      ]);
      expect(uploadFileToS3).toHaveBeenCalledWith(
        expect.any(Buffer), 'attachment', 'u1', 'application/octet-stream'
      );
    });
  });
});
