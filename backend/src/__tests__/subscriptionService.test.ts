import { settingsService } from '../services/settingsService';
import { userDb } from '../services/db';
import { CUSTOMER_PORTAL_PAGES } from '../services/customerPortalPages';
import {
  getUserSubscriptionType,
  getSubscriptionTypeConfig,
  getAllAvailableFunctionCalls,
  getAllAvailablePages,
  getAllowedFunctionCalls,
  getAllowedPages,
  filterFunctionCalls,
} from '../services/subscriptionService';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/customerPortalPages', () => ({
  CUSTOMER_PORTAL_PAGES: [
    { path: '/tasks', label: 'Tasks' },
    { path: '/seo', label: 'SEO' },
    { path: '/paid-social', label: 'Paid Social' },
    { path: '/newsletter', label: 'Newsletter' },
  ],
}));

jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn().mockImplementation(() => ({
    getAvailableTools: () => [
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'generate_video' } },
      { type: 'plain', other: true },
    ],
  })),
  agentModeService: {
    getAvailableTools: () => [
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'generate_video' } },
      { type: 'plain', other: true },
    ],
  },
}));

const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockedUserDb = userDb as jest.Mocked<typeof userDb>;

describe('subscriptionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getUserSubscriptionType returns user.subscriptionType or Basic by default', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    const t1 = await getUserSubscriptionType('u1');
    expect(t1).toBe('Pro');

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2' } as any);
    const t2 = await getUserSubscriptionType('u2');
    expect(t2).toBe('Basic');
  });

  it('getAllAvailablePages includes default pages and customer portal pages', () => {
    const pages = getAllAvailablePages();
    expect(pages).toEqual(['/', '/agent-mode', '/settings', '/guide', '/tasks', '/seo', '/paid-social', '/newsletter']);
  });

  it('getAllAvailableFunctionCalls returns all function tool names from AgentModeService', async () => {
    const calls = await getAllAvailableFunctionCalls();
    expect(calls.sort()).toEqual(['generate_image', 'generate_video'].sort());
  });

  it('getSubscriptionTypeConfig returns default Basic config when no types defined', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(null as any);

    const cfg = await getSubscriptionTypeConfig('Basic');
    expect(cfg).not.toBeNull();
    expect(cfg!.name).toBe('Basic');
    expect(cfg!.allowedPages).toEqual(getAllAvailablePages());
    const allCalls = await getAllAvailableFunctionCalls();
    expect(cfg!.allowedFunctionCalls.sort()).toEqual(allCalls.sort());
  });

  it('getSubscriptionTypeConfig normalizes /marketing prefix in allowedPages', async () => {
    const storedTypes = [
      {
        name: 'Pro',
        allowedPages: ['/marketing/tasks', '/marketing/guide', '/seo'],
        allowedFunctionCalls: ['generate_image'],
      },
    ];

    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const cfg = await getSubscriptionTypeConfig('Pro');
    expect(cfg).not.toBeNull();
    expect(cfg!.allowedPages).toEqual(['/tasks', '/guide', '/seo']);
  });

  it('getAllowedFunctionCalls returns explicit list when configured', async () => {
    const storedTypes = [
      {
        name: 'Pro',
        allowedPages: ['/tasks'],
        allowedFunctionCalls: ['generate_image'],
      },
    ];

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const calls = await getAllowedFunctionCalls('u1');
    expect(calls).toEqual(['generate_image']);
  });

  it('getAllowedFunctionCalls expands "*" or empty to all available functions', async () => {
    const base = {
      name: 'Pro',
      allowedPages: ['/tasks'],
    };

    // "*"
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedFunctionCalls: ['*'] }]),
    } as any);

    const calls1 = await getAllowedFunctionCalls('u1');
    expect(calls1.sort()).toEqual((await getAllAvailableFunctionCalls()).sort());

    // empty array
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedFunctionCalls: [] }]),
    } as any);

    const calls2 = await getAllowedFunctionCalls('u2');
    expect(calls2.sort()).toEqual((await getAllAvailableFunctionCalls()).sort());
  });

  it('getAllowedPages returns explicit list and strips /marketing prefix', async () => {
    const storedTypes = [
      {
        name: 'Pro',
        allowedPages: ['/marketing/tasks', '/marketing/guide', '/seo'],
        allowedFunctionCalls: ['generate_image'],
      },
    ];

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const pages = await getAllowedPages('u1');
    expect(pages).toEqual(['/tasks', '/guide', '/seo']);
  });

  it('getAllowedPages expands "*" or empty to all available pages', async () => {
    const base = {
      name: 'Pro',
      allowedFunctionCalls: ['generate_image'],
    };

    // "*"
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedPages: ['*'] }]),
    } as any);

    const pages1 = await getAllowedPages('u1');
    expect(pages1).toEqual(getAllAvailablePages());

    // empty array
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedPages: [] }]),
    } as any);

    const pages2 = await getAllowedPages('u2');
    expect(pages2).toEqual(getAllAvailablePages());
  });

  it('filterFunctionCalls keeps only allowed function tools but keeps non-function tools', () => {
    const tools = [
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'search_web' } },
      { type: 'plain', other: true },
      { type: 'function', function: { name: undefined as any } },
    ];

    const filtered = filterFunctionCalls(tools, ['generate_image']);
    expect(filtered).toEqual([
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'plain', other: true },
      { type: 'function', function: { name: undefined as any } },
    ]);
  });
});
