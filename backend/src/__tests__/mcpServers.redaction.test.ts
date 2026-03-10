/**
 * Tests for MCP server config key redaction in GET responses.
 * API keys in args, env, accessToken, and URLs should be masked.
 */
import express from 'express';
import request from 'supertest';

const mockGetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: (...args: any[]) => mockGetSetting(...args),
    setSetting: jest.fn(),
  },
}));

jest.mock('../routes/config', () => ({
  encryptPassword: jest.fn(),
  decryptPassword: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { refreshMcpTools: jest.fn() },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { shutdown: jest.fn() },
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn(),
}));

import mcpServersRouter from '../routes/mcpServers';

const app = express();
app.use(express.json());
app.use('/api/admin/mcp-servers', mcpServersRouter);

describe('MCP Server Config Redaction', () => {
  beforeEach(() => jest.clearAllMocks());

  const serverConfigs = [
    {
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropics/brave-search-mcp', '--api-key', 'BSAsk_1234567890abcdef'],
      env: { BRAVE_API_KEY: 'BSAsk_1234567890abcdef' },
    },
    {
      name: 'serpapi',
      transport: 'sse',
      url: 'https://serpapi.com/mcp?api_key=secret123token',
      accessToken: 'encrypted-token-xyz',
    },
    {
      name: 'safe-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--port', '3000'],
      env: { NODE_ENV: 'production' },
    },
  ];

  // FAIL test 1: accessToken should be redacted
  it('should redact accessToken in GET response', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify(serverConfigs),
    });

    const res = await request(app).get('/api/admin/mcp-servers');
    expect(res.status).toBe(200);

    const serpapi = res.body.find((s: any) => s.name === 'serpapi');
    expect(serpapi.accessToken).not.toBe('encrypted-token-xyz');
    expect(serpapi.accessToken).toContain('***');
  });

  // FAIL test 2: env values should be redacted
  it('should redact env variable values containing keys', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify(serverConfigs),
    });

    const res = await request(app).get('/api/admin/mcp-servers');
    const brave = res.body.find((s: any) => s.name === 'brave-search');
    expect(brave.env.BRAVE_API_KEY).not.toBe('BSAsk_1234567890abcdef');
    expect(brave.env.BRAVE_API_KEY).toContain('***');
  });

  // FAIL test 3: args containing API keys should be redacted
  it('should redact args values that follow key-like flags', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify(serverConfigs),
    });

    const res = await request(app).get('/api/admin/mcp-servers');
    const brave = res.body.find((s: any) => s.name === 'brave-search');
    // The value after --api-key should be redacted
    const keyArgIndex = brave.args.indexOf('--api-key');
    expect(keyArgIndex).toBeGreaterThan(-1);
    expect(brave.args[keyArgIndex + 1]).not.toBe('BSAsk_1234567890abcdef');
    expect(brave.args[keyArgIndex + 1]).toContain('***');
  });

  // SUCCESS test 4: non-sensitive args should be preserved
  it('should preserve non-sensitive args', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify(serverConfigs),
    });

    const res = await request(app).get('/api/admin/mcp-servers');
    const safe = res.body.find((s: any) => s.name === 'safe-server');
    expect(safe.args).toEqual(['server.js', '--port', '3000']);
    expect(safe.env.NODE_ENV).toBe('production');
  });

  // FAIL test 5: URL query params with api_key should be redacted
  it('should redact api_key query params in URLs', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify(serverConfigs),
    });

    const res = await request(app).get('/api/admin/mcp-servers');
    const serpapi = res.body.find((s: any) => s.name === 'serpapi');
    expect(serpapi.url).not.toContain('secret123token');
    expect(serpapi.url).toContain('***');
  });
});
