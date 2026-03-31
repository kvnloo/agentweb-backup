import { Request, Response } from 'express';

// ── External dependency mocks ────────────────────────────────────────────────
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    }))
  },
  config: { update: jest.fn() }
}));

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

// Mock SettingsService used inside the controller module
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();

jest.mock('../services/settingsService', () => ({
  SettingsService: jest.fn().mockImplementation(() => ({
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
  })),
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

// Mock fs to control filesystem fallback
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  promises: {
    readFile: jest.fn().mockResolvedValue('<html>legacy</html>'),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> & { user?: any } = {}): Request {
  return {
    query: {},
    params: {},
    body: {},
    ...overrides,
    // attach user via middleware convention
  } as unknown as Request;
}

function makeRes(): { res: Response; json: jest.Mock; status: jest.Mock; send: jest.Mock; setHeader: jest.Mock } {
  const json = jest.fn().mockReturnThis();
  const send = jest.fn().mockReturnThis();
  const setHeader = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json, send });
  const res = { json, status, send, setHeader } as unknown as Response;
  return { res, json, status, send, setHeader };
}

function settingWith(templates: object[]) {
  return { settingValue: JSON.stringify(templates) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// We import after mocks are registered
import {
  getTemplates,
  saveTemplate,
  deleteTemplate,
  getPreviewTemplate,
} from '../controllers/htmlTemplatesController';

const USER_ID = 'user-abc';

function reqWithUser(extra: object = {}): Request {
  const req = makeReq(extra);
  (req as any).user = { userId: USER_ID, email: 'dev@test.com', isAdmin: false };
  return req;
}

function adminReq(extra: object = {}): Request {
  const req = makeReq(extra);
  (req as any).user = { userId: USER_ID, email: 'admin@test.com', isAdmin: true };
  return req;
}

// ── getTemplates ─────────────────────────────────────────────────────────────

describe('getTemplates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when no user is attached', async () => {
    const req = makeReq(); // no .user
    const { res, status } = makeRes();

    await getTemplates(req, res);

    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns merged templates from new and legacy keys', async () => {
    const newUserTpl = { template_name: 'new-user', type: ['email'], html_content: '<p/>', variables: [], arrayVariables: [] };
    const legacyPublicTpl = { template_name: 'legacy-pub', html_content: '<p/>', subject: 'S', variables: [], arrayVariables: [] };

    mockGetSetting.mockImplementation((key: string) => {
      if (key === `templates_${USER_ID}`) return Promise.resolve(settingWith([newUserTpl]));
      if (key === 'templates_public') return Promise.resolve(null);
      if (key === `email_templates_${USER_ID}`) return Promise.resolve(null);
      if (key === 'email_templates_public') return Promise.resolve(settingWith([legacyPublicTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser();
    const { res, json } = makeRes();

    await getTemplates(req, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        templates: expect.arrayContaining([
          expect.objectContaining({ template_name: 'new-user' }),
          expect.objectContaining({ template_name: 'legacy-pub', isPublic: true }),
        ]),
      })
    );
  });

  it('user-key template shadows public template of the same name', async () => {
    const userTpl = { template_name: 'shared', type: ['email'], html_content: '<p>user</p>', variables: [], arrayVariables: [] };
    const pubTpl  = { template_name: 'shared', type: ['email'], html_content: '<p>public</p>', variables: [], arrayVariables: [] };

    mockGetSetting.mockImplementation((key: string) => {
      if (key === `templates_${USER_ID}`) return Promise.resolve(settingWith([userTpl]));
      if (key === 'templates_public') return Promise.resolve(settingWith([pubTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser();
    const { res, json } = makeRes();

    await getTemplates(req, res);

    const { templates } = (json.mock.calls[0][0] as any);
    const shared = templates.filter((t: any) => t.template_name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].html_content).toBe('<p>user</p>');
  });

  it('filters result by ?type query param', async () => {
    const emailTpl   = { template_name: 'e', type: ['email'],        html_content: '<p/>', variables: [], arrayVariables: [] };
    const lpTpl      = { template_name: 'l', type: ['landing_page'], html_content: '<p/>', variables: [], arrayVariables: [] };

    mockGetSetting.mockImplementation((key: string) => {
      if (key === `templates_${USER_ID}`) return Promise.resolve(settingWith([emailTpl, lpTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ query: { type: 'landing_page' } });
    const { res, json } = makeRes();

    await getTemplates(req, res);

    const { templates } = (json.mock.calls[0][0] as any);
    expect(templates).toHaveLength(1);
    expect(templates[0].template_name).toBe('l');
  });

  it('adds type=email to legacy templates that lack a type field', async () => {
    const legacyTpl = { template_name: 'old', html_content: '<p/>', variables: [], arrayVariables: [] };

    mockGetSetting.mockImplementation((key: string) => {
      if (key === `email_templates_${USER_ID}`) return Promise.resolve(settingWith([legacyTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ query: { type: 'email' } });
    const { res, json } = makeRes();

    await getTemplates(req, res);

    const { templates } = (json.mock.calls[0][0] as any);
    expect(templates.some((t: any) => t.template_name === 'old')).toBe(true);
  });

  it('returns 500 when settings lookup fails', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('boom'));

    const req = reqWithUser();
    const { res, status } = makeRes();

    await getTemplates(req, res);

    expect(status).toHaveBeenCalledWith(500);
  });
});

// ── saveTemplate ──────────────────────────────────────────────────────────────

describe('saveTemplate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined);
  });

  const validBody = {
    template_name: 'my-tpl',
    type: ['email'],
    html_content: '<p>{{greeting}}</p>',
    subject: 'Hi {{greeting}}',
    variables: ['greeting'],
    arrayVariables: [],
    isPublic: false,
  };

  it('returns 401 when no user is attached', async () => {
    const req = makeReq({ body: validBody });
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 400 when template_name is missing', async () => {
    const req = reqWithUser({ body: { ...validBody, template_name: '' } });
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when type is not a non-empty array', async () => {
    const req = reqWithUser({ body: { ...validBody, type: [] } });
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when html_content is missing', async () => {
    const req = reqWithUser({ body: { ...validBody, html_content: '' } });
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('returns 403 when non-admin tries to save a public template', async () => {
    const req = reqWithUser({ body: { ...validBody, isPublic: true } });
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(403);
  });

  it('saves a new template successfully', async () => {
    const req = reqWithUser({ body: validBody });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    expect(mockSetSetting).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, template: expect.objectContaining({ template_name: 'my-tpl' }) })
    );
  });

  it('returns 400 on duplicate template_name during create', async () => {
    const existing = { ...validBody, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' };
    mockGetSetting.mockResolvedValue(settingWith([existing]));

    const req = reqWithUser({ body: validBody }); // same name, no original_template_name
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('allows rename when original_template_name is provided', async () => {
    const existing = { ...validBody, template_name: 'old-name', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' };
    mockGetSetting.mockResolvedValue(settingWith([existing]));

    const req = reqWithUser({
      body: { ...validBody, template_name: 'new-name', original_template_name: 'old-name' }
    });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('returns 400 when rename target conflicts with another template', async () => {
    const templates = [
      { ...validBody, template_name: 'old-name', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      { ...validBody, template_name: 'taken-name', created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T00:00:00Z' },
    ];
    mockGetSetting.mockResolvedValue(settingWith(templates));

    const req = reqWithUser({
      body: { ...validBody, template_name: 'taken-name', original_template_name: 'old-name' }
    });
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('extracts variables automatically when not supplied', async () => {
    const { variables, arrayVariables, ...bodyWithoutVars } = validBody;
    const req = reqWithUser({ body: bodyWithoutVars });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    const savedTemplate = (json.mock.calls[0][0] as any).template;
    expect(savedTemplate.variables).toContain('greeting');
  });

  it('preserves legacy created_at when updating a migrated template', async () => {
    const oldTemplate = {
      ...validBody,
      template_name: 'legacy-name',
      created_at: '2024-02-03T04:05:06.000Z',
      updated_at: '2024-02-03T04:05:06.000Z',
    };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === `templates_${USER_ID}`) return Promise.resolve(settingWith([]));
      if (key === `email_templates_${USER_ID}`) return Promise.resolve(settingWith([oldTemplate]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({
      body: { ...validBody, template_name: 'renamed-template', original_template_name: 'legacy-name' }
    });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    const savedTemplate = (json.mock.calls[0][0] as any).template;
    expect(savedTemplate.created_at).toBe('2024-02-03T04:05:06.000Z');
  });

  it('allows admin to save a public template', async () => {
    const req = adminReq({ body: { ...validBody, isPublic: true } });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('does not include subject field for non-email templates', async () => {
    const req = reqWithUser({
      body: { ...validBody, type: ['landing_page'], subject: 'Should be omitted' }
    });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    const savedTemplate = (json.mock.calls[0][0] as any).template;
    expect(savedTemplate.subject).toBeUndefined();
  });

  it('extracts landing page variables correctly when saved without an email subject', async () => {
    const req = reqWithUser({
      body: {
        ...validBody,
        type: ['landing_page'],
        subject: undefined,
        html_content: '<section>{{headline}}</section><div>{{features_n}}</div><div>{{features_1}}</div>',
        variables: undefined,
        arrayVariables: undefined,
      }
    });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    const savedTemplate = (json.mock.calls[0][0] as any).template;
    expect(savedTemplate.subject).toBeUndefined();
    expect(savedTemplate.variables).toEqual(['headline']);
    expect(savedTemplate.arrayVariables).toEqual(['features_n']);
  });

  it('defaults subject to an empty string for email templates when not provided', async () => {
    const req = reqWithUser({
      body: { ...validBody, subject: undefined }
    });
    const { res, json } = makeRes();

    await saveTemplate(req, res);

    const savedTemplate = (json.mock.calls[0][0] as any).template;
    expect(savedTemplate.subject).toBe('');
  });

  it('returns 500 when persistence fails', async () => {
    mockSetSetting.mockRejectedValueOnce(new Error('write failed'));

    const req = reqWithUser({ body: validBody });
    const { res, status } = makeRes();

    await saveTemplate(req, res);

    expect(status).toHaveBeenCalledWith(500);
  });
});

// ── deleteTemplate ────────────────────────────────────────────────────────────

describe('deleteTemplate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetSetting.mockResolvedValue(undefined);
  });

  it('returns 401 when no user is attached', async () => {
    const req = makeReq({ params: { templateName: 'tpl' } });
    const { res, status } = makeRes();

    await deleteTemplate(req, res);

    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when non-admin tries to delete a public template', async () => {
    mockGetSetting.mockResolvedValue(null);
    const req = reqWithUser({ params: { templateName: 'tpl' }, query: { isPublic: 'true' } });
    const { res, status } = makeRes();

    await deleteTemplate(req, res);

    expect(status).toHaveBeenCalledWith(403);
  });

  it('deletes template from new key and returns success', async () => {
    const tpl = { template_name: 'to-delete', type: ['email'], html_content: '<p/>', variables: [], arrayVariables: [] };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === `templates_${USER_ID}`) return Promise.resolve(settingWith([tpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ params: { templateName: 'to-delete' }, query: {} });
    const { res, json } = makeRes();

    await deleteTemplate(req, res);

    expect(mockSetSetting).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('falls back to legacy key when template is not found in new key', async () => {
    const legacyTpl = { template_name: 'legacy', html_content: '<p/>', variables: [], arrayVariables: [] };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === `templates_${USER_ID}`) return Promise.resolve(settingWith([]));
      if (key === `email_templates_${USER_ID}`) return Promise.resolve(settingWith([legacyTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ params: { templateName: 'legacy' }, query: {} });
    const { res, json } = makeRes();

    await deleteTemplate(req, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('returns 404 when template does not exist in any store', async () => {
    mockGetSetting.mockResolvedValue(settingWith([]));

    const req = reqWithUser({ params: { templateName: 'ghost' }, query: {} });
    const { res, status } = makeRes();

    await deleteTemplate(req, res);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('allows admin to delete a public template', async () => {
    const pubTpl = { template_name: 'pub-tpl', type: ['email'], html_content: '<p/>', variables: [], arrayVariables: [] };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'templates_public') return Promise.resolve(settingWith([pubTpl]));
      return Promise.resolve(null);
    });

    const req = adminReq({ params: { templateName: 'pub-tpl' }, query: { isPublic: 'true' } });
    const { res, json } = makeRes();

    await deleteTemplate(req, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('deletes from legacy public storage when missing from the new public key', async () => {
    const legacyTpl = { template_name: 'legacy-public', html_content: '<p/>', variables: [], arrayVariables: [] };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'templates_public') return Promise.resolve(settingWith([]));
      if (key === 'email_templates_public') return Promise.resolve(settingWith([legacyTpl]));
      return Promise.resolve(null);
    });

    const req = adminReq({ params: { templateName: 'legacy-public' }, query: { isPublic: 'true' } });
    const { res, json } = makeRes();

    await deleteTemplate(req, res);

    expect(mockSetSetting).toHaveBeenCalledWith(
      'email_templates_public',
      JSON.stringify([]),
      'Legacy public email templates',
      'admin@test.com'
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('returns 500 when delete lookup fails', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('boom'));

    const req = reqWithUser({ params: { templateName: 'tpl' }, query: {} });
    const { res, status } = makeRes();

    await deleteTemplate(req, res);

    expect(status).toHaveBeenCalledWith(500);
  });
});

// ── getPreviewTemplate ────────────────────────────────────────────────────────

describe('getPreviewTemplate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves html_content from new user key when found', async () => {
    const tpl = { template_name: 'preview-me', html_content: '<html>content</html>' };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === `templates_${USER_ID}`) return Promise.resolve(settingWith([tpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ params: { templateName: 'preview-me' } });
    const { res, send, setHeader } = makeRes();

    await getPreviewTemplate(req, res);

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(send).toHaveBeenCalledWith('<html>content</html>');
  });

  it('serves html_content from public key when not in user key', async () => {
    const pubTpl = { template_name: 'pub-preview', html_content: '<html>public</html>' };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'templates_public') return Promise.resolve(settingWith([pubTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ params: { templateName: 'pub-preview' } });
    const { res, send, setHeader } = makeRes();

    await getPreviewTemplate(req, res);

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(send).toHaveBeenCalledWith('<html>public</html>');
  });

  it('serves from legacy user key (email_templates_*) when not in new keys', async () => {
    const legacyTpl = { template_name: 'old-preview', html_content: '<html>legacy</html>' };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === `email_templates_${USER_ID}`) return Promise.resolve(settingWith([legacyTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ params: { templateName: 'old-preview' } });
    const { res, send, setHeader } = makeRes();

    await getPreviewTemplate(req, res);

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(send).toHaveBeenCalledWith('<html>legacy</html>');
  });

  it('serves from legacy public key when no user-specific template exists', async () => {
    const legacyPublicTpl = { template_name: 'legacy-public-preview', html_content: '<html>legacy-public</html>' };
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'email_templates_public') return Promise.resolve(settingWith([legacyPublicTpl]));
      return Promise.resolve(null);
    });

    const req = reqWithUser({ params: { templateName: 'legacy-public-preview' } });
    const { res, send, setHeader } = makeRes();

    await getPreviewTemplate(req, res);

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(send).toHaveBeenCalledWith('<html>legacy-public</html>');
  });

  it('returns 500 when preview lookup fails', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('boom'));

    const req = reqWithUser({ params: { templateName: 'preview-me' } });
    const { res, status } = makeRes();

    await getPreviewTemplate(req, res);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('returns 404 when template is not found in any store and name is not a legacy FS alias', async () => {
    mockGetSetting.mockResolvedValue(null);

    const req = reqWithUser({ params: { templateName: 'nonexistent' } });
    const { res, status } = makeRes();

    await getPreviewTemplate(req, res);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('attempts filesystem fallback for "default-v2" alias', async () => {
    mockGetSetting.mockResolvedValue(null);
    const fs = require('fs');
    fs.existsSync.mockReturnValue(true);
    fs.promises.readFile.mockResolvedValue('<html>v2-legacy</html>');

    const req = reqWithUser({ params: { templateName: 'default-v2' } });
    const { res, send, setHeader } = makeRes();

    await getPreviewTemplate(req, res);

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(send).toHaveBeenCalledWith('<html>v2-legacy</html>');
  });

  it('attempts filesystem fallback for "landing-page-v2" alias', async () => {
    mockGetSetting.mockResolvedValue(null);
    const fs = require('fs');
    fs.existsSync.mockReturnValue(true);
    fs.promises.readFile.mockResolvedValue('<html>v2-legacy</html>');

    const req = reqWithUser({ params: { templateName: 'landing-page-v2' } });
    const { res, send } = makeRes();

    await getPreviewTemplate(req, res);

    expect(send).toHaveBeenCalledWith('<html>v2-legacy</html>');
  });

  it('returns 404 when FS fallback file does not exist', async () => {
    mockGetSetting.mockResolvedValue(null);
    const fs = require('fs');
    fs.existsSync.mockReturnValue(false);

    const req = reqWithUser({ params: { templateName: 'default-v2' } });
    const { res, status } = makeRes();

    await getPreviewTemplate(req, res);

    expect(status).toHaveBeenCalledWith(404);
  });
});
