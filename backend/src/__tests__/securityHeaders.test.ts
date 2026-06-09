/**
 * TDD tests for HTTP security-header hardening (TAC Security report — Low findings).
 *
 * Finding 1 (Low): "X-Powered-By: Express" header discloses the server framework
 *   to unauthenticated clients, aiding fingerprinting. Expected: header absent.
 *
 * Finding 2 (Low): Missing standard security response headers
 *   (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS).
 *   Expected: these headers are present on every response.
 *
 * Both findings are reproducible against the live backend with a simple
 * `curl -I` and apply to all routes, so the fix is global middleware in app.ts.
 */

// Mock heavy dependencies before any imports (mirrors healthEndpoint.test.ts)
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

describe('HTTP security headers', () => {
  it('FAIL-then-PASS: does NOT expose X-Powered-By (framework disclosure)', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY (clickjacking protection)', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets a Referrer-Policy header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sets Strict-Transport-Security (HSTS)', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });

  it('applies security headers to API routes as well, not just /health', async () => {
    // An unknown API route still passes through the global middleware.
    const res = await request(app).get('/api/does-not-exist');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
