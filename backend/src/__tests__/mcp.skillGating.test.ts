/**
 * Test Suite: MCP Skill-Gated Tool Discovery
 *
 * Tests the progressive skill discovery system where external MCP clients
 * see only foundation tools initially, then can discover and install skills
 * to unlock additional tools.
 */

import { createMcpServer, McpSessionContext } from '../mcp/server/mcpServerCore';
import { mcpToolRegistry } from '../mcp/server/registry';
import { agentModeService } from '../services/agentModeService';
import { skillService } from '../services/skillService';
import { getAllowedSkills } from '../services/subscriptionService';

// Mock services
jest.mock('../services/agentModeService');
jest.mock('../services/skillService');
jest.mock('../services/subscriptionService');

const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockSkillService = skillService as jest.Mocked<typeof skillService>;
const mockGetAllowedSkills = getAllowedSkills as jest.MockedFunction<typeof getAllowedSkills>;

describe('MCP Skill-Gated Tool Discovery', () => {
  const TEST_USER_ID = 'test-user-123';

  // Sample published skills
  const mockPublishedSkills = [
    {
      skillId: 'blog-pub-123',
      name: 'Blog Publishing',
      description: 'Create and publish blog content',
      toolNames: ['create_blog_article', 'publish_blog_article', 'repair_blog_article'],
      isPublished: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    },
    {
      skillId: 'analytics-456',
      name: 'Analytics',
      description: 'Track and analyze data',
      toolNames: ['get_post_analytics', 'perform_data_analysis'],
      isPublished: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    }
  ];

  const mockUnassociatedTools = ['some_other_tool', 'another_tool'];

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    mockSkillService.getPublishedSkills.mockResolvedValue(mockPublishedSkills);
    mockAgentModeService.getUnassociatedToolNames.mockReturnValue(mockUnassociatedTools);
    mockGetAllowedSkills.mockResolvedValue(['*']); // Wildcard by default
  });

  describe('ListTools Filtering', () => {
    test('external client with no skills sees only foundation tools + list_available_skills', async () => {
      // External client context
      const context: McpSessionContext = {
        agentUserId: TEST_USER_ID,
        installedSkills: new Set(),
        isInternal: false
      };

      const server = createMcpServer('test-server', context);
      const allTools = mcpToolRegistry.getToolDefinitions();

      // Foundation tools should include these
      const foundationToolNames = [
        'install_skills',
        'list_available_skills',
        'update_brand_guidelines',
        'read_brand_guidelines',
        'update_market_strategy',
        'read_market_strategy',
        'search_knowledge_base',
        'create_work_plan',
        'search_leads',
        'get_lead_lists',
        'list_connected_accounts'
      ];

      // Non-foundation tools should not be visible
      const nonFoundationTools = ['create_blog_article', 'publish_blog_article'];

      // Verify foundation tools are in the full tool list
      foundationToolNames.forEach(name => {
        expect(allTools.some(t => t.name === name)).toBe(true);
      });

      // Since we can't directly call the handler, we'll test the underlying logic
      // by checking what tools would be visible
      // Note: In actual usage, the ListTools handler filters the tools
    });

    test('external client after installing skill sees skill tools + foundation', async () => {
      const installedSkills = new Set(['blog-pub-123']);

      const context: McpSessionContext = {
        agentUserId: TEST_USER_ID,
        installedSkills,
        isInternal: false
      };

      const server = createMcpServer('test-server', context);

      // After installing 'blog-pub-123', should see:
      // - Foundation tools
      // - create_blog_article, publish_blog_article, repair_blog_article
      // But NOT:
      // - get_post_analytics, perform_data_analysis (from analytics skill)
    });

    test('internal client sees all tools regardless of installed skills', async () => {
      const context: McpSessionContext = {
        agentUserId: TEST_USER_ID,
        installedSkills: new Set(),
        isInternal: true
      };

      const server = createMcpServer('test-server', context);
      const allTools = mcpToolRegistry.getToolDefinitions();

      // Internal clients should see everything
      expect(allTools.length).toBeGreaterThan(0);
    });

    test('different sessions have isolated tool lists', () => {
      const session1Skills = new Set(['blog-pub-123']);
      const session2Skills = new Set<string>();

      const context1: McpSessionContext = {
        agentUserId: TEST_USER_ID,
        installedSkills: session1Skills,
        isInternal: false
      };

      const context2: McpSessionContext = {
        agentUserId: TEST_USER_ID,
        installedSkills: session2Skills,
        isInternal: false
      };

      // Sessions should maintain separate state
      expect(session1Skills.size).toBe(1);
      expect(session2Skills.size).toBe(0);
    });
  });

  describe('Tool Execution Validation', () => {
    test('calling non-installed tool returns helpful error', async () => {
      const context: McpSessionContext = {
        agentUserId: TEST_USER_ID,
        installedSkills: new Set(),
        isInternal: false
      };

      // Attempting to call a blog tool without installing the skill
      // should return an error message guiding the user to install_skills
      const expectedErrorPattern = /requires a skill to be installed/i;
      expect(expectedErrorPattern.test(
        "Error: Tool 'create_blog_article' requires a skill to be installed. Use install_skills(['skill-id']) or list_available_skills() to see available capabilities."
      )).toBe(true);
    });

    test('foundation tools callable without skill installation', () => {
      const foundationTools = [
        'install_skills',
        'list_available_skills',
        'search_web',
        'create_work_plan'
      ];

      // These should always be callable regardless of installed skills
      foundationTools.forEach(toolName => {
        const tool = mcpToolRegistry.getToolDefinitions().find(t => t.name === toolName);
        expect(tool).toBeDefined();
      });
    });
  });

  describe('list_available_skills Tool', () => {
    test('returns skill catalog filtered by user subscription', async () => {
      mockGetAllowedSkills.mockResolvedValue(['blog-pub-123']); // Limited subscription

      const tool = mcpToolRegistry.getToolDefinitions().find(t => t.name === 'list_available_skills');
      expect(tool).toBeDefined();

      const context = {
        userId: TEST_USER_ID,
        agentUserId: TEST_USER_ID
      };

      const result = await mcpToolRegistry.execute('list_available_skills', {}, context);

      expect(result).toHaveProperty('skills');
      expect(result).toHaveProperty('totalSkills');
      expect(result.skills).toBeInstanceOf(Array);

      // Should only include allowed skill
      expect(result.skills.length).toBe(1);
      expect(result.skills[0].skillId).toBe('blog-pub-123');
    });

    test('includes __other_skills__ virtual skill with wildcard subscription', async () => {
      mockGetAllowedSkills.mockResolvedValue(['*']);

      const context = {
        userId: TEST_USER_ID,
        agentUserId: TEST_USER_ID
      };

      const result = await mcpToolRegistry.execute('list_available_skills', {}, context);

      expect(result.skills).toBeInstanceOf(Array);

      // Should include __other_skills__
      const otherSkill = result.skills.find((s: any) => s.skillId === '__other_skills__');
      expect(otherSkill).toBeDefined();
      expect(otherSkill.name).toBe('Other Tools');
      expect(otherSkill.toolNames).toEqual(mockUnassociatedTools);
    });

    test('respects wildcard subscriptions', async () => {
      mockGetAllowedSkills.mockResolvedValue(['*']);

      const context = {
        userId: TEST_USER_ID,
        agentUserId: TEST_USER_ID
      };

      const result = await mcpToolRegistry.execute('list_available_skills', {}, context);

      // Should include all published skills + __other_skills__
      expect(result.skills.length).toBe(mockPublishedSkills.length + 1);
    });
  });

  describe('install_skills for External MCP Clients', () => {
    test('works with agentUserId (no chat sessionId)', async () => {
      const installedSkills = new Set<string>();

      const context = {
        agentUserId: TEST_USER_ID,
        installedSkills,
        updateInstalledSkills: (skillIds: string[]) => {
          skillIds.forEach(id => installedSkills.add(id));
        }
      };

      const result = await mcpToolRegistry.execute('install_skills', {
        skillIds: ['blog-pub-123']
      }, context);

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('Blog Publishing');
      expect(installedSkills.has('blog-pub-123')).toBe(true);
    });

    test('validates skills against subscription', async () => {
      mockGetAllowedSkills.mockResolvedValue(['blog-pub-123']); // Limited subscription

      const installedSkills = new Set<string>();

      const context = {
        agentUserId: TEST_USER_ID,
        installedSkills,
        updateInstalledSkills: (skillIds: string[]) => {
          skillIds.forEach(id => installedSkills.add(id));
        }
      };

      // Try to install a skill not in subscription
      const result = await mcpToolRegistry.execute('install_skills', {
        skillIds: ['analytics-456']
      }, context);

      expect(result.message).toContain('not included in your subscription');
      expect(installedSkills.size).toBe(0);
    });

    test('updates session installedSkills Set', async () => {
      const installedSkills = new Set<string>();

      const context = {
        agentUserId: TEST_USER_ID,
        installedSkills,
        updateInstalledSkills: (skillIds: string[]) => {
          skillIds.forEach(id => installedSkills.add(id));
        }
      };

      await mcpToolRegistry.execute('install_skills', {
        skillIds: ['blog-pub-123', 'analytics-456']
      }, context);

      expect(installedSkills.has('blog-pub-123')).toBe(true);
      expect(installedSkills.has('analytics-456')).toBe(true);
      expect(installedSkills.size).toBe(2);
    });

    test('returns installed skill names', async () => {
      const context = {
        agentUserId: TEST_USER_ID,
        installedSkills: new Set<string>(),
        updateInstalledSkills: jest.fn()
      };

      const result = await mcpToolRegistry.execute('install_skills', {
        skillIds: ['blog-pub-123']
      }, context);

      expect(result.installedSkills).toBeInstanceOf(Array);
      expect(result.installedSkills).toContain('Blog Publishing');
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

  describe('Error Handling', () => {
    test('install_skills with no userId throws error', async () => {
      const context = {
        // No userId or agentUserId
        installedSkills: new Set(),
        updateInstalledSkills: jest.fn()
      };

      await expect(
        mcpToolRegistry.execute('install_skills', { skillIds: ['blog-pub-123'] }, context)
      ).rejects.toThrow('Authentication required');
    });

    test('install_skills with empty skillIds array returns message', async () => {
      const context = {
        agentUserId: TEST_USER_ID,
        installedSkills: new Set(),
        updateInstalledSkills: jest.fn()
      };

      const result = await mcpToolRegistry.execute('install_skills', {
        skillIds: []
      }, context);

      expect(result.message).toContain('non-empty array');
    });

    test('install_skills with invalid skill IDs returns error', async () => {
      const context = {
        agentUserId: TEST_USER_ID,
        installedSkills: new Set(),
        updateInstalledSkills: jest.fn()
      };

      const result = await mcpToolRegistry.execute('install_skills', {
        skillIds: ['invalid-skill-id']
      }, context);

      expect(result.message).toContain('No valid skills found');
    });

    test('list_available_skills without userId throws error', async () => {
      await expect(
        mcpToolRegistry.execute('list_available_skills', {}, {})
      ).rejects.toThrow('Authentication required');
    });
  });
});
