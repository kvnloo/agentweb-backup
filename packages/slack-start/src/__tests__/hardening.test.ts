/**
 * ENG-2782 S2 — embed hardening (local CodeRabbit review):
 * host-page theming must win, strict-CSP hosts need a nonce, a garbled 2xx must
 * not be treated as success, and a Turnstile load without its global must surface.
 */
import { createApiClient, ApiError } from '../api';
import { CSS, STYLE_ID, injectStyles } from '../styles';
import { mountTurnstile } from '../captcha';
import { openSlackStart, closeAllSlackStart } from '../mount';
import { createFakeApi } from './fakeApi';

afterEach(() => {
  closeAllSlackStart();
  document.getElementById(STYLE_ID)?.remove();
});

describe('theming', () => {
  it('never declares theme variables on the wizard root, so values set by the host page are inherited', () => {
    const rootRule = CSS.match(/\.aw-ss-root\{[^}]*\}/)![0];
    expect(rootRule).not.toMatch(/--aw-ss-[a-z-]+:/);
  });

  it('gives every theme variable a fallback at its use site', () => {
    const uses = CSS.match(/var\(--aw-ss-[a-z-]+[^)]*\)/g) ?? [];
    expect(uses.length).toBeGreaterThan(10);
    for (const use of uses) expect(use).toMatch(/var\(--aw-ss-[a-z-]+,\s*[^)]+\)/);
  });
});

describe('CSP nonce', () => {
  it('stamps the injected stylesheet with the host nonce', () => {
    injectStyles(document, 'n0nce');
    expect(document.getElementById(STYLE_ID)!.getAttribute('nonce')).toBe('n0nce');
  });

  it('passes a nonce given to openSlackStart through to the stylesheet', () => {
    const api = createFakeApi();
    openSlackStart({ apiBase: api.base, fetch: api.fetch, nonce: 'from-option' });
    expect(document.getElementById(STYLE_ID)!.getAttribute('nonce')).toBe('from-option');
  });
});

describe('api client', () => {
  const respond = (status: number, body: string) => (async () => new Response(body === '' ? null : body, { status })) as unknown as typeof fetch;

  it('rejects a 2xx whose body is not JSON instead of treating it as success', async () => {
    const client = createApiClient('https://api.test', respond(200, '<html>proxy page</html>'));
    await expect(client.config()).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
    await expect(client.config()).rejects.toBeInstanceOf(ApiError);
  });

  it('accepts an empty 204', async () => {
    const client = createApiClient('https://api.test', respond(204, ''));
    await expect(client.answer('i', 't', { source: 'x' }, 2)).resolves.toBeNull();
  });
});

describe('captcha loader', () => {
  it('reports an error when the script loads but exposes no turnstile global', async () => {
    const onError = vi.fn();
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node: any) => {
      queueMicrotask(() => node.onload?.());
      return node;
    });
    mountTurnstile(document.createElement('div'), 'site', vi.fn(), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    append.mockRestore();
  });
});
