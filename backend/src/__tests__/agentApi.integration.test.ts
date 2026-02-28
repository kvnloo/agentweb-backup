/**
 * End-to-end integration test simulating an external AI agent (like OpenClaw,
 * Claude Desktop, AutoGPT) accessing Emma's tools via the Agent API.
 *
 * Flow:
 * 1. User generates an API key (JWT-authed)
 * 2. External agent uses key to discover tools
 * 3. External agent executes a tool
 * 4. Rate limiting kicks in when exceeded
 * 5. User revokes the key
 * 6. External agent is rejected with revoked key
 */

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

// ─── Mock DynamoDB as in-memory store ───

interface StoredItem {
  [key: string]: any;
}

const keyStore: Map<string, StoredItem> = new Map();

const mockPut = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const item = params.Item;
    keyStore.set(item.keyId, { ...item });
    return {};
  }),
}));

const mockGet = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const keyId = params.Key.keyId;
    const item = keyStore.get(keyId);
    return { Item: item || undefined };
  }),
}));

const mockQuery = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const items: StoredItem[] = [];
    if (params.IndexName === 'KeyHashIndex') {
      const targetHash = params.ExpressionAttributeValues[':keyHash'];
      for (const item of keyStore.values()) {
        if (item.keyHash === targetHash) items.push(item);
      }
    } else if (params.IndexName === 'UserIdIndex') {
      const targetUserId = params.ExpressionAttributeValues[':userId'];
      for (const item of keyStore.values()) {
        if (item.userId === targetUserId) items.push(item);
      }
    }
    return { Items: items };
  }),
}));

const mockUpdate = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const keyId = params.Key.keyId;
    const item = keyStore.get(keyId);
    if (!item) return {};

    // Parse simple SET expressions
    const expr = params.UpdateExpression || '';
    const values = params.ExpressionAttributeValues || {};

    if (expr.includes('#status')) {
      item.status = values[':status'];
    }
    if (expr.includes('lastUsedAt')) {
      item.lastUsedAt = values[':lastUsedAt'];
    }
    if (expr.includes('revokedAt')) {
      item.revokedAt = values[':revokedAt'];
    }

    keyStore.set(keyId, item);
    return {};
  }),
}));

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: (...args: any[]) => mockPut(...args),
        get: (...args: any[]) => mockGet(...args),
        query: (...args: any[]) => mockQuery(...args),
        update: (...args: any[]) => mockUpdate(...args),
      })),
    },
  },
}));

// ─── Mock JWT auth (simulates a logged-in user) ───

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user-harsha-123', email: 'harsha@agentweb.pro', isAdmin: false };
    next();
  },
}));

// ─── Mock the MCP tool registry with realistic Emma tools ───

jest.mock('../mcp/server/registry', () => {
  const tools = new Map([
    ['generate_blog_post', {
      name: 'generate_blog_post',
      definition: {
        name: 'generate_blog_post',
        description: 'Generate an SEO-optimized blog post on a given topic',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Blog topic' },
            tone: { type: 'string', description: 'Writing tone', enum: ['professional', 'casual', 'technical'] },
            wordCount: { type: 'number', description: 'Target word count' },
          },
          required: ['topic'],
        },
      },
      execute: async (args: any, context: any) => {
        if (!context?.userId) throw new Error('userId required in context');
        return {
          content: [{
            type: 'text',
            text: `# ${args.topic}\n\nGenerated blog post about "${args.topic}" in ${args.tone || 'professional'} tone for user ${context.userId}. Target: ${args.wordCount || 800} words.`,
          }],
        };
      },
    }],
    ['create_social_media_post', {
      name: 'create_social_media_post',
      definition: {
        name: 'create_social_media_post',
        description: 'Create a social media post for various platforms',
        inputSchema: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: ['twitter', 'linkedin', 'instagram'] },
            content: { type: 'string', description: 'Post content or topic' },
          },
          required: ['platform', 'content'],
        },
      },
      execute: async (args: any, context: any) => {
        return {
          content: [{
            type: 'text',
            text: `[${args.platform.toUpperCase()}] ${args.content} #marketing #AI`,
          }],
        };
      },
    }],
    ['analyze_competitors', {
      name: 'analyze_competitors',
      definition: {
        name: 'analyze_competitors',
        description: 'Analyze competitor websites and social presence',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Competitor URL' },
          },
          required: ['url'],
        },
      },
      execute: async (args: any) => {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              url: args.url,
              seoScore: 78,
              socialPresence: { twitter: 15000, linkedin: 8000 },
              topKeywords: ['marketing', 'automation', 'AI'],
            }, null, 2),
          }],
        };
      },
    }],
  ]);

  return {
    mcpToolRegistry: {
      getToolDefinitions: () => Array.from(tools.values()).map(t => t.definition),
      getToolNames: () => Array.from(tools.keys()),
      getTool: (name: string) => tools.get(name),
      execute: async (name: string, args: any, context: any) => {
        const handler = tools.get(name);
        if (!handler) throw new Error(`Tool ${name} not found`);
        return handler.execute(args, context);
      },
    },
  };
});

// ─── Import AFTER mocks ───

import agentApiRoutes from '../routes/agentApi';

// Build a minimal Express app with our routes
const app = express();
app.use(express.json());
app.use('/api/v1/agent', agentApiRoutes);

describe('Agent-to-Agent API Integration Test', () => {
  let rawApiKey: string;
  let keyId: string;

  beforeAll(() => {
    keyStore.clear();
  });

  afterAll(() => {
    keyStore.clear();
  });

  // ─── PHASE 1: User generates API key (like in the AgentWeb dashboard) ───

  describe('Phase 1: API Key Generation (User in AgentWeb Dashboard)', () => {
    it('should generate an API key for external agent use', async () => {
      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token') // mocked auth
        .send({
          keyName: 'OpenClaw Integration',
          scopes: ['tools:read', 'tools:execute'],
          rateLimitPerMin: 10, // low limit for testing
        });

      expect(res.status).toBe(201);
      expect(res.body.rawKey).toMatch(/^aw_/);
      expect(res.body.key.keyName).toBe('OpenClaw Integration');
      expect(res.body.key.status).toBe('active');
      expect(res.body.key.keyHash).toBeUndefined(); // hash not exposed

      rawApiKey = res.body.rawKey;
      keyId = res.body.key.keyId;

      console.log(`  ✓ API key generated: ${res.body.key.maskedKey}`);
      console.log(`  ✓ Key ID: ${keyId}`);
    });

    it('should list the user\'s API keys (masked)', async () => {
      const res = await request(app)
        .get('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token');

      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      expect(res.body.keys[0].keyName).toBe('OpenClaw Integration');
      expect(res.body.keys[0].maskedKey).toMatch(/^aw_\.\.\./);
      expect(res.body.keys[0].keyHash).toBeUndefined();

      console.log(`  ✓ Listed ${res.body.keys.length} key(s) for user`);
    });
  });

  // ─── PHASE 2: External agent discovers tools ───

  describe('Phase 2: Tool Discovery (External Agent like OpenClaw)', () => {
    it('should list all available Emma tools using the API key', async () => {
      const res = await request(app)
        .get('/api/v1/agent/tools')
        .set('Authorization', `Bearer ${rawApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.tools).toHaveLength(3);

      const toolNames = res.body.tools.map((t: any) => t.name);
      expect(toolNames).toContain('generate_blog_post');
      expect(toolNames).toContain('create_social_media_post');
      expect(toolNames).toContain('analyze_competitors');

      // Check tool has proper schema
      const blogTool = res.body.tools.find((t: any) => t.name === 'generate_blog_post');
      expect(blogTool.inputSchema.properties.topic).toBeDefined();

      // Verify rate limit headers
      expect(res.headers['x-ratelimit-limit']).toBe('10');
      expect(parseInt(res.headers['x-ratelimit-remaining'])).toBeLessThanOrEqual(10);

      console.log(`  ✓ Discovered ${res.body.tools.length} tools: ${toolNames.join(', ')}`);
    });
  });

  // ─── PHASE 3: External agent executes tools ───

  describe('Phase 3: Tool Execution (External Agent calls Emma\'s tools)', () => {
    it('should execute generate_blog_post tool', async () => {
      const res = await request(app)
        .post('/api/v1/agent/tools/execute')
        .set('Authorization', `Bearer ${rawApiKey}`)
        .send({
          toolName: 'generate_blog_post',
          args: {
            topic: 'How AI is Transforming B2B Marketing',
            tone: 'professional',
            wordCount: 1200,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.executionTimeMs).toBeGreaterThanOrEqual(0);

      const text = res.body.result.content[0].text;
      expect(text).toContain('How AI is Transforming B2B Marketing');
      expect(text).toContain('user-harsha-123'); // userId from API key is injected

      console.log(`  ✓ Blog generated in ${res.body.executionTimeMs}ms`);
      console.log(`  ✓ User context injected: userId=user-harsha-123`);
    });

    it('should execute create_social_media_post tool', async () => {
      const res = await request(app)
        .post('/api/v1/agent/tools/execute')
        .set('Authorization', `Bearer ${rawApiKey}`)
        .send({
          toolName: 'create_social_media_post',
          args: {
            platform: 'linkedin',
            content: 'Excited to share our latest AI marketing insights',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result.content[0].text).toContain('LINKEDIN');

      console.log(`  ✓ Social media post created`);
    });

    it('should execute analyze_competitors tool and get structured data', async () => {
      const res = await request(app)
        .post('/api/v1/agent/tools/execute')
        .set('Authorization', `Bearer ${rawApiKey}`)
        .send({
          toolName: 'analyze_competitors',
          args: { url: 'https://competitor.com' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = JSON.parse(res.body.result.content[0].text);
      expect(data.seoScore).toBe(78);
      expect(data.topKeywords).toContain('AI');

      console.log(`  ✓ Competitor analysis returned structured data`);
    });

    it('should return error for non-existent tool', async () => {
      const res = await request(app)
        .post('/api/v1/agent/tools/execute')
        .set('Authorization', `Bearer ${rawApiKey}`)
        .send({
          toolName: 'nonexistent_tool',
          args: {},
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');

      console.log(`  ✓ Non-existent tool correctly returned error`);
    });
  });

  // ─── PHASE 4: Create agent session ───

  describe('Phase 4: Session Management', () => {
    it('should create an agent session', async () => {
      const res = await request(app)
        .post('/api/v1/agent/sessions')
        .set('Authorization', `Bearer ${rawApiKey}`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.sessionId).toBeDefined();
      expect(res.body.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );

      console.log(`  ✓ Agent session created: ${res.body.sessionId}`);
    });
  });

  // ─── PHASE 5: Rate limiting ───

  describe('Phase 5: Rate Limiting', () => {
    it('should enforce rate limits and return 429 when exceeded', async () => {
      // We set rateLimitPerMin=10 when creating the key
      // We've already used ~6 requests above, so let's burn through the rest
      let lastStatus = 200;
      let requestCount = 0;

      // Keep hitting until we get 429 or exhaust attempts
      for (let i = 0; i < 15; i++) {
        const res = await request(app)
          .get('/api/v1/agent/tools')
          .set('Authorization', `Bearer ${rawApiKey}`);

        lastStatus = res.status;
        requestCount++;

        if (res.status === 429) {
          expect(res.body.error).toContain('Rate limit');
          expect(res.body.retryAfterMs).toBeGreaterThan(0);
          expect(res.headers['x-ratelimit-remaining']).toBe('0');
          console.log(`  ✓ Rate limit hit after ${requestCount} requests in this test`);
          console.log(`  ✓ Retry after: ${res.body.retryAfterMs}ms`);
          break;
        }
      }

      expect(lastStatus).toBe(429);
    });
  });

  // ─── PHASE 6: Auth error cases ───

  describe('Phase 6: Authentication & Authorization', () => {
    it('should reject requests with no API key', async () => {
      const res = await request(app).get('/api/v1/agent/tools');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Missing');

      console.log(`  ✓ No-key request rejected with 401`);
    });

    it('should reject requests with invalid API key', async () => {
      const res = await request(app)
        .get('/api/v1/agent/tools')
        .set('Authorization', 'Bearer aw_invalidfakekey123');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid');

      console.log(`  ✓ Invalid key rejected with 401`);
    });

    it('should reject non-aw_ tokens', async () => {
      const res = await request(app)
        .get('/api/v1/agent/tools')
        .set('Authorization', 'Bearer some-random-jwt-token');

      expect(res.status).toBe(401);

      console.log(`  ✓ Non-aw_ token rejected`);
    });
  });

  // ─── PHASE 7: Key revocation ───

  describe('Phase 7: Key Revocation (User revokes access)', () => {
    it('should revoke the API key', async () => {
      const res = await request(app)
        .delete(`/api/v1/agent/api-keys/${keyId}`)
        .set('Authorization', 'Bearer fake-jwt-token');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('revoked');

      console.log(`  ✓ API key ${keyId} revoked`);
    });

    it('should reject tool requests with revoked key', async () => {
      const res = await request(app)
        .get('/api/v1/agent/tools')
        .set('Authorization', `Bearer ${rawApiKey}`);

      expect(res.status).toBe(401);

      console.log(`  ✓ Revoked key correctly rejected`);
    });

    it('should reject tool execution with revoked key', async () => {
      const res = await request(app)
        .post('/api/v1/agent/tools/execute')
        .set('Authorization', `Bearer ${rawApiKey}`)
        .send({
          toolName: 'generate_blog_post',
          args: { topic: 'Should not work' },
        });

      expect(res.status).toBe(401);

      console.log(`  ✓ Tool execution with revoked key rejected`);
    });
  });
});
