/**
 * Tests for the /health endpoint.
 *
 * `version` was removed here for a time over disclosure concerns, then
 * deliberately reintroduced by buildInfo.ts as a dated build-label (never the
 * commit sha) so an incident responder can tell whether a deploy actually
 * landed on this instance — see buildInfo.ts's own docstring for the
 * disclosure-vs-operability tradeoff. `/` (the root endpoint, tested below)
 * was never given this field and still returns bare { status: "healthy" }.
 */

// Mock heavy dependencies before any imports
jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  EC2: jest.fn(() => ({})),
  SSM: jest.fn(() => ({})),
  IAM: jest.fn(() => ({})),
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn().mockReturnThis(),
      put: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      scan: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
  },
  S3: jest.fn(() => ({
    getObject: jest.fn().mockReturnThis(),
    putObject: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  SES: jest.fn(() => ({})),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    getAllUsers: jest.fn(),
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import request from 'supertest';
import app from '../app';

describe('/health endpoint', () => {
  it('should return 200 with status healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  it('includes a version field (null when no build-info.json is present, e.g. in tests)', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('version');
    // No dist/build-info.json exists in a test run, so buildInfo.ts's read() falls
    // back to null rather than a real version label.
    expect(res.body.version).toBeNull();
  });

  it('returns exactly { status, version } with no other fields', async () => {
    const res = await request(app).get('/health');
    expect(Object.keys(res.body).sort()).toEqual(['status', 'version']);
  });
});

describe('/ root endpoint', () => {
  it('should return 200 with status healthy and no version', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body).not.toHaveProperty('version');
  });
});
