import { Request, Response } from 'express';
import settingsRouter from '../routes/settings';
import { settingsService } from '../services/settingsService';

jest.mock('../services/settingsService');

const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;

type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch';

const getRouteHandler = (path: string, method: HttpMethod) => {
  const layer = (settingsRouter as any).stack.find((item: any) =>
    item.route && item.route.path === path && item.route.methods?.[method]
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }

  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
};

const mockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

describe('Site-Wide Unipile Accounts API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/settings/site-wide-unipile-accounts', () => {
    const handler = getRouteHandler('/site-wide-unipile-accounts', 'get');

    it('should return empty array when no setting exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);

      const req = {} as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ accounts: [] });
    });

    it('should return accounts when setting exists', async () => {
      const accounts = [{ account_id: 'acc1', account_name: 'Test', enabled: true }];
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify(accounts),
        updatedAt: '', updatedBy: '',
      });

      const req = {} as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ accounts });
    });
  });

  describe('POST /api/settings/site-wide-unipile-accounts', () => {
    const handler = getRouteHandler('/site-wide-unipile-accounts', 'post');

    it('should return 400 when account_id is missing', async () => {
      const req = {
        body: {},
        user: { email: 'admin@test.com' },
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'account_id is required' });
    });

    it('should return 409 when account already exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify([{ account_id: 'acc1', enabled: true }]),
        updatedAt: '', updatedBy: '',
      });

      const req = {
        body: { account_id: 'acc1', account_name: 'Test' },
        user: { email: 'admin@test.com' },
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('should add account and persist', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        body: { account_id: 'acc1', account_name: 'Test LinkedIn', user_email: 'user@test.com' },
        user: { email: 'admin@test.com' },
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(mockedSettingsService.setSetting).toHaveBeenCalledWith(
        'site-wide-unipile-accounts',
        expect.stringContaining('"account_id":"acc1"'),
        'Site-wide Unipile accounts for enrichment',
        'admin@test.com',
      );
      expect(res.json).toHaveBeenCalledWith({
        account: expect.objectContaining({
          account_id: 'acc1',
          account_name: 'Test LinkedIn',
          user_email: 'user@test.com',
          enabled: true,
        }),
      });
    });
  });

  describe('PATCH /api/settings/site-wide-unipile-accounts/:accountId', () => {
    const handler = getRouteHandler('/site-wide-unipile-accounts/:accountId', 'patch');

    it('should return 404 when no setting exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);

      const req = {
        params: { accountId: 'acc1' },
        body: { enabled: false },
        user: { email: 'admin@test.com' },
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should toggle enabled state', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify([{ account_id: 'acc1', account_name: 'Test', enabled: true }]),
        updatedAt: '', updatedBy: '',
      });
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        params: { accountId: 'acc1' },
        body: { enabled: false },
        user: { email: 'admin@test.com' },
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        account: expect.objectContaining({ account_id: 'acc1', enabled: false }),
      });
    });
  });

  describe('DELETE /api/settings/site-wide-unipile-accounts/:accountId', () => {
    const handler = getRouteHandler('/site-wide-unipile-accounts/:accountId', 'delete');

    it('should return 404 when account not found', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify([{ account_id: 'acc1' }]),
        updatedAt: '', updatedBy: '',
      });

      const req = {
        params: { accountId: 'nonexistent' },
        user: { email: 'admin@test.com' },
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should remove account and persist', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify([
          { account_id: 'acc1', account_name: 'Keep' },
          { account_id: 'acc2', account_name: 'Remove' },
        ]),
        updatedAt: '', updatedBy: '',
      });
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        params: { accountId: 'acc2' },
        user: { email: 'admin@test.com' },
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true });
      // Verify only acc1 remains
      const savedValue = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1]);
      expect(savedValue).toHaveLength(1);
      expect(savedValue[0].account_id).toBe('acc1');
    });
  });
});
