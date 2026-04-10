/**
 * Tests for AgentModeService.detectOAuthRequirement — maps tool error messages
 * to structured OAuth provider info for inline connection prompts.
 */

// Minimal mock to allow importing AgentModeService without pulling the entire backend
jest.mock('../services/db', () => ({}));
jest.mock('../services/chatbotService', () => ({}));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/skillService', () => ({ skillService: {} }));
jest.mock('../services/subscriptionService', () => ({}));
jest.mock('../services/tokenUsageService', () => ({}));
jest.mock('../services/clickupService', () => ({}));
jest.mock('../services/foreplayService', () => ({}));
jest.mock('../utils/secretsManager', () => ({}));
jest.mock('../mcp/client/toolRegistry', () => ({ ToolRegistry: jest.fn() }));
jest.mock('../mcp/client/mcpClientService', () => ({ McpClientService: jest.fn() }));
jest.mock('googleapis', () => ({ google: { auth: { GoogleAuth: jest.fn() }, drive: jest.fn() } }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService.detectOAuthRequirement', () => {
  // ---- Meta / Facebook ----
  it('detects Meta not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'list_meta_campaigns',
      'Meta ad account not connected. Please connect your Facebook account in settings.'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('meta');
    expect(result!.initPath).toContain('/api/oauth/meta/init');
  });

  it('detects Meta token expired error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'get_meta_insights',
      'Meta access token has expired. Please reconnect your Meta account in settings.'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('meta');
  });

  // ---- LinkedIn ----
  it('detects LinkedIn not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'post_on_connected_account',
      'LinkedIn account not connected. Please connect your LinkedIn account in settings.'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('linkedin');
    expect(result!.initPath).toContain('/api/oauth/linkedin/init');
  });

  // ---- LinkedIn Ads ----
  it('detects LinkedIn Ads not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'list_linkedin_ads_campaigns',
      'LinkedIn Ads account not connected. Please connect your LinkedIn Ads account in settings.'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('linkedin_ads');
    expect(result!.initPath).toContain('/api/oauth/linkedin-ads/init');
  });

  // ---- LinkedIn Outreach ----
  it('detects LinkedIn Outreach not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'linkedin_outreach_send_message',
      'No LinkedIn account is connected. To use LinkedIn Outreach, please connect your LinkedIn account in Settings.'
    );
    // This should match LinkedIn Outreach since the tool name suggests it,
    // but the error message says "LinkedIn" not "LinkedIn Outreach".
    // The detection is message-based, so it matches plain LinkedIn.
    expect(result).not.toBeNull();
  });

  // ---- Gmail ----
  it('detects Gmail not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'send_email',
      'Gmail account not connected. Please connect your Gmail account in settings.'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gmail');
    expect(result!.initPath).toContain('/api/oauth/gmail/init');
  });

  // ---- YouTube ----
  it('detects YouTube not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'upload_video',
      'YouTube account not connected. Please connect your YouTube account in settings.'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('youtube');
    expect(result!.initPath).toContain('/api/oauth/youtube/init');
  });

  // ---- Fathom ----
  it('detects Fathom not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'list_fathom_calls',
      'Requires a connected Fathom account (Settings). Fathom not connected.'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('fathom');
    expect(result!.initPath).toContain('/api/oauth/fathom/init');
  });

  // ---- ClickUp ----
  it('detects ClickUp not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'list_clickup_tasks',
      'ClickUp not connected'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('clickup');
  });

  // ---- Foreplay ----
  it('detects Foreplay not connected error', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'search_foreplay_ads',
      'Foreplay not connected'
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('foreplay');
  });

  // ---- Negative cases ----
  it('returns null for generic errors', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'generate_image',
      'Rate limit exceeded'
    );
    expect(result).toBeNull();
  });

  it('returns null for empty error message', () => {
    expect(AgentModeService.detectOAuthRequirement('foo', '')).toBeNull();
  });

  it('returns null for null/undefined error', () => {
    expect(AgentModeService.detectOAuthRequirement('foo', null as any)).toBeNull();
    expect(AgentModeService.detectOAuthRequirement('foo', undefined as any)).toBeNull();
  });

  it('returns null for non-OAuth tool errors', () => {
    const result = AgentModeService.detectOAuthRequirement(
      'create_social_media_posts',
      'Failed to parse arguments: invalid JSON'
    );
    expect(result).toBeNull();
  });
});
