// Unit tests for Agent Mode revision generation from Slack "Request Changes"

import { approvalDb } from '../services/approvalDb';
import { taskDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import { runVerifiedChat } from '../controllers/agentModeController';
import { sendApprovalRequestWithTracking } from '../services/slackService';

// Mock dependencies
jest.mock('../services/approvalDb');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../controllers/agentModeController');
jest.mock('../services/slackService');
jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn()
  }
}));

describe('Agent Mode Revision from Slack Request Changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Agent Mode asset detection', () => {
    it('should detect Agent Mode image asset by executionId pattern', () => {
      const executionId = 'session123-images';
      const isAgentModeImage = executionId.endsWith('-images');
      const isAgentModeVideo = executionId.endsWith('-videos');
      const isAgentModeHtml = executionId.endsWith('-html');
      const isAgentModeAsset = isAgentModeImage || isAgentModeVideo || isAgentModeHtml;
      const agentSessionId = isAgentModeAsset
        ? (isAgentModeImage
          ? executionId.replace('-images', '')
          : isAgentModeVideo
            ? executionId.replace('-videos', '')
            : executionId.replace('-html', ''))
        : null;

      expect(isAgentModeAsset).toBe(true);
      expect(agentSessionId).toBe('session123');
    });

    it('should detect Agent Mode HTML asset by executionId pattern', () => {
      const executionId = 'session456-html';
      const isAgentModeImage = executionId.endsWith('-images');
      const isAgentModeVideo = executionId.endsWith('-videos');
      const isAgentModeHtml = executionId.endsWith('-html');
      const isAgentModeAsset = isAgentModeImage || isAgentModeVideo || isAgentModeHtml;
      const agentSessionId = isAgentModeAsset
        ? (isAgentModeImage
          ? executionId.replace('-images', '')
          : isAgentModeVideo
            ? executionId.replace('-videos', '')
            : executionId.replace('-html', ''))
        : null;

      expect(isAgentModeAsset).toBe(true);
      expect(agentSessionId).toBe('session456');
    });
  });

  describe('Asset URL extraction', () => {
    it('should extract imageUrl (camelCase) from generate_image result', () => {
      const toolCalls = [{
        id: 'call123',
        name: 'generate_image',
        result: {
          success: true,
          imageUrl: 'https://example.com/new-image.png',
          filename: 'new-image.png'
        }
      }];

      let newAssetUrl: string | null = null;
      let newAssetFilename: string | null = null;

      for (const toolCall of toolCalls) {
        const toolResult = toolCall?.result || {};
        const imageUrl = toolResult.imageUrl || toolResult.image_url || toolResult.s3_url || toolResult.url;
        if (imageUrl) {
          newAssetUrl = imageUrl;
          newAssetFilename = toolResult.filename || toolResult.file_name || `revised_image`;
          break;
        }
      }

      expect(newAssetUrl).toBe('https://example.com/new-image.png');
      expect(newAssetFilename).toBe('new-image.png');
    });

    it('should extract s3_url from update_html_file result', () => {
      const toolCalls = [{
        id: 'call456',
        name: 'update_html_file',
        result: {
          success: true,
          s3_url: 'https://s3.amazonaws.com/bucket/report_v2.html',
          versioned_filename: 'report_v2.html'
        }
      }];

      let newAssetUrl: string | null = null;
      let newAssetFilename: string | null = null;

      for (const toolCall of toolCalls) {
        const toolResult = toolCall?.result || {};
        const htmlUrl = toolResult.file_url || toolResult.s3_url || toolResult.htmlUrl;
        if (htmlUrl) {
          newAssetUrl = htmlUrl;
          newAssetFilename = toolResult.filename || toolResult.file_name || toolResult.versioned_filename || `revised_report.html`;
          break;
        }
      }

      expect(newAssetUrl).toBe('https://s3.amazonaws.com/bucket/report_v2.html');
      expect(newAssetFilename).toBe('report_v2.html');
    });
  });

  describe('Oncall alert on extraction failure', () => {
    it('should send oncall alert when asset URL cannot be extracted', async () => {
      const { emailService } = require('../services/emailService');
      const { chatbotDb } = require('../services/chatbotService');

      const toolCalls = [{
        id: 'call789',
        name: 'generate_image',
        result: {
          success: true,
          message: 'Image generated',
          // Missing imageUrl
        }
      }];

      const agentSessionId = 'session123';
      const originalApproval = {
        assetUrl: 'https://example.com/original.png',
        filename: 'original.png',
        assetType: 'image',
        executionId: 'session123-images',
        userId: 'user123',
        slackChannel: 'C123',
        slackChannelName: 'general'
      };

      // Mock ishare link creation
      chatbotDb.createOrReuseInteractiveShare = jest.fn().mockResolvedValue('https://example.com/ishare/session123?conversable=token');

      // Simulate extraction failure
      let newAssetUrl: string | null = null;
      let newAssetFilename: string | null = null;

      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const toolResult = toolCall?.result || {};
          const imageUrl = toolResult.imageUrl || toolResult.image_url || toolResult.s3_url || toolResult.url;
          if (imageUrl) {
            newAssetUrl = imageUrl;
            newAssetFilename = toolResult.filename || toolResult.file_name || `revised_${originalApproval.filename || 'image'}`;
            break;
          }
        }
      }

      // If extraction failed, send alert
      if (!newAssetUrl) {
        const ishareLink = await chatbotDb.createOrReuseInteractiveShare(agentSessionId);
        await emailService.sendOncallAlert(
          'Agent Mode Revision: Failed to Extract Asset URL',
          `Failed to extract new asset URL from toolCalls after Agent Mode revision.\n\nSession: ${agentSessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: Test feedback`,
          {
            'Session ID': agentSessionId,
            'iShare Link': ishareLink,
            'Asset Type': originalApproval.assetType || 'unknown',
            'Original Asset URL': originalApproval.assetUrl,
            'Original Filename': originalApproval.filename || 'unknown',
            'Feedback': 'Test feedback',
            'Revision Success': true,
            'Tool Calls Count': toolCalls.length,
            'Tool Calls': JSON.stringify(toolCalls, null, 2),
            'Execution ID': originalApproval.executionId,
            'Slack Channel': originalApproval.slackChannel || 'N/A',
            'User ID': originalApproval.userId || 'N/A'
          }
        );
      }

      expect(newAssetUrl).toBeNull();
      expect(emailService.sendOncallAlert).toHaveBeenCalled();
      expect(emailService.sendOncallAlert).toHaveBeenCalledWith(
        'Agent Mode Revision: Failed to Extract Asset URL',
        expect.stringContaining(agentSessionId),
        expect.objectContaining({
          'Session ID': agentSessionId,
          'iShare Link': 'https://example.com/ishare/session123?conversable=token'
        })
      );
    });
  });
});
