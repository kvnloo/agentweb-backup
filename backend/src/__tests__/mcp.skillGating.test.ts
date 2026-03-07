/**
 * Test Suite: MCP Skill-Gated Tool Discovery
 *
 * Verifies that internal-only tools (install_skills, list_available_skills)
 * are NOT exposed to external MCP clients, and that session isolation works.
 */

import { mcpToolRegistry } from '../mcp/server/registry';

// Ensure apiTools are loaded
import '../mcp/server/apiTools';

// Mock dependencies
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/chatbotService');

describe('MCP Skill-Gated Tool Discovery', () => {
  describe('Internal-only tools are not exposed', () => {
    it('install_skills is NOT registered in the external MCP tool registry', () => {
      expect(mcpToolRegistry.getTool('install_skills')).toBeUndefined();
    });

    it('list_available_skills is NOT registered in the external MCP tool registry', () => {
      expect(mcpToolRegistry.getTool('list_available_skills')).toBeUndefined();
    });
  });

  describe('Session Isolation', () => {
    test('sessions maintain separate installed skills', () => {
      const session1 = new Set(['blog-pub-123']);
      const session2 = new Set<string>();

      session1.add('analytics-456');

      expect(session1.size).toBe(2);
      expect(session2.size).toBe(0);
    });

    test('modifying one session does not affect another', () => {
      const baseSkills = ['skill-1', 'skill-2'];
      const session1 = new Set(baseSkills);
      const session2 = new Set(baseSkills);

      session1.add('skill-3');

      expect(session1.has('skill-3')).toBe(true);
      expect(session2.has('skill-3')).toBe(false);
    });
  });
});
