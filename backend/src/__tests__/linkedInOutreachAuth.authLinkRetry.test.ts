import request from 'supertest';
import express from 'express';
import linkedInOutreachAuthRouter from '../routes/linkedInOutreachAuth';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

// ENG-2175 / ENG-2180: Unipile's own gateway returns an HTML "502 Bad Gateway" page
// (surfaced by their SDK as a Blob with type text/html, no HTTP status attached) during
// brief provider-side blips. /init and /reconnect should retry through that rather than
// immediately surfacing a hard failure to the user.
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    getAccount: jest.fn(),
    clearStatusCache: jest.fn(),
    getClient: jest.fn(),
    getApiUrl: jest.fn().mockResolvedValue('https://api.unipile.com'),
  },
}));
jest.mock('../services/connectedAccountsDb');
jest.mock('../services/linkedInConnectionHealth', () => ({
  clearDisconnectFlag: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
}));

const app = express();
app.use(express.json());
app.use('/api/oauth/linkedin-outreach', linkedInOutreachAuthRouter);

function htmlGatewayError(contentType = 'text/html'): any {
  const error: any = new Error('');
  error.body = new Blob(['<html>502 Bad Gateway</html>'], { type: contentType });
  return error;
}

function networkError(code: string): any {
  const error: any = new Error('fetch failed');
  error.code = code;
  return error;
}

describe('GET /api/oauth/linkedin-outreach/init', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retries through a transient Unipile gateway error and succeeds', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    const createHostedAuthLink = jest.fn()
      .mockRejectedValueOnce(htmlGatewayError())
      .mockResolvedValue({ url: 'https://unipile.example.com/auth/xyz' });
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app).get('/api/oauth/linkedin-outreach/init');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, url: 'https://unipile.example.com/auth/xyz' });
    expect(createHostedAuthLink).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  }, 10000);

  it('gives a provider-outage message once retries are exhausted on a transient error', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    const createHostedAuthLink = jest.fn().mockRejectedValue(htmlGatewayError());
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app).get('/api/oauth/linkedin-outreach/init');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
    expect(createHostedAuthLink).toHaveBeenCalledTimes(3);
    jest.restoreAllMocks();
  }, 10000);

  it('does not retry a non-transient (real API) error', async () => {
    const createHostedAuthLink = jest.fn().mockRejectedValue(new Error('invalid_api_key'));
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app).get('/api/oauth/linkedin-outreach/init');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to initialize LinkedIn Outreach connection');
    expect(createHostedAuthLink).toHaveBeenCalledTimes(1);
  });

  it('does not retry a Blob body that is not HTML (e.g. a plain-text session error)', async () => {
    const createHostedAuthLink = jest.fn().mockRejectedValue(htmlGatewayError('text/plain'));
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app).get('/api/oauth/linkedin-outreach/init');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to initialize LinkedIn Outreach connection');
    expect(createHostedAuthLink).toHaveBeenCalledTimes(1);
  });

  it('retries an HTML gateway error even when Content-Type carries a charset parameter', async () => {
    // Node's fetch puts the raw Content-Type header on Blob.type verbatim — a gateway
    // page served as "text/html; charset=utf-8" (a common nginx default) must still be
    // classified transient, not just a bare "text/html".
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    const createHostedAuthLink = jest.fn()
      .mockRejectedValueOnce(htmlGatewayError('text/html; charset=utf-8'))
      .mockResolvedValue({ url: 'https://unipile.example.com/auth/xyz' });
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app).get('/api/oauth/linkedin-outreach/init');

    expect(res.status).toBe(200);
    expect(createHostedAuthLink).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  }, 10000);

  it('retries a raw network error (e.g. ECONNRESET) and succeeds', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    const createHostedAuthLink = jest.fn()
      .mockRejectedValueOnce(networkError('ECONNRESET'))
      .mockResolvedValue({ url: 'https://unipile.example.com/auth/xyz' });
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app).get('/api/oauth/linkedin-outreach/init');

    expect(res.status).toBe(200);
    expect(createHostedAuthLink).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  }, 10000);
});

describe('POST /api/oauth/linkedin-outreach/reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retries through a transient Unipile gateway error and succeeds', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    const createHostedAuthLink = jest.fn()
      .mockRejectedValueOnce(htmlGatewayError())
      .mockRejectedValueOnce(htmlGatewayError())
      .mockResolvedValue({ url: 'https://unipile.example.com/auth/reconnect' });
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/reconnect')
      .send({ unipileAccountId: 'acc-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, url: 'https://unipile.example.com/auth/reconnect' });
    expect(createHostedAuthLink).toHaveBeenCalledTimes(3);
    jest.restoreAllMocks();
  }, 10000);

  it('gives a provider-outage message once retries are exhausted on a transient error', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    const createHostedAuthLink = jest.fn().mockRejectedValue(htmlGatewayError());
    (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue({
      account: { createHostedAuthLink },
    });

    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/reconnect')
      .send({ unipileAccountId: 'acc-1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
    jest.restoreAllMocks();
  }, 10000);
});
