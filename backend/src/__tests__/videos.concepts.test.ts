import videosRoutes from '../routes/videos';

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-123', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

// Mock AnthropicBedrock
jest.mock('@anthropic-ai/bedrock-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(),
    },
  }));
});

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';

const mockBedrockInstance = {
  messages: {
    create: jest.fn(),
  },
};
(AnthropicBedrock as jest.MockedClass<typeof AnthropicBedrock>).mockImplementation(
  () => mockBedrockInstance as any
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getRouteHandler = (path: string, method: 'post' | 'get') => {
  const layer = (videosRoutes as any).stack.find((item: any) =>
    item.route && item.route.path === path && item.route.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
};

const mockResponse = () => {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockImplementation((payload: any) => { res.body = payload; return res; });
  return res;
};

const VALID_CONCEPTS_JSON = {
  concepts: [
    {
      title: 'Stop Wasting Time on Manual Tasks',
      framework: 'Problem-Agitate-Solution',
      hook: 'A frustrated marketer staring at spreadsheets at 2am',
      narrativeArc: 'Show the pain of manual work, then reveal AgentWeb automating everything',
      visualStyle: 'Cinematic, high contrast, moody to bright transition',
      veoPromptDirection: 'Close-up of stressed professional at glowing screen, dark office, neon blue light, cinematic depth of field, hyperrealistic 8K',
    },
    {
      title: 'Before vs After AgentWeb',
      framework: 'Before/After Transformation',
      hook: 'Split screen: chaos vs calm',
      narrativeArc: 'Left: overwhelmed team. Right: same team relaxed with AgentWeb running.',
      visualStyle: 'Split-screen, warm golden tones',
      veoPromptDirection: 'Wide shot of modern office, two scenes side by side, golden hour lighting, professional cinematic style',
    },
    {
      title: '10x Output, Same Team',
      framework: 'Social Proof / Results',
      hook: '"We tripled our output in 30 days" — real result on screen',
      narrativeArc: 'Lead with a bold metric, reveal the tool, show team celebrating',
      visualStyle: 'Bold, high-energy, fast cuts',
      veoPromptDirection: 'Drone shot over modern city skyline at sunset, bold confident mood, 8K photorealistic',
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /concepts', () => {
  const handler = getRouteHandler('/concepts', 'post');

  beforeEach(() => {
    jest.clearAllMocks();
    mockBedrockInstance.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(VALID_CONCEPTS_JSON) }],
    });
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it('returns 400 if platform is missing', async () => {
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { description: 'AI marketing platform' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/platform/i);
  });

  it('returns 400 if platform is invalid', async () => {
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { platform: 'snapchat', description: 'AI marketing platform' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/platform/i);
  });

  it('returns 400 if description is missing', async () => {
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { platform: 'linkedin' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('returns 400 if description is too short', async () => {
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { platform: 'linkedin', description: 'hi' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/description/i);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns 3 concepts for valid request', async () => {
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { platform: 'linkedin', description: 'AI marketing automation platform for SMBs' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(res.json).toHaveBeenCalled();
    expect(res.body.concepts).toHaveLength(3);
    expect(res.body.concepts[0]).toHaveProperty('title');
    expect(res.body.concepts[0]).toHaveProperty('framework');
    expect(res.body.concepts[0]).toHaveProperty('hook');
    expect(res.body.concepts[0]).toHaveProperty('narrativeArc');
    expect(res.body.concepts[0]).toHaveProperty('visualStyle');
    expect(res.body.concepts[0]).toHaveProperty('veoPromptDirection');
  });

  it('calls Bedrock with platform and description in the prompt', async () => {
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { platform: 'tiktok', description: 'A great SaaS product for marketers' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(mockBedrockInstance.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('TIKTOK'),
          }),
        ]),
      })
    );
  });

  it('includes brand data in prompt when provided', async () => {
    const req: any = {
      user: { userId: 'test-user-123' },
      body: {
        platform: 'instagram',
        description: 'A fitness app for busy professionals',
        brandData: { brandName: 'FitFlow', tagline: 'Move smarter', primaryColor: '#00ff00' },
      },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    const callArgs = mockBedrockInstance.messages.create.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).toContain('FitFlow');
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('returns 500 if Bedrock call fails', async () => {
    mockBedrockInstance.messages.create.mockRejectedValue(new Error('Bedrock unavailable'));
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { platform: 'youtube', description: 'A great product demo video' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBeDefined();
  });

  it('returns 500 if Bedrock returns malformed JSON', async () => {
    mockBedrockInstance.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'not valid json at all' }],
    });
    const req: any = {
      user: { userId: 'test-user-123' },
      body: { platform: 'tiktok', description: 'A great product for everyone' },
    };
    const res = mockResponse();
    await handler(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
