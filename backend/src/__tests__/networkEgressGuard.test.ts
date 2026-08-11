/**
 * ENG-1111 — behavioral contract for the outbound network egress guard.
 *
 * These assert against the guard that `setup.ts` has already installed globally, not a
 * freshly constructed one, so they prove the shipped configuration blocks egress rather
 * than proving a local instance can.
 *
 * Red proof: running this file with `NETWORK_GUARD_MODE=off` makes the blocking tests
 * below fail, which is what confirms they are testing the guard and not a tautology.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';

import {
  EGRESS_ALLOWLIST,
  NetworkEgressBlockedError,
  extractFetchUrl,
  extractNodeRequestUrl,
  isLocalHostname,
  redactUrl,
  resolveMode,
} from './networkEgressGuard';

describe('ENG-1111 network egress guard', () => {
  describe('AC1 — a request to a non-local host fails loudly', () => {
    it('rejects a fetch to a third-party host instead of performing it', async () => {
      await expect(fetch('https://api.resend.com/emails')).rejects.toBeInstanceOf(
        NetworkEgressBlockedError
      );
    });

    it('names the attempted URL and the running test in the error message', async () => {
      let caught: NetworkEgressBlockedError | undefined;
      try {
        await fetch('https://www.googleapis.com/webmasters/v3/sites');
      } catch (error) {
        caught = error as NetworkEgressBlockedError;
      }

      expect(caught).toBeInstanceOf(NetworkEgressBlockedError);
      // The URL the caller attempted.
      expect(caught!.message).toContain('https://www.googleapis.com/webmasters/v3/sites');
      expect(caught!.message).toContain('www.googleapis.com');
      // The test that issued it, so an offender is identifiable from CI output alone.
      expect(caught!.message).toContain('names the attempted URL and the running test');
      expect(caught!.violation.testPath).toContain('networkEgressGuard.test.ts');
    });

    it('rejects rather than hanging, so an offender cannot burn the test timeout', async () => {
      const startedAt = Date.now();
      await expect(fetch('https://docs.agentweb.pro/llms-full.txt')).rejects.toThrow(
        /network egress guard/
      );
      // A real round trip to this host took ~5s in the ENG-1111 measurement run.
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it('blocks a fetch given a URL object, not just a string', async () => {
      await expect(
        fetch(new URL('https://test.openai.azure.com/openai/deployments'))
      ).rejects.toBeInstanceOf(NetworkEgressBlockedError);
    });

    it('blocks a fetch given a Request object', async () => {
      await expect(
        fetch(new Request('https://api.resend.com/emails', { method: 'POST' }))
      ).rejects.toBeInstanceOf(NetworkEgressBlockedError);
    });

    it('blocks node https.request to a third-party host', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const https = require('https');
      expect(() => https.request('https://www.googleapis.com/oauth2/v4/token')).toThrow(
        NetworkEgressBlockedError
      );
    });

    it('blocks node https.request given an options object', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const https = require('https');
      expect(() =>
        https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST' })
      ).toThrow(/api\.resend\.com/);
    });

    it('blocks node http.get to a third-party host', () => {
      expect(() => http.get('http://docs.agentweb.pro/llms-full.txt')).toThrow(
        NetworkEgressBlockedError
      );
    });

    it('redacts the query string, which routinely carries API keys', async () => {
      let caught: NetworkEgressBlockedError | undefined;
      try {
        await fetch('https://www.googleapis.com/customsearch?key=SUPER_SECRET_KEY');
      } catch (error) {
        caught = error as NetworkEgressBlockedError;
      }
      expect(caught!.message).not.toContain('SUPER_SECRET_KEY');
      expect(caught!.message).toContain('?<redacted>');
    });
  });

  describe('AC2 — loopback and in-process transports keep working', () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('allows a fetch to 127.0.0.1 and returns the real response', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    });

    it('allows a fetch to localhost by name', async () => {
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
    });

    it('allows node http.request to loopback', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
    });

    it('treats every loopback form as local', () => {
      for (const host of ['localhost', '127.0.0.1', '127.0.0.53', '::1', '[::1]', '0.0.0.0', 'api.localhost']) {
        expect(isLocalHostname(host)).toBe(true);
      }
    });

    it('does not treat a private-LAN or public host as local', () => {
      // Deliberately narrow: a LAN allowance would let a test reach a real box in CI's VPC.
      for (const host of ['10.0.0.5', '192.168.1.10', 'docs.agentweb.pro', 'api.resend.com', 'localhost.evil.com']) {
        expect(isLocalHostname(host)).toBe(false);
      }
    });
  });

  describe('AC3 — the guard may not be weakened to accommodate offenders', () => {
    it('keeps the allowlist empty', () => {
      // An entry here is a hole in the guard, not a config knob. If one is ever needed
      // it must be narrowly scoped and carry a written reason — this assertion forces
      // that decision to be made deliberately, in review, rather than drifting in.
      expect(EGRESS_ALLOWLIST).toEqual([]);
    });

    it('every allowlist entry, if any is ever added, carries a reason', () => {
      for (const entry of EGRESS_ALLOWLIST) {
        expect(typeof entry.host).toBe('string');
        expect(entry.host.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(20);
      }
    });

    it('defaults to enforce, so an unset or misspelled env var cannot silently disable it', () => {
      expect(resolveMode({} as NodeJS.ProcessEnv)).toBe('enforce');
      expect(resolveMode({ NETWORK_GUARD_MODE: 'nonsense' } as never)).toBe('enforce');
      expect(resolveMode({ NETWORK_GUARD_MODE: '' } as never)).toBe('enforce');
      expect(resolveMode({ NETWORK_GUARD_MODE: 'report' } as never)).toBe('report');
      expect(resolveMode({ NETWORK_GUARD_MODE: 'off' } as never)).toBe('off');
    });
  });

  describe('URL extraction helpers', () => {
    it('extracts a fetch URL from a string, URL, or Request', () => {
      expect(extractFetchUrl('https://example.com/a')).toBe('https://example.com/a');
      expect(extractFetchUrl(new URL('https://example.com/b'))).toBe('https://example.com/b');
      expect(extractFetchUrl(new Request('https://example.com/c'))).toBe('https://example.com/c');
    });

    it('reconstructs a node request URL from an options object', () => {
      expect(
        extractNodeRequestUrl([{ hostname: 'example.com', port: 8443, path: '/x' }], 'https:')
      ).toEqual({ url: 'https://example.com:8443/x', host: 'example.com' });
    });

    it('strips a port baked into options.host', () => {
      expect(extractNodeRequestUrl([{ host: 'example.com:443', path: '/y' }], 'https:')).toEqual({
        url: 'https://example.com/y',
        host: 'example.com',
      });
    });

    it('returns null when no host can be determined', () => {
      expect(extractNodeRequestUrl([{ path: '/no-host' }], 'https:')).toBeNull();
      expect(extractNodeRequestUrl([], 'https:')).toBeNull();
    });

    it('leaves a URL without a query string untouched when redacting', () => {
      expect(redactUrl('https://example.com/a')).toBe('https://example.com/a');
      expect(redactUrl('https://example.com/a?k=v')).toBe('https://example.com/a?<redacted>');
    });
  });
});
