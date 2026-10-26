import vm from 'vm';
import ts from 'typescript';
import { applyConsentModeToLayout, applyConsentModeToLayoutFiles, CONSENT_COOKIE } from '../consentInjection';
import { injectPixelIntoLayout } from '../pixelInjection';
import { injectGoogleAdsIntoLayout } from '../googleAdsInjection';

// ENG-2667: consent banner + Consent Mode v2, executed against a minimal fake DOM.

const BASE = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
      </head>
      <body>
        {children}
        <form id="lead"><input name="email" /></form>
      </body>
    </html>
  );
}
`;

const tracked = injectGoogleAdsIntoLayout(injectPixelIntoLayout(BASE, '1234567890'), 'AW-123456789');

function scripts(layout: string): string[] {
  return [...layout.matchAll(/__html: `([\s\S]*?)` \}\} \/>/g)].map((m) => m[1]);
}

function makeEnv(cookie = '') {
  const jar: Record<string, string> = {};
  for (const c of cookie.split('; ').filter(Boolean)) jar[c.split('=')[0]] = c.split('=')[1];
  const inserted: string[] = [];
  const body: any[] = [];
  const els: Record<string, any> = {};
  const mk = (tag: string) => {
    const el: any = {
      tag, children: [] as any[], style: {}, attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) { el.attrs[k] = v; },
      appendChild(c: any) { el.children.push(c); },
      remove() { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); delete els[el.id]; },
    };
    return el;
  };
  const document: any = {
    get cookie() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(v: string) { const [kv] = v.split(';'); const [k, val] = kv.split('='); jar[k.trim()] = val; },
    createElement: mk,
    getElementsByTagName: () => [{ parentNode: { insertBefore: (t: any) => inserted.push(t.src) } }],
    getElementById: (id: string) => els[id] ?? null,
    body: { appendChild: (el: any) => { body.push(el); els[el.id] = el; } },
  };
  const window: any = { document };
  window.window = window;
  const ctx = vm.createContext(window);
  return { ctx, window, jar, inserted, body, run: (src: string) => vm.runInContext(src, ctx) };
}

function load(layout: string, cookie = '') {
  const env = makeEnv(cookie);
  for (const s of scripts(layout)) env.run(s);
  return env;
}

const consentLayout = applyConsentModeToLayout(tracked, 'consent');

describe('applyConsentModeToLayout (ENG-2667)', () => {
  it("is byte-identical for 'on', 'off' and undefined", () => {
    expect(applyConsentModeToLayout(tracked, 'on')).toBe(tracked);
    expect(applyConsentModeToLayout(tracked, 'off')).toBe(tracked);
    expect(applyConsentModeToLayout(tracked, undefined)).toBe(tracked);
  });

  it('emits consent default=denied for all four signals before any Google tag', () => {
    const env = load(consentLayout);
    const first = env.window.dataLayer[0];
    expect(first[0]).toBe('consent');
    expect(first[1]).toBe('default');
    expect(first[2]).toMatchObject({ ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    expect(consentLayout.indexOf('AgentWeb Consent Default')).toBeLessThan(consentLayout.indexOf('googletagmanager.com'));
    expect(consentLayout.indexOf('AgentWeb Consent Default')).toBeLessThan(consentLayout.indexOf('Meta Pixel Code'));
  });

  it('pre-consent: Meta Pixel never loads/inits, no non-essential cookie set, banner shown', () => {
    const env = load(consentLayout);
    expect(env.inserted).toEqual([]);
    expect(env.window.fbq).toBeUndefined();
    expect(Object.keys(env.jar)).toEqual([]);
    expect(env.body.map((e) => e.id)).toEqual(['aw-consent-banner']);
    expect(consentLayout).not.toContain('<noscript><img');
  });

  function click(env: ReturnType<typeof makeEnv>, choice: string) {
    const btn = env.body[0].children.find((c: any) => c.attrs['data-aw-consent'] === choice);
    btn.onclick();
  }

  it('Accept persists granted, updates consent and inits the pixel', () => {
    const env = load(consentLayout);
    click(env, 'granted');
    expect(env.jar[CONSENT_COOKIE]).toBe('granted');
    expect(env.inserted).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
    expect(env.window.fbq.queue.map((a: any) => a[0])).toEqual(['init', 'track']);
    const upd = env.window.dataLayer.find((e: any) => e[0] === 'consent' && e[1] === 'update');
    expect(upd[2]).toMatchObject({ ad_storage: 'granted', ad_user_data: 'granted' });
    expect(env.body).toEqual([]);
  });

  it('Reject persists denied and sets nothing else', () => {
    const env = load(consentLayout);
    click(env, 'denied');
    expect(env.jar).toEqual({ [CONSENT_COOKIE]: 'denied' });
    expect(env.inserted).toEqual([]);
    expect(env.window.dataLayer.some((e: any) => e[1] === 'update')).toBe(false);
    expect(env.body).toEqual([]);
  });

  it('returning visitors: granted inits immediately without banner; denied stays silent', () => {
    const g = load(consentLayout, `${CONSENT_COOKIE}=granted`);
    expect(g.inserted.length).toBe(1);
    expect(g.body).toEqual([]);
    const d = load(consentLayout, `${CONSENT_COOKIE}=denied`);
    expect(d.inserted).toEqual([]);
    expect(d.body).toEqual([]);
  });

  it('leaves the lead form untouched and is idempotent', () => {
    expect(consentLayout).toContain('<form id="lead"><input name="email" /></form>');
    expect(applyConsentModeToLayout(consentLayout, 'consent')).toBe(consentLayout);
  });

  it('files helper only mutates in consent mode', () => {
    const files = [{ path: 'app/layout.tsx', content: Buffer.from(tracked) }];
    expect(applyConsentModeToLayoutFiles(files, 'on')).toBe(false);
    expect(files[0].content.toString()).toBe(tracked);
    expect(applyConsentModeToLayoutFiles(files, 'consent')).toBe(true);
    expect(files[0].content.toString()).toBe(consentLayout);
  });

  it('emitted layout still parses as TSX', () => {
    const r = ts.transpileModule(consentLayout, { reportDiagnostics: true, fileName: 'layout.tsx', compilerOptions: { jsx: ts.JsxEmit.Preserve } });
    expect(r.diagnostics).toEqual([]);
  });
});
