/**
 * Tests for POST /api/crm/lists/:listId/leads/:leadId/draft-invite-note
 *
 * Focus: the drafted note must be smart-trimmed to the account's invite char limit
 * on a WORD BOUNDARY (surrogate-safe), the same mechanism sendInvitation() uses — not
 * a crude mid-word .slice(). This keeps all invite-note paths consistent so the agent
 * never has to retry an over-limit note (the original bug).
 */

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(), getTemplates: jest.fn(), getTemplate: jest.fn(),
  updateTemplate: jest.fn(), deleteTemplate: jest.fn(), publishTemplate: jest.fn(),
}));

const mockGetLeadListById = jest.fn();
const mockGetLeadById = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
    getLeadById: (...args: any[]) => mockGetLeadById(...args),
    getLeadsByListId: jest.fn().mockResolvedValue({ leads: [] }),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockResolveUserOwnedAccountId = jest.fn();
const mockGetInviteCharLimitForAccount = jest.fn();

// Keep the REAL LinkedInOutreachService class (so trimInviteMessage is the real
// implementation), but stub the singleton's network-touching methods.
jest.mock('../services/linkedInOutreachService', () => {
  const actual = jest.requireActual('../services/linkedInOutreachService');
  return {
    LinkedInOutreachService: actual.LinkedInOutreachService,
    linkedInOutreachService: {
      resolveUserOwnedAccountId: (...args: any[]) => mockResolveUserOwnedAccountId(...args),
      getInviteCharLimitForAccount: (...args: any[]) => mockGetInviteCharLimitForAccount(...args),
    },
  };
});

const mockGeminiCreate = jest.fn();
const mockReadBrandGuidelines = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    readBrandGuidelines: (...args: any[]) => mockReadBrandGuidelines(...args),
    getGeminiClient: jest.fn().mockResolvedValue({
      chat: { completions: { create: (...args: any[]) => mockGeminiCreate(...args) } },
    }),
    callLLM: (model: string, messages: unknown[], options: Record<string, unknown>) =>
      mockGeminiCreate({ model, messages, ...options }),
  },
}));

jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

import router from '../routes/crm';

const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method],
  );
  return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle;
};

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('POST draft-invite-note — smart-trim to account limit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLeadListById.mockResolvedValue({ id: 'list-1', userId: 'test-user-id' });
    mockGetLeadById.mockResolvedValue({ firstName: 'Fang', lastName: 'Tan', title: 'Head of Growth', company: 'Acme' });
    mockResolveUserOwnedAccountId.mockResolvedValue('acct-1');
    mockReadBrandGuidelines.mockResolvedValue({ exists: false, content: '' });
  });

  const handler = () => findHandler(router, '/lists/:listId/leads/:leadId/draft-invite-note', 'post');

  const callRoute = async () => {
    const req: any = { params: { listId: 'list-1', leadId: 'lead-1' }, body: {}, user: { userId: 'test-user-id' } };
    const res = makeRes();
    await handler()(req, res);
    return res;
  };

  it('word-boundary trims an over-limit (free 200) note instead of cutting mid-word', async () => {
    // 60 words → well over 200 chars. Every word is "growthN".
    const longNote = Array.from({ length: 60 }, (_, i) => `growth${i}`).join(' ');
    expect(longNote.length).toBeGreaterThan(200);
    mockGetInviteCharLimitForAccount.mockResolvedValue(200);
    mockGeminiCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ content: longNote }) } }] });

    const res = await callRoute();
    const body = res.json.mock.calls[0][0];
    expect(body.content.length).toBeLessThanOrEqual(200);
    // Prefix of the original (no mangling) and no partial trailing token.
    expect(longNote.startsWith(body.content)).toBe(true);
    expect(body.content.endsWith(' ')).toBe(false);
    // A whole word was dropped, so the trimmed note is shorter than a raw 200-cut
    // would be unless the cut happened to land on a space.
    expect(longNote.slice(0, 200).startsWith(body.content)).toBe(true);
  });

  it('respects the Premium 300 limit', async () => {
    const longNote = 'a'.repeat(350);
    mockGetInviteCharLimitForAccount.mockResolvedValue(300);
    mockGeminiCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ content: longNote }) } }] });

    const res = await callRoute();
    const body = res.json.mock.calls[0][0];
    expect(body.content.length).toBe(300);
  });

  it('leaves an under-limit note unchanged', async () => {
    const shortNote = 'Fang, your activation-funnel work at Acme is sharp.';
    mockGetInviteCharLimitForAccount.mockResolvedValue(200);
    mockGeminiCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ content: shortNote }) } }] });

    const res = await callRoute();
    const body = res.json.mock.calls[0][0];
    expect(body.content).toBe(shortNote);
  });

  it('re-generates a shorter note when the first draft is over the limit, then returns it', async () => {
    const longNote = 'x'.repeat(260);
    const reworked = 'Fang, your funnel work at Acme is sharp — keeping this one tight.';
    expect(reworked.length).toBeLessThanOrEqual(200);
    mockGetInviteCharLimitForAccount.mockResolvedValue(200);
    // 1st call = the original (over-limit) draft; 2nd call = the capped re-gen (fits).
    mockGeminiCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ content: longNote }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ content: reworked }) } }] });

    const res = await callRoute();
    const body = res.json.mock.calls[0][0];
    expect(mockGeminiCreate).toHaveBeenCalledTimes(2); // 1 draft + 1 re-gen
    expect(body.content).toBe(reworked);
  });

  it('hard-trims when the capped re-gen still cannot get under the limit', async () => {
    const longNote = 'word '.repeat(80).trim(); // ~399 chars, well over 200
    expect(longNote.length).toBeGreaterThan(200);
    mockGetInviteCharLimitForAccount.mockResolvedValue(200);
    // Draft + both re-gen attempts all stay over the limit → caller falls back to trim.
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ content: longNote }) } }],
    });

    const res = await callRoute();
    const body = res.json.mock.calls[0][0];
    expect(mockGeminiCreate).toHaveBeenCalledTimes(3); // 1 draft + 2 capped re-gen attempts
    expect(body.content.length).toBeLessThanOrEqual(200);
    expect(longNote.startsWith(body.content)).toBe(true);
  });

  it('returns 500 when the note trims to empty (whitespace-only over-limit draft)', async () => {
    // A non-empty but all-whitespace over-limit note passes the raw-note guard, gets a
    // re-gen attempt, then trims down to '' — the final empty-content guard must 500.
    const whitespaceNote = ' '.repeat(260);
    mockGetInviteCharLimitForAccount.mockResolvedValue(200);
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ content: whitespaceNote }) } }],
    });

    const res = await callRoute();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Failed to generate invite note' });
  });
});

describe('POST draft-invite-note — sender brand reaches the prompt (ENG-2967)', () => {
  // Real readBrandGuidelines() success shape (emma/impl/brandMarketStrategy.ts):
  // { success, message, exists, brandData, attachments, createdAt, updatedAt,
  // formattedContent } — NO `.content` field. brandData fields are the ones
  // declared on User.brandGuidelines.brandData in services/db.ts.
  const realShapedGuidelines = {
    success: true,
    message: 'Brand guidelines retrieved successfully',
    exists: true,
    brandData: {
      brandName: 'Acme Isolation',
      tagline: 'Browser isolation for mid-market security teams',
      valueProposition: 'Stops shadow-IT data leaks without blocking employees.',
      domain: 'acme.example',
      primaryColor: '#FF0000',
      primaryColorEnd: '#00FF00',
      secondaryColor: '#123456',
      fontFamily: 'Inter',
      toneOfVoice: 'Warm, concise, founder-led',
      keyMessages: ['No agents to install', 'Deploys in a day'],
      brandValues: ['Transparency'],
      targetAudience: 'CISOs',
      brandPersonality: 'Pragmatic',
      isGradient: true,
      founders: [],
    },
    attachments: [{ type: 'logo', url: 'https://cdn.example.com/logo.png', key: 'k', filename: 'logo.png' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    formattedContent: '<strong>🎨 Brand Guidelines Retrieved</strong><br>Primary Color: #FF0000<br>Font: Inter',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLeadListById.mockResolvedValue({ id: 'list-1', userId: 'test-user-id' });
    mockGetLeadById.mockResolvedValue({ firstName: 'Fang', lastName: 'Tan', title: 'Head of Growth', company: 'Acme' });
    mockResolveUserOwnedAccountId.mockResolvedValue('acct-1');
    mockGetInviteCharLimitForAccount.mockResolvedValue(200);
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ content: 'Fang, your funnel work at Acme is sharp.' }) } }],
    });
  });

  const callRoute = async () => {
    const handler = findHandler(router, '/lists/:listId/leads/:leadId/draft-invite-note', 'post');
    const req: any = { params: { listId: 'list-1', leadId: 'lead-1' }, body: {}, user: { userId: 'test-user-id' } };
    const res = makeRes();
    await handler(req, res);
    return res;
  };

  const promptSentToLLM = (): string => {
    expect(mockGeminiCreate).toHaveBeenCalled();
    const { messages } = mockGeminiCreate.mock.calls[0][0];
    return String(messages[0].content);
  };

  it('puts the structured brand block (offer, value prop, key messages, voice) in the LLM prompt', async () => {
    mockReadBrandGuidelines.mockResolvedValue(realShapedGuidelines);

    const res = await callRoute();
    expect(res.status).not.toHaveBeenCalled();
    expect(mockReadBrandGuidelines).toHaveBeenCalledWith('test-user-id');

    const prompt = promptSentToLLM();
    expect(prompt).toContain('Sender context (who is writing — do not pitch):');
    expect(prompt).toContain('Brand: Acme Isolation');
    expect(prompt).toContain('What we offer: Browser isolation for mid-market security teams');
    expect(prompt).toContain('Value proposition: Stops shadow-IT data leaks without blocking employees.');
    expect(prompt).toContain('Key messages: No agents to install; Deploys in a day');
    expect(prompt).toContain('Voice/tone: Warm, concise, founder-led; Pragmatic');
  });

  it('keeps visual brand data and the HTML formattedContent out of the prompt', async () => {
    mockReadBrandGuidelines.mockResolvedValue(realShapedGuidelines);

    await callRoute();
    const prompt = promptSentToLLM();
    for (const visual of ['#FF0000', '#00FF00', '#123456', 'Inter', 'logo.png', '<strong>', 'Brand Guidelines Retrieved']) {
      expect(prompt).not.toContain(visual);
    }
  });

  it('omits the sender block when no guidelines exist or the read failed', async () => {
    for (const result of [
      { success: true, exists: false, message: 'No brand guidelines found', brandData: {}, attachments: [] },
      { success: false, message: 'Failed to read brand guidelines', error: 'boom' },
    ]) {
      mockGeminiCreate.mockClear();
      mockReadBrandGuidelines.mockResolvedValue(result);
      const res = await callRoute();
      expect(res.status).not.toHaveBeenCalled();
      expect(promptSentToLLM()).not.toContain('Sender context');
    }
  });
});
