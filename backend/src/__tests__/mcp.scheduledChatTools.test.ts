/**
 * Tests for scheduled chat MCP tools in apiTools.ts
 * Verifies tool registrations, HTTP call patterns, and Emma integration.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

describe('Scheduled Chat MCP Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const context = { userId: 'user-123', agentUserId: 'user-123' };

  // ─── FAIL tests: invalid inputs, boundary conditions, error paths ────

  describe('registration', () => {
    it('should register all 5 scheduled chat tools', () => {
      const names = mcpToolRegistry.getToolNames();
      expect(names).toContain('list_scheduled_chats');
      expect(names).toContain('manage_scheduled_chat');
      expect(names).toContain('test_scheduled_chat');
      expect(names).toContain('get_scheduled_chat_test_history');
      expect(names).toContain('submit_scheduled_chat_variables');
    });

    it('should expose scheduled chat tools to external MCP clients', () => {
      const externalDefs = mcpToolRegistry.getToolDefinitions();
      const externalNames = externalDefs.map((d: any) => d.name);
      expect(externalNames).toContain('list_scheduled_chats');
      expect(externalNames).toContain('manage_scheduled_chat');
      expect(externalNames).toContain('test_scheduled_chat');
      expect(externalNames).toContain('get_scheduled_chat_test_history');
      expect(externalNames).toContain('submit_scheduled_chat_variables');
    });
  });

  describe('manage_scheduled_chat - error paths', () => {
    it('should return error for unknown action', async () => {
      const result = await mcpToolRegistry.execute('manage_scheduled_chat', { action: 'bogus' }, context);
      expect(result.content[0].text).toContain('Unknown action');
    });

    it('should propagate HTTP errors from mcpFetch', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (403): Forbidden'));
      await expect(
        mcpToolRegistry.execute('list_scheduled_chats', {}, context)
      ).rejects.toThrow('API error (403): Forbidden');
    });

    it('should propagate errors on create', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (400): Missing required fields'));
      await expect(
        mcpToolRegistry.execute('manage_scheduled_chat', {
          action: 'create',
          schedule_name: 'Test',
          starting_message: 'Hello',
          schedule_frequency: 'daily',
        }, context)
      ).rejects.toThrow('API error (400)');
    });
  });

  // ─── Publish consent is NOT agent-settable (ENG-827, Greptile P1 #6) ────
  // Consent to publish unreviewed to a live account must come from a deterministic
  // owner action — the "Publish without my review" checkbox in the portal. An MCP
  // argument would let the MODEL mint standing publishing consent from its own
  // reading of a conversation, which is the same inferred-consent failure that
  // already sank three earlier signals. Keep this surface closed.
  describe('manage_scheduled_chat - publish consent is not agent-settable', () => {
    it('exposes only a REVOKE lever, never a grant, in the tool schema', () => {
      const def = mcpToolRegistry.getTool('manage_scheduled_chat')?.definition as any;
      const props = def?.inputSchema?.properties || {};
      expect(Object.keys(props)).toContain('revoke_autopublish');
      expect(Object.keys(props)).not.toContain('autopublish_authorized');
      // and the description must tell the model it cannot grant it
      expect(props.revoke_autopublish.description).toMatch(/cannot grant/i);
    });

    it('REVOKES consent when asked, sending autopublishAuthorized=false', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-1' });
      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'update',
        schedule_id: 'sc-1',
        revoke_autopublish: true,
      } as any, context);
      const body = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(body.autopublishAuthorized).toBe(false);
    });

    it('never sends a GRANT, whatever the model passes', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-1' });
      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'update',
        schedule_id: 'sc-1',
        revoke_autopublish: false,
        autopublish_authorized: true,
        autopublishAuthorized: true,
      } as any, context);
      const body = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(body.autopublishAuthorized).toBeUndefined();
    });

    it('never forwards an autopublish field to the API on create, even if passed', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-1' });
      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'create',
        schedule_name: 'Daily post',
        starting_message: 'Write and post it',
        schedule_frequency: 'daily',
        autopublish_authorized: true,
        autopublishAuthorized: true,
      } as any, context);
      const body = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(body).not.toHaveProperty('autopublishAuthorized');
      expect(body).not.toHaveProperty('autopublish_authorized');
    });

    it('never forwards an autopublish field to the API on update, even if passed', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-1' });
      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'update',
        schedule_id: 'sc-1',
        autopublish_authorized: true,
        autopublishAuthorized: true,
      } as any, context);
      const body = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(body).not.toHaveProperty('autopublishAuthorized');
      expect(body).not.toHaveProperty('autopublish_authorized');
    });
  });

  // ─── SUCCESS tests ─────────────────────────────────────────────────────

  describe('list_scheduled_chats', () => {
    it('should call GET /api/agent-mode/scheduled-chats', async () => {
      mockMcpFetch.mockResolvedValue([{ scheduleId: 'sc-1', scheduleName: 'Daily Report' }]);

      const result = await mcpToolRegistry.execute('list_scheduled_chats', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith({
        method: 'GET',
        path: '/api/agent-mode/scheduled-chats',
        context: { userId: 'user-123', agentUserId: 'user-123' },
      });
      expect(result.content[0].text).toContain('sc-1');
      expect(result.content[0].text).toContain('Daily Report');
    });
  });

  describe('manage_scheduled_chat - create', () => {
    it('should call POST /api/agent-mode/scheduled-chats with body', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-new', message: 'Created' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'create',
        schedule_name: 'Weekly Digest',
        starting_message: 'Generate weekly report',
        schedule_frequency: 'weekly',
        email_notifications: ['user@example.com'],
        keywords: ['report', 'metrics'],
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/agent-mode/scheduled-chats',
        body: expect.objectContaining({
          scheduleName: 'Weekly Digest',
          startingMessage: 'Generate weekly report',
          scheduleFrequency: 'weekly',
          emailNotifications: ['user@example.com'],
          keywords: ['report', 'metrics'],
        }),
      }));
    });

    it('should call POST /api/agent-mode/scheduled-chats without emailNotifications if omitted', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-new' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'create',
        schedule_name: 'No Email Chat',
        starting_message: 'Do not email me',
        schedule_frequency: 'daily',
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.emailNotifications).toBeUndefined();
    });


    it('should pass optional fields (run_count, variables, next_run_time) on create', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-new' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'create',
        schedule_name: 'Variable Chat',
        starting_message: 'Process {{data}}',
        schedule_frequency: 'daily',
        run_count: 5,
        next_run_time: '2026-03-15T09:00:00Z',
        variables: [{ name: 'data', description: 'Input data' }],
        variable_values: { data: 'test-value' },
        email_notifications: ['user@example.com'],
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.runCount).toBe(5);
      expect(callBody.nextRunTime).toBe('2026-03-15T09:00:00Z');
      expect(callBody.variables).toEqual([{ name: 'data', description: 'Input data' }]);
      expect(callBody.variableValues).toEqual({ data: 'test-value' });
    });

    it('maps self_improve to selfImprove on create and update', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-si' });
      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'create',
        schedule_name: 'Self Improving',
        starting_message: 'Do the thing',
        schedule_frequency: 'daily',
        email_notifications: ['user@example.com'],
        self_improve: true,
      }, context);
      expect((mockMcpFetch.mock.calls[0][0] as any).body.selfImprove).toBe(true);

      mockMcpFetch.mockClear();
      mockMcpFetch.mockResolvedValue({ message: 'Updated' });
      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'update',
        schedule_id: 'sc-si',
        self_improve: false,
      }, context);
      expect((mockMcpFetch.mock.calls[0][0] as any).body.selfImprove).toBe(false);
    });
  });

  describe('manage_scheduled_chat - create with every_n_days', () => {
    it('should pass frequencyIntervalDays on create with every_n_days', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-new' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'create',
        schedule_name: 'Every 3 Days Chat',
        starting_message: 'Run report',
        schedule_frequency: 'every_n_days',
        frequency_interval_days: 3,
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.scheduleFrequency).toBe('every_n_days');
      expect(callBody.frequencyIntervalDays).toBe(3);
    });

    it('should not pass frequencyIntervalDays when not provided', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: 'sc-new' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'create',
        schedule_name: 'Daily Chat',
        starting_message: 'Run report',
        schedule_frequency: 'daily',
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.frequencyIntervalDays).toBeUndefined();
    });
  });

  describe('manage_scheduled_chat - update', () => {
    it('should call PUT /api/agent-mode/scheduled-chats/:id with body', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Updated' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'update',
        schedule_id: 'sc-1',
        schedule_name: 'Updated Name',
        starting_message: 'New prompt',
        schedule_frequency: 'monthly',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PUT',
        path: '/api/agent-mode/scheduled-chats/sc-1',
        body: expect.objectContaining({
          scheduleName: 'Updated Name',
          startingMessage: 'New prompt',
          scheduleFrequency: 'monthly',
        }),
      }));
    });
  });

  describe('manage_scheduled_chat - update with every_n_days', () => {
    it('should pass frequencyIntervalDays on update with every_n_days', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Updated' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'update',
        schedule_id: 'sc-1',
        schedule_name: 'Every 5 Days',
        starting_message: 'New prompt',
        schedule_frequency: 'every_n_days',
        frequency_interval_days: 5,
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.scheduleFrequency).toBe('every_n_days');
      expect(callBody.frequencyIntervalDays).toBe(5);
    });
  });

  describe('manage_scheduled_chat - toggle', () => {
    it('should call PATCH /api/agent-mode/scheduled-chats/:id/toggle', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Paused' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'toggle',
        schedule_id: 'sc-1',
        status: 'paused',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PATCH',
        path: '/api/agent-mode/scheduled-chats/sc-1/toggle',
        body: { status: 'paused' },
      }));
    });
  });

  describe('manage_scheduled_chat - delete', () => {
    it('should call DELETE /api/agent-mode/scheduled-chats/:id', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Deleted' });

      await mcpToolRegistry.execute('manage_scheduled_chat', {
        action: 'delete',
        schedule_id: 'sc-1',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'DELETE',
        path: '/api/agent-mode/scheduled-chats/sc-1',
      }));
    });
  });

  describe('test_scheduled_chat', () => {
    it('should call POST /api/agent-mode/scheduled-chats/:id/test', async () => {
      mockMcpFetch.mockResolvedValue({ sessionId: 'sess-1', result: 'ok' });

      const result = await mcpToolRegistry.execute('test_scheduled_chat', {
        schedule_id: 'sc-1',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/agent-mode/scheduled-chats/sc-1/test',
        body: { sendNotificationEmail: false },
      }));
      expect(result.content[0].text).toContain('sess-1');
    });

    it('should pass send_notification_email flag', async () => {
      mockMcpFetch.mockResolvedValue({ sessionId: 'sess-1' });

      await mcpToolRegistry.execute('test_scheduled_chat', {
        schedule_id: 'sc-1',
        send_notification_email: true,
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.sendNotificationEmail).toBe(true);
    });
  });

  describe('get_scheduled_chat_test_history', () => {
    it('should call GET /api/agent-mode/scheduled-chats/:id/test-history', async () => {
      mockMcpFetch.mockResolvedValue([{ runId: 'run-1', status: 'completed' }]);

      const result = await mcpToolRegistry.execute('get_scheduled_chat_test_history', {
        schedule_id: 'sc-1',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith({
        method: 'GET',
        path: '/api/agent-mode/scheduled-chats/sc-1/test-history',
        context: { userId: 'user-123', agentUserId: 'user-123' },
      });
      expect(result.content[0].text).toContain('run-1');
    });

    it('should surface a diagnostic (not a bare empty array) when history is empty', async () => {
      mockMcpFetch.mockResolvedValue([]);

      const result = await mcpToolRegistry.execute('get_scheduled_chat_test_history', {
        schedule_id: 'sc-1',
      }, context);

      const text = result.content[0].text;
      // Must not be a bare empty array that the model reports as "empty results"
      expect(text.trim()).not.toBe('[]');
      // Must explain that the run may still be executing and to poll again
      expect(text.toLowerCase()).toContain('still');
      expect(text.toLowerCase()).toContain('poll');
      // Must instruct the model not to report an empty result as a finished run
      expect(text.toLowerCase()).toContain('do not');
    });
  });

  describe('submit_scheduled_chat_variables', () => {
    it('should call POST /api/agent-mode/scheduled-chats/:id/variables', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Variables submitted' });

      await mcpToolRegistry.execute('submit_scheduled_chat_variables', {
        schedule_id: 'sc-1',
        variable_values: { report_date: '2026-03-10', topic: 'sales' },
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/agent-mode/scheduled-chats/sc-1/variables',
        body: {
          variableValues: { report_date: '2026-03-10', topic: 'sales' },
          triggerRun: false,
        },
      }));
    });

    it('should pass trigger_run flag when specified', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Variables submitted and run triggered' });

      await mcpToolRegistry.execute('submit_scheduled_chat_variables', {
        schedule_id: 'sc-1',
        variable_values: { data: 'value' },
        trigger_run: true,
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.triggerRun).toBe(true);
    });
  });
});
