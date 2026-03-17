/**
 * TDD tests for /health endpoint version disclosure fix.
 *
 * Security finding: /health was returning { status: "healthy", version: "28.3.0" }
 * which leaks the application version to unauthenticated clients.
 *
 * Expected: /health returns only { status: "healthy" } with no version field.
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

  it('should NOT include version in the response', async () => {
    const res = await request(app).get('/health');
    expect(res.body).not.toHaveProperty('version');
  });

  it('should return exactly { status: "healthy" } with no extra fields', async () => {
    const res = await request(app).get('/health');
    expect(Object.keys(res.body)).toEqual(['status']);
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
