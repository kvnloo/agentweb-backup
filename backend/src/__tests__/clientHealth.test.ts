/**
 * Tests for client health assessment tools:
 * - assessClientHealth(callerUserId, clientNameOrEmail)
 * - listAllClients(callerUserId)
 */

// Mock dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    getAllUsers: jest.fn(),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
}));

jest.mock('../utils/metaApiFetch', () => ({
  fetchWithRetryAndPaging: jest.fn().mockResolvedValue({ data: [] }),
}));

import { assessClientHealth, listAllClients } from '../services/clientHealthService';

const { userDb } = require('../services/db');
const { getAccountsByUserId } = require('../services/connectedAccountsDb');

describe('Client Health - assessClientHealth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL test 1: Non-admin user should be rejected
  it('should reject non-admin users', async () => {
    const callerUserId = 'non-admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: callerUserId,
      email: 'user@example.com',
      isAdmin: false,
    });

    const result = await assessClientHealth(callerUserId, 'client@example.com');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/admin/i);
  });

  // FAIL test 2: Client not found
  it('should return error when client is not found', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce(undefined);
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'nonexistent@example.com');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  // FAIL test 3: Client has no ad account configured
  it('should report blocked status when client has no ad account', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '',
    });
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health.ads_layer.connected).toBe(false);
    expect(result.health.status).toMatch(/blocked|at-risk/i);
  });

  // SUCCESS test: Full health assessment for a client with connected accounts
  it('should return full health assessment for a connected client', async () => {
    const adminUserId = 'admin-user';
    const clientUserId = 'client-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });

    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
      isAdmin: false,
      adAccount: '123456',
    });

    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      {
        platform: 'meta',
        account_id: 'meta-123',
        account_name: 'Meta Ads',
        config: { account_type: 'ad_account', ad_account_id: '123456', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
      {
        platform: 'linkedin',
        account_id: 'li-123',
        account_name: 'LinkedIn',
        config: { account_type: 'personal', access_token: 'tok' },
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]);

    // Mock the campaigns list and ad-level data fetches
    const { fetchWithRetryAndPaging } = require('../utils/metaApiFetch');
    (fetchWithRetryAndPaging as jest.Mock)
      .mockResolvedValueOnce({
        data: [
          { id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
          { id: 'camp2', name: 'Campaign 2', status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC' },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'ad1', name: 'Ad 1', creative: { id: 'cr1' }, status: 'ACTIVE', insights: { data: [{ spend: '50' }] } },
          { id: 'ad2', name: 'Ad 2', creative: { id: 'cr2' }, status: 'ACTIVE', insights: { data: [{ spend: '40' }] } },
          { id: 'ad3', name: 'Ad 3', creative: { id: 'cr3' }, status: 'ACTIVE', insights: { data: [{ spend: '10' }] } },
        ],
      });

    const result = await assessClientHealth(adminUserId, 'client@example.com');

    expect(result.success).toBe(true);
    expect(result.health).toBeDefined();
    expect(result.health.client).toEqual({
      userId: clientUserId,
      email: 'client@example.com',
      displayName: 'Client User',
    });
    expect(result.health.ads_layer.connected).toBe(true);
    expect(result.health.ads_layer.active_campaigns).toBe(2);
    expect(result.health.creative_variety.distinct_creatives).toBe(3);
    expect(result.health.status).toBeDefined();
    expect(['healthy', 'mediocre', 'at-risk', 'blocked']).toContain(result.health.status);
  });

  // FAIL test 4: Lookup by name match when email not found
  it('should find client by name when email lookup fails', async () => {
    const adminUserId = 'admin-user';

    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValueOnce(undefined);
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      {
        userId: 'client-found',
        email: 'john@company.com',
        displayName: 'John Smith',
        isAdmin: false,
        adAccount: '',
      },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await assessClientHealth(adminUserId, 'John Smith');

    expect(result.success).toBe(true);
    expect(result.health.client.displayName).toBe('John Smith');
  });
});

describe('Client Health - listAllClients', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL test 1: Non-admin user should be rejected
  it('should reject non-admin users', async () => {
    const callerUserId = 'non-admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: callerUserId,
      email: 'user@example.com',
      isAdmin: false,
    });

    const result = await listAllClients(callerUserId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/admin/i);
  });

  // FAIL test: callerIsAdmin=false should be rejected without DB lookup
  it('should reject when callerIsAdmin override is false', async () => {
    const result = await listAllClients('non-admin-user', false);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/admin/i);
    // Should not hit the DB when override is provided
    expect(userDb.getUserById).not.toHaveBeenCalled();
  });

  // SUCCESS test: delegated admin session with callerIsAdmin=true bypasses DB check
  it('should allow access when callerIsAdmin override is true (delegated session)', async () => {
    const targetUserId = 'target-customer';
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: targetUserId, email: 'customer@example.com', isAdmin: false },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    // Pass callerIsAdmin=true as the _svc token would set it — no DB lookup for admin check
    const result = await listAllClients(targetUserId, true);

    expect(result.success).toBe(true);
    expect(userDb.getUserById).not.toHaveBeenCalled();
  });

  // FAIL test 2: Should return admin users as well
  it('should return admin users in the list', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: adminUserId, email: 'admin@example.com', isAdmin: true },
    ]);
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([]);

    const result = await listAllClients(adminUserId);

    expect(result.success).toBe(true);
    expect(result.clients).toHaveLength(1);
    expect(result.clients[0].email).toBe('admin@example.com');
  });

  // FAIL test 3: Error handling when DB fails
  it('should handle database errors gracefully', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockRejectedValueOnce(new Error('DB connection failed'));

    const result = await listAllClients(adminUserId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed/i);
  });

  // SUCCESS test: Returns client list with health indicators (including admins)
  it('should return all clients (including admins) with health indicators', async () => {
    const adminUserId = 'admin-user';
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: adminUserId,
      email: 'admin@example.com',
      isAdmin: true,
    });
    (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([
      { userId: adminUserId, email: 'admin@example.com', isAdmin: true },
      {
        userId: 'client-1',
        email: 'client1@example.com',
        isAdmin: false,
        displayName: 'Client One',
        adAccount: '111',
        roles: ['customer'],
        lastLoginTime: '2024-06-01T00:00:00Z',
        createdAt: '2024-01-15T10:00:00Z',
      },
      {
        userId: 'client-2',
        email: 'client2@example.com',
        isAdmin: false,
        displayName: 'Client Two',
        adAccount: '',
        roles: ['free'],
        lastLoginTime: '2024-05-01T00:00:00Z',
        createdAt: '2024-02-20T08:30:00Z',
      },
    ]);

    (getAccountsByUserId as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { platform: 'meta', account_id: 'meta-1', account_name: 'Meta', config: { account_type: 'ad_account' } },
      ])
      .mockResolvedValueOnce([]);

    const result = await listAllClients(adminUserId);

    expect(result.success).toBe(true);
    expect(result.clients).toHaveLength(3);
    expect(result.clients[0].email).toBe('admin@example.com');
    expect(result.clients[1].email).toBe('client1@example.com');
    expect(result.clients[1].has_ads).toBe(true);
    expect(result.clients[1].signup_time).toBe('2024-01-15T10:00:00Z');
    expect(result.clients[2].email).toBe('client2@example.com');
    expect(result.clients[2].has_ads).toBe(false);
    expect(result.clients[2].signup_time).toBe('2024-02-20T08:30:00Z');
  });
});
