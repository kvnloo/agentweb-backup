import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
    next();
  }),
}));

jest.mock('../../middleware/admin', () => ({
  isAdmin: jest.fn((req: any, res: any, next: any) => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }
    next();
  }),
}));

jest.mock('../../services/mcpUsageEventsService', () => ({
  buildMcpUsageReport: jest.fn(),
}));

import mcpUsageAdminRoutes from '../mcpUsageAdmin';
import { authenticateToken } from '../../middleware/auth';
import { buildMcpUsageReport } from '../../services/mcpUsageEventsService';

const mockAuth = authenticateToken as unknown as jest.Mock;
const mockReport = buildMcpUsageReport as jest.Mock;

describe('admin MCP usage routes', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
      next();
    });
    app = express();
    app.use(express.json());
    app.use('/api/admin', mcpUsageAdminRoutes);
  });

  it('400s when start/end are missing or malformed', async () => {
    await request(app).get('/api/admin/mcp-usage').expect(400);
    await request(app).get('/api/admin/mcp-usage?start=2026-7-9&end=2026-07-10').expect(400);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('400s when start is after end', async () => {
    await request(app).get('/api/admin/mcp-usage?start=2026-07-10&end=2026-07-09').expect(400);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('403s for non-admin users', async () => {
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'user-1', email: 'user@example.com', isAdmin: false };
      next();
    });

    await request(app).get('/api/admin/mcp-usage?start=2026-07-09&end=2026-07-10').expect(403);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('returns the MCP usage report for valid admin requests', async () => {
    const payload = {
      start: '2026-07-09',
      end: '2026-07-10',
      summary: {
        oauthStarts: 1,
        authorizedUsers: 1,
        tokenIssuedUsers: 1,
        connectionAttempts: 1,
        connectedUsers: 1,
        toolCalls: 2,
        firstUseUsers: 1,
        firstUseRate: 1,
      },
      clients: [
        {
          clientType: 'claude_code',
          oauthStarts: 1,
          authorizedUsers: 1,
          tokenIssuedUsers: 1,
          connectionAttempts: 1,
          connectedUsers: 1,
          toolCalls: 2,
          firstUseUsers: 1,
          clientNames: ['Claude Code'],
        },
      ],
      users: [],
    };
    mockReport.mockResolvedValue(payload);

    const res = await request(app)
      .get('/api/admin/mcp-usage?start=2026-07-09&end=2026-07-10')
      .expect(200);

    expect(res.body).toEqual(payload);
    expect(mockReport).toHaveBeenCalledWith({ start: '2026-07-09', end: '2026-07-10' });
  });
});
