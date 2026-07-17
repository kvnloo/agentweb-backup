/**
 * CORS Access-Control-Allow-Methods tests
 *
 * Verifies that the CORS middleware does NOT advertise OPTIONS as an
 * allowed method (it's handled implicitly by the cors middleware) and
 * only lists methods the API actually uses: GET, POST, PUT, PATCH, DELETE.
 */

// Mock AWS SDK before any imports
jest.mock('aws-sdk', () => {
  return {
    __esModule: true,
    default: {
      config: { update: jest.fn() },
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
          get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
          query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
          scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
          update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
          delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
          batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        })),
      },
      S3: jest.fn(() => ({
        upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        getSignedUrl: jest.fn().mockReturnValue('https://mock-url'),
        headObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        listObjectsV2: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Contents: [] }) }),
      })),
      EC2: jest.fn(() => ({
        describeInstances: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
      SSM: jest.fn(() => ({
        sendCommand: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
      IAM: jest.fn(() => ({
        getInstanceProfile: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
      SecretsManager: jest.fn(() => ({
        getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
      })),
    },
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
    },
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      getSignedUrl: jest.fn().mockReturnValue('https://mock-url'),
      headObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      listObjectsV2: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Contents: [] }) }),
    })),
    EC2: jest.fn(() => ({
      describeInstances: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
    SSM: jest.fn(() => ({
      sendCommand: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
    IAM: jest.fn(() => ({
      getInstanceProfile: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
    })),
  };
});

// Mock heavy services that aren't needed for CORS tests
jest.mock('../mcp/server/mcpServer', () => ({ setupMcpServer: jest.fn() }));
jest.mock('../mcp/oauth/oauthRoutes', () => ({ setupMcpOAuth: jest.fn() }));

import request from 'supertest';
import app from '../app';

describe('CORS Access-Control-Allow-Methods', () => {
  const allowedOrigin = 'http://localhost:5174';

  it('should NOT include OPTIONS in Access-Control-Allow-Methods header', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST');

    const methods = res.headers['access-control-allow-methods'];
    expect(methods).toBeDefined();
    expect(methods).not.toContain('OPTIONS');
  });

  it('should include only GET, POST, PUT, PATCH, DELETE in allowed methods', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET');

    const methods = res.headers['access-control-allow-methods'];
    expect(methods).toBeDefined();

    // Should contain all actually used methods
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('DELETE');

    // Should NOT contain OPTIONS (handled implicitly by cors middleware)
    expect(methods).not.toContain('OPTIONS');
  });

  it('should NOT advertise TRACE, CONNECT, or HEAD in allowed methods', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST');

    const methods = res.headers['access-control-allow-methods'];
    expect(methods).toBeDefined();
    expect(methods).not.toContain('TRACE');
    expect(methods).not.toContain('CONNECT');
    expect(methods).not.toContain('HEAD');
  });

  it('should return 204 for preflight requests from allowed origins', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type,Authorization');

    expect(res.status).toBe(204);
  });

  it('should still include credentials support', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('should allow the hireemma.ai apex origin', async () => {
    const res = await request(app)
      .options('/api/loop-events')
      .set('Origin', 'https://hireemma.ai')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBe('https://hireemma.ai');
  });

  it('should allow the www.hireemma.ai origin', async () => {
    const res = await request(app)
      .options('/api/loop-events')
      .set('Origin', 'https://www.hireemma.ai')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBe('https://www.hireemma.ai');
  });

  it('should reject a non-whitelisted external origin on loop-events', async () => {
    const res = await request(app)
      .options('/api/loop-events')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // The top-nav UsageMeter's useTokenUsage hook cache-busts /api/subscription/usage
  // with `Cache-Control: no-cache, no-store, must-revalidate` + `Pragma: no-cache`
  // request headers. Cross-origin (app.agentweb.pro -> api.agentweb.pro), the browser
  // preflights those headers; if they aren't in Access-Control-Allow-Headers the
  // fetch fails and the meter silently never loads. Guard the allow-list.
  it('should advertise Cache-Control and Pragma in Access-Control-Allow-Headers', async () => {
    const res = await request(app)
      .options('/api/subscription/usage')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,cache-control,pragma');

    const headers = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(headers).toContain('content-type');
    expect(headers).toContain('authorization');
    expect(headers).toContain('cache-control');
    expect(headers).toContain('pragma');
  });

  it('public endpoints should only advertise GET, POST, OPTIONS methods', async () => {
    const res = await request(app)
      .options('/api/lead-magnet/test')
      .set('Origin', 'https://external-site.com')
      .set('Access-Control-Request-Method', 'POST');

    const methods = res.headers['access-control-allow-methods'];
    expect(methods).toBeDefined();
    // Public endpoints have their own restricted CORS
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('OPTIONS');
    // Should NOT advertise PUT, PATCH, DELETE for public endpoints
    expect(methods).not.toContain('PUT');
    expect(methods).not.toContain('PATCH');
    expect(methods).not.toContain('DELETE');
  });
});
