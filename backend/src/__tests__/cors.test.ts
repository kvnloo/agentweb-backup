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
  // ENG-2650: the portal's /review/:sessionId page sends the reviewer capability
  // token cross-origin in X-Review-Token; without it in the allow-list the
  // preflight fails and no reviewer can open a review.
  it('should advertise X-Review-Token in Access-Control-Allow-Headers', async () => {
    const res = await request(app)
      .options('/review/sess-1')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-review-token');

    const headers = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(headers).toContain('x-review-token');
  });

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

  // ENG-1751: ngrok origins are a local-dev convenience and must never be a
  // credentialed CORS origin in production.
  describe('ngrok origin production gate (ENG-1751)', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllowNgrok = process.env.CORS_ALLOW_NGROK;

    afterEach(() => {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalAllowNgrok === undefined) delete process.env.CORS_ALLOW_NGROK;
      else process.env.CORS_ALLOW_NGROK = originalAllowNgrok;
    });

    it('rejects a ngrok-free.app origin when NODE_ENV=production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ALLOW_NGROK;

      const res = await request(app)
        .options('/api/loop-events')
        .set('Origin', 'https://anything.ngrok-free.app')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects a ngrok.io origin when NODE_ENV=production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ALLOW_NGROK;

      const res = await request(app)
        .options('/api/loop-events')
        .set('Origin', 'https://anything.ngrok.io')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still allows a ngrok-free.app origin in explicit development', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ALLOW_NGROK;

      const res = await request(app)
        .options('/api/loop-events')
        .set('Origin', 'https://anything.ngrok-free.app')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBe('https://anything.ngrok-free.app');
    });

    // CodeRabbit (PR #2770): production deploys `node dist/server.js` and
    // neither package.json nor tracked EB config sets NODE_ENV=production
    // explicitly, so gating on `!== "production"` was fail-open for the real
    // deployed environment (unset NODE_ENV fell through as "allow"). Gating on
    // `=== "development"` instead must reject unset/staging/mistyped values too.
    it('rejects a ngrok-free.app origin when NODE_ENV is unset (matches real prod)', async () => {
      delete process.env.NODE_ENV;
      delete process.env.CORS_ALLOW_NGROK;

      const res = await request(app)
        .options('/api/loop-events')
        .set('Origin', 'https://anything.ngrok-free.app')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects a ngrok-free.app origin for a non-development, non-production NODE_ENV (e.g. staging)', async () => {
      process.env.NODE_ENV = 'staging';
      delete process.env.CORS_ALLOW_NGROK;

      const res = await request(app)
        .options('/api/loop-events')
        .set('Origin', 'https://anything.ngrok-free.app')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows a ngrok origin in production only with the explicit CORS_ALLOW_NGROK=1 opt-in', async () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOW_NGROK = '1';

      const res = await request(app)
        .options('/api/loop-events')
        .set('Origin', 'https://anything.ngrok-free.app')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBe('https://anything.ngrok-free.app');
    });
  });

  // ENG-2418: the portal (app.agentweb.pro) reads with-images paging metadata from
  // response headers cross-origin; browsers hide non-safelisted headers unless exposed.
  it('exposes the with-images paging headers to allowed cross-origin callers', async () => {
    const res = await request(app)
      .get('/api/loop-events')
      .set('Origin', 'https://app.agentweb.pro');

    const exposed = String(res.headers['access-control-expose-headers'] || '');
    expect(exposed).toContain('X-Total-Tasks');
    expect(exposed).toContain('X-Next-Cursor');
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

// ENG-2593: customer sites on arbitrary domains (e.g. nuerraa.com) POST web-form leads
// straight to /api/webhooks/forward-lead from the browser. The global allowlist rejected
// their preflight, so the route's own `*` CORS headers never ran. Access is gated per list
// (publicAccessEnabled) inside the route, not by origin.
describe('ENG-2593 public CORS for /api/webhooks/forward-lead', () => {
  const customerOrigin = 'https://www.nuerraa.com';

  it('answers the preflight from an arbitrary customer origin with open CORS', async () => {
    const res = await request(app)
      .options('/api/webhooks/forward-lead')
      .set('Origin', customerOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('returns open CORS on the POST itself from an arbitrary origin', async () => {
    const res = await request(app)
      .post('/api/webhooks/forward-lead')
      .set('Origin', customerOrigin)
      .send({});

    expect(res.status).toBe(400); // listId missing — reached the route, not blocked by CORS
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('does not open other webhook routes to arbitrary origins', async () => {
    const res = await request(app)
      .options('/api/webhooks/hubspot')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('ENG-2657 /api/leads/public/:listId alias of forward-lead', () => {
  const customerOrigin = 'https://nuerraa.com';

  it('answers the preflight from a customer origin with open CORS', async () => {
    const res = await request(app)
      .options('/api/leads/public/some-list-id')
      .set('Origin', customerOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('routes the POST into forward-lead with listId from the path', async () => {
    const res = await request(app)
      .post('/api/leads/public/some-list-id')
      .set('Origin', customerOrigin)
      .send({ email: 'a@b.co' });
    expect(res.status).not.toBe(400); // listId came from the path, so forward-lead did not reject it as missing
    expect(res.text).not.toContain('Not allowed by CORS');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
