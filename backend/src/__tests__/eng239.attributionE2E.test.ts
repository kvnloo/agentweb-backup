/**
 * ENG-239 AC2 — end-to-end attribution chain (mocked platforms).
 *
 *   "A lead arriving on an Emma landing page from such an ad lands in the CRM
 *    with source attribution populated (end-to-end test with mocked platforms)."
 *
 * Every link in this chain has been unit-tested in isolation and the chain as a
 * whole has never been proven: in production, 0 of 225,981 leads carry
 * attribution, because the capture middleware has never once executed. This test
 * is that proof, so it runs REAL code at every link it can:
 *
 *   1. TAG    — `adUtm.ts` (`buildUtmSpec` / `utmQueryString` /
 *               `mergeUtmIntoQueryString` / `mergeUtmIntoUrl`), the exact
 *               functions metaService / googleAdsService / linkedInAdsService
 *               call, with the same macro arguments they pass.
 *               SIMULATED: the platform's click-time append + macro resolution
 *               (Meta appends `url_tags`, Google appends `final_url_suffix`, and
 *               both substitute `{{ad.id}}` / `{creative}` for a real id). That
 *               happens on the platform, not in our process, so `clickUrlFrom*`
 *               below reproduces it — the click URL carries RESOLVED ids.
 *   2. CAPTURE— the landing page's `middleware.ts`. It is generated as a STRING
 *               by `injectLeadCaptureAttribution`, so it cannot be imported —
 *               instead we take that exact string, transpile it, and EXECUTE it
 *               against a fake `next/server`. No re-implementation of the parse
 *               exists in this file, so it cannot drift from the real thing.
 *               (`middleware contract` below additionally pins the key set.)
 *   3. FORWARD— the generated `app/api/capture/route.ts` string, executed the
 *               same way, with `fetch` wired to supertest against the REAL
 *               express `/api/webhooks/forward-lead` route.
 *   4. PERSIST— the real `crmDb.createLead` → real `buildLeadAttributionFields`
 *               → the DynamoDB `put` for `AW-Leads`, captured off a fake
 *               DocumentClient and asserted on.
 *
 * The only hand-carried step is the browser's cookie transport (middleware
 * `Set-Cookie` → the cookie the capture route reads), which is the browser's job.
 */
import express from 'express';
import request from 'supertest';
import * as ts from 'typescript';

import webhookRouter from '../routes/webhooks';
import { crmDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';
import { resendService } from '../services/resendService';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { injectLeadCaptureAttribution } from '../services/v0Service';
import {
  UTM_KEYS,
  buildUtmSpec,
  mergeUtmIntoQueryString,
  mergeUtmIntoUrl,
  readUtmKeys,
  utmQueryString,
} from '../utils/adUtm';

// ─── DynamoDB: fake DocumentClient that records every write ───────────────────
// The persist link must be REAL (`crmDb.createLead` → `buildLeadAttributionFields`
// → the item), so `services/db` is only partially mocked (below) and the writes
// are intercepted at the AWS SDK boundary instead.
const mockDynamoWrites: Array<{ TableName: string; Item: any }> = [];

jest.mock('aws-sdk', () => {
  const base = jest.requireActual<any>('../__mocks__/aws-sdk');
  function DocumentClient(this: any) {
    return {
      get: () => ({ promise: async () => ({}) }),
      put: (params: any) => {
        mockDynamoWrites.push(params);
        return { promise: async () => ({}) };
      },
      update: () => ({ promise: async () => ({}) }),
      delete: () => ({ promise: async () => ({}) }),
      scan: () => ({ promise: async () => ({ Items: [] }) }),
      query: () => ({ promise: async () => ({ Items: [] }) }),
    };
  }
  const patched = {
    ...base,
    DynamoDB: { ...base.DynamoDB, DocumentClient },
  };
  return { ...patched, default: patched };
});

// `crmDb.createLead` stays REAL. Only its list/dup lookups and the bookkeeping
// writes are stubbed, so the item that reaches DynamoDB is built by production code.
jest.mock('../services/db', () => {
  const actual = jest.requireActual<any>('../services/db');
  return {
    ...actual,
    crmDb: {
      ...actual.crmDb,
      createLead: actual.crmDb.createLead,
      getLeadListById: jest.fn(),
      getLeadByEmail: jest.fn(),
      updateLead: jest.fn(),
      updateFieldNames: jest.fn(),
      incrementLeadCount: jest.fn(),
      getLeadById: jest.fn(),
    },
  };
});

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getSequencesByAutoEnrollList: jest.fn(),
    bulkEnroll: jest.fn(),
  },
}));

jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    autoSyncLead: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLeadListOwnerIfConfigured: jest.fn(),
  },
}));

jest.mock('../services/leadCaptureFailureService', () => ({
  recordLeadCaptureFailure: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    updateEmailDraftForLead: jest.fn(),
    getCrmSenders: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
    sendSystemEmail: jest.fn(),
  },
}));

jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(),
    verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(),
    generateEventId: jest.fn(),
  },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    eventExists: jest.fn(),
    addEmailEvent: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const LIST_ID = 'list_eng239';
const LANDING_PAGE = 'https://acme-lander.vercel.app/';

const mockLeadList = {
  listId: LIST_ID,
  userId: 'user_eng239',
  name: 'ENG-239 lander list',
  publicAccessEnabled: true,
};

// ─── Link 1: TAG (real adUtm; platform click-time append simulated) ───────────

/** Resolved ids the platform substitutes into its macros at click time. */
const META_CAMPAIGN_ID = '23851234567890123';
const META_AD_ID = '120001';
const GOOGLE_CAMPAIGN_ID = '9876543210';
const GOOGLE_CREATIVE_ID = '654321987';
const LINKEDIN_CAMPAIGN_ID = '506070';

/**
 * Meta. `metaService.resolveUrlTags` builds `url_tags` from
 * `buildUtmSpec('meta', { campaign: '{{campaign.id}}', content: '{{ad.id}}' })`
 * (metaService.ts:968), omitting keys already on `link_url` (AC4). Meta then
 * appends that string to `link_url` at click time, with macros resolved.
 */
function clickUrlFromMetaAd(linkUrl: string): string {
  const urlKeys = readUtmKeys(linkUrl);
  if (!urlKeys) throw new Error('unreadable link_url');
  const spec = buildUtmSpec('meta', { campaign: '{{campaign.id}}', content: '{{ad.id}}' });
  const urlTags = utmQueryString(spec, urlKeys);
  expect(urlTags).toContain('utm_content={{ad.id}}'); // macro reaches Meta un-encoded
  const resolved = urlTags
    .replace('{{campaign.id}}', META_CAMPAIGN_ID)
    .replace('{{ad.id}}', META_AD_ID);
  return appendQuery(linkUrl, resolved);
}

/**
 * Google. `googleAdsService.buildAdFinalUrlSuffix` builds `final_url_suffix` from
 * `buildUtmSpec('google', { campaign: '{campaignid}', content: '{creative}' })`
 * merged into any inherited campaign-level suffix (googleAdsService.ts:702-705).
 * Google appends the suffix to the final URL at click time, macros resolved.
 */
function clickUrlFromGoogleAd(finalUrl: string, inheritedSuffix?: string): string {
  const urlKeys = readUtmKeys(finalUrl);
  if (!urlKeys) throw new Error('unreadable finalUrl');
  const spec = buildUtmSpec('google', { campaign: '{campaignid}', content: '{creative}' });
  const suffix = mergeUtmIntoQueryString(inheritedSuffix, spec, urlKeys);
  const resolved = suffix
    .replace('{campaignid}', GOOGLE_CAMPAIGN_ID)
    .replace('{creative}', GOOGLE_CREATIVE_ID);
  return appendQuery(finalUrl, resolved);
}

/**
 * LinkedIn. `linkedInAdsService.appendLinkedInUtm` bakes the params straight into
 * the destination URL at create time (no macros, no `utm_content`), so the click
 * URL IS the stored destination URL — nothing is appended at click time.
 */
function clickUrlFromLinkedInAd(landingPage: string): string {
  return mergeUtmIntoUrl(landingPage, buildUtmSpec('linkedin', { campaign: LINKEDIN_CAMPAIGN_ID }));
}

/** What the ad platform does at delivery: concatenate its append-field onto the link. */
function appendQuery(url: string, query: string): string {
  if (!query) return url;
  return url.includes('?') ? `${url}&${query}` : `${url}?${query}`;
}

// ─── Links 2+3: run the GENERATED middleware / capture-route source ───────────

const injectedFiles = injectLeadCaptureAttribution([], LIST_ID);
const middlewareSource = fileContent(injectedFiles, 'middleware.ts');
const captureRouteSource = fileContent(injectedFiles, 'app/api/capture/route.ts');

function fileContent(files: Array<{ path: string; content: Buffer }>, path: string): string {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`injectLeadCaptureAttribution did not emit ${path}`);
  return file.content.toString('utf-8');
}

/** Transpile one of the injected TS strings and execute it with a stubbed `require`. */
function loadInjected(source: string, requireShim: (moduleName: string) => unknown): any {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} as any };
  // eslint-disable-next-line no-new-func
  const factory = new Function('require', 'module', 'exports', js);
  factory(requireShim, mod, mod.exports);
  return mod.exports;
}

type CookieJar = Record<string, string>;

/**
 * A visit to the landing page: runs the REAL generated middleware over the click
 * URL and returns the cookies it set (the browser then carries them).
 */
function visitLandingPage(clickUrl: string, referrer = 'https://www.facebook.com/'): CookieJar {
  const jar: CookieJar = {};
  const nextServer = {
    NextResponse: {
      next: () => ({
        cookies: {
          set: (name: string, value: string) => {
            jar[name] = value;
          },
        },
      }),
    },
  };
  const middleware = loadInjected(middlewareSource, (m) => {
    if (m === 'next/server') return nextServer;
    throw new Error(`middleware.ts required an unexpected module: ${m}`);
  }).middleware;

  const nextUrl = new URL(clickUrl);
  middleware({
    cookies: { get: (name: string) => (jar[name] ? { name, value: jar[name] } : undefined) },
    nextUrl,
    headers: { get: (h: string) => (h.toLowerCase() === 'referer' ? referrer : null) },
  });
  return jar;
}

interface ForwardCall {
  url: string;
  body: any;
  status: number;
}

/**
 * A form submit on the landing page: runs the REAL generated capture route with
 * the cookie jar from the visit, and pipes its `fetch` into the real express app.
 */
async function submitLeadForm(
  jar: CookieJar,
  form: Record<string, string>,
): Promise<{ routeResponse: any; forwarded: ForwardCall }> {
  let forwarded: ForwardCall | undefined;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const res = await request(app)
      .post(new URL(url).pathname)
      .set('Content-Type', 'application/json')
      .send(body);
    forwarded = { url, body, status: res.status };
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  };

  try {
    const nextServer = {
      NextResponse: {
        json: (body: any, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
      },
    };
    const nextHeaders = {
      cookies: async () => ({
        get: (name: string) => (jar[name] ? { name, value: jar[name] } : undefined),
      }),
    };
    const route = loadInjected(captureRouteSource, (m) => {
      if (m === 'next/server') return nextServer;
      if (m === 'next/headers') return nextHeaders;
      throw new Error(`capture route required an unexpected module: ${m}`);
    });

    const routeResponse = await route.POST({ json: async () => form });
    if (!forwarded) throw new Error('capture route never called the forward-lead webhook');
    return { routeResponse, forwarded };
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

/** The full chain: ad click → landing page → form submit → CRM row. */
async function clickThroughToCrm(
  clickUrl: string,
  form: Record<string, string>,
  referrer?: string,
): Promise<{ lead: any; forwarded: ForwardCall; cookie: any }> {
  const jar = visitLandingPage(clickUrl, referrer);
  const { forwarded } = await submitLeadForm(jar, form);
  await new Promise((resolve) => setImmediate(resolve));
  const leadWrites = mockDynamoWrites.filter((w) => w.TableName === 'AW-Leads');
  return {
    lead: leadWrites.length === 1 ? leadWrites[0].Item : undefined,
    forwarded,
    cookie: jar.aw_first_touch ? JSON.parse(jar.aw_first_touch) : undefined,
  };
}

describe('ENG-239 AC2 — ad click → landing page → CRM, end to end', () => {
  beforeEach(() => {
    mockDynamoWrites.length = 0;
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    (crmDb as any).updateFieldNames.mockResolvedValue(undefined);
    (crmDb as any).incrementLeadCount.mockResolvedValue(undefined);
    (agentModeService.updateEmailDraftForLead as jest.Mock).mockResolvedValue({ success: true });
    (resendService.sendSystemEmail as jest.Mock).mockResolvedValue({ id: 'email_1' });
    (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([]);
    (externalCrmSyncService.autoSyncLead as jest.Mock).mockResolvedValue(undefined);
  });

  // ── The contract guard: the injected middleware must still read what we tag ──
  describe('injected middleware contract (pins the test to the real capture code)', () => {
    it('still reads exactly the five UTM keys that adUtm emits', () => {
      const keyList = middlewareSource.match(/for \(const k of \[([^\]]+)\]\)/);
      expect(keyList).not.toBeNull();
      const suffixes = keyList![1].split(',').map((s) => s.trim().replace(/"/g, ''));
      expect(suffixes.map((s) => `utm_${s}`)).toEqual([...UTM_KEYS]);
      expect(middlewareSource).toContain('sp.get("utm_" + k)');
      expect(middlewareSource).toContain('const COOKIE = "aw_first_touch"');
    });

    it('still reads the four ad-platform click ids', () => {
      expect(middlewareSource).toContain(
        '[["gclid","gclid"],["fbclid","fbclid"],["ttclid","ttclid"],["li_fat_id","liFatId"]]',
      );
    });

    it('capture route still POSTs `attribution` top-level to /api/webhooks/forward-lead', () => {
      expect(captureRouteSource).toContain('/api/webhooks/forward-lead');
      expect(captureRouteSource).toContain(
        '...(attribution ? { attribution } : {})',
      );
      expect(captureRouteSource).toContain(`const LIST_ID = "${LIST_ID}"`);
    });
  });

  // ── Case 1: happy path per platform ──────────────────────────────────────────
  it('Meta ad click lands a lead with meta/paid attribution and the resolved ad id', async () => {
    const clickUrl = clickUrlFromMetaAd(LANDING_PAGE);
    expect(clickUrl).toBe(
      `${LANDING_PAGE}?utm_source=meta&utm_medium=paid&utm_campaign=${META_CAMPAIGN_ID}&utm_content=${META_AD_ID}`,
    );

    const { lead, forwarded } = await clickThroughToCrm(clickUrl, {
      email: 'Meta.Lead@Acme.io',
      firstName: 'Mia',
    });

    // The capture route forwarded attribution TOP-LEVEL (not inside customFields).
    expect(forwarded.status).toBe(201);
    expect(forwarded.body.attribution.utm).toEqual({
      source: 'meta',
      medium: 'paid',
      campaign: META_CAMPAIGN_ID,
      content: META_AD_ID,
    });
    expect(forwarded.body.customFields).toBeUndefined();
    expect(forwarded.body.listId).toBe(LIST_ID);
    expect(forwarded.body.source).toBe('landing-page');

    // The AW-Leads row.
    expect(lead).toBeDefined();
    expect(lead.email).toBe('meta.lead@acme.io');
    expect(lead.firstTouch.utm).toEqual({
      source: 'meta',
      medium: 'paid',
      campaign: META_CAMPAIGN_ID,
      content: META_AD_ID,
    });
    expect(lead.firstTouch.landingUrl).toBe(clickUrl);
    expect(lead.lastTouch.utm.source).toBe('meta');
    // Denormalized fields — 0 of 225,981 prod leads have these.
    expect(lead.utmSource).toBe('meta');
    expect(lead.utmMedium).toBe('paid');
    expect(lead.customFields.source).toBe('landing-page');

    // And the attribution.first_touch contact event fires (0 of these in prod).
    const events = mockDynamoWrites.filter((w) => w.TableName === 'AW-ContactEvents');
    expect(events).toHaveLength(1);
    expect(events[0].Item.eventType).toBe('attribution.first_touch');
    expect(events[0].Item.payload.utmSource).toBe('meta');
    expect(events[0].Item.payload.utmCampaign).toBe(META_CAMPAIGN_ID);
  });

  it('Google ad click lands a lead with google/paid attribution and the resolved creative id', async () => {
    const clickUrl = clickUrlFromGoogleAd(LANDING_PAGE);
    expect(clickUrl).toBe(
      `${LANDING_PAGE}?utm_source=google&utm_medium=paid&utm_campaign=${GOOGLE_CAMPAIGN_ID}&utm_content=${GOOGLE_CREATIVE_ID}`,
    );

    const { lead } = await clickThroughToCrm(clickUrl, { email: 'google.lead@acme.io' }, 'https://www.google.com/');

    expect(lead.firstTouch.utm).toEqual({
      source: 'google',
      medium: 'paid',
      campaign: GOOGLE_CAMPAIGN_ID,
      content: GOOGLE_CREATIVE_ID,
    });
    expect(lead.utmSource).toBe('google');
    expect(lead.utmMedium).toBe('paid');
  });

  it("Google ad click preserves the client's inherited campaign-level suffix (AC4)", async () => {
    const clickUrl = clickUrlFromGoogleAd(LANDING_PAGE, 'clientparam=1&utm_source=partner');

    const { lead } = await clickThroughToCrm(clickUrl, { email: 'inherited@acme.io' });

    // The inherited utm_source wins; we only filled in what the client had not set.
    expect(lead.firstTouch.utm.source).toBe('partner');
    expect(lead.firstTouch.utm.medium).toBe('paid');
    expect(lead.utmSource).toBe('partner');
    expect(clickUrl).toContain('clientparam=1');
  });

  it('LinkedIn ad click lands a lead with linkedin/paid attribution and NO utm_content', async () => {
    const clickUrl = clickUrlFromLinkedInAd(LANDING_PAGE);
    expect(clickUrl).toBe(
      `${LANDING_PAGE}?utm_source=linkedin&utm_medium=paid&utm_campaign=${LINKEDIN_CAMPAIGN_ID}`,
    );
    expect(clickUrl).not.toContain('utm_content');

    const { lead } = await clickThroughToCrm(
      clickUrl,
      { email: 'li.lead@acme.io' },
      'https://www.linkedin.com/',
    );

    expect(lead.firstTouch.utm).toEqual({
      source: 'linkedin',
      medium: 'paid',
      campaign: LINKEDIN_CAMPAIGN_ID,
    });
    expect(lead.firstTouch.utm.content).toBeUndefined();
    expect(lead.utmSource).toBe('linkedin');
    expect(lead.utmMedium).toBe('paid');
  });

  // ── Case 2: the regression this whole ticket exists to prevent ───────────────
  it('UNTAGGED ad click still creates the lead, but with no utm.source — the current prod state', async () => {
    const clickUrl = LANDING_PAGE; // an ad Emma deployed before ENG-239: no UTMs at all

    const { lead, forwarded, cookie } = await clickThroughToCrm(clickUrl, {
      email: 'untagged@acme.io',
    });

    // The lead is NOT lost — capture still runs, the row is still written.
    expect(forwarded.status).toBe(201);
    expect(lead).toBeDefined();
    expect(lead.email).toBe('untagged@acme.io');

    // But there is no source attribution. This is exactly what 225,981 prod rows
    // look like, and it is what the happy paths above must never silently become.
    expect(cookie.utm).toBeUndefined();
    expect(lead.firstTouch.utm).toBeUndefined();
    expect(lead.utmSource).toBeUndefined();
    expect(lead.utmMedium).toBeUndefined();
  });

  // ── Case 3: AC4 end-to-end ───────────────────────────────────────────────────
  it('AC4 — a user-supplied utm_source=newsletter survives all the way into the CRM row', async () => {
    const userUrl = `${LANDING_PAGE}?utm_source=newsletter`;
    const clickUrl = clickUrlFromMetaAd(userUrl);

    // Emma filled in only the keys the user had not set; it did NOT overwrite theirs.
    expect(clickUrl).toBe(
      `${userUrl}&utm_medium=paid&utm_campaign=${META_CAMPAIGN_ID}&utm_content=${META_AD_ID}`,
    );
    expect(clickUrl.match(/utm_source=/g)).toHaveLength(1);

    const { lead } = await clickThroughToCrm(clickUrl, { email: 'ac4@acme.io' });

    expect(lead.firstTouch.utm.source).toBe('newsletter');
    expect(lead.firstTouch.utm.source).not.toBe('meta');
    expect(lead.utmSource).toBe('newsletter');
    // The rest of the spec still lands.
    expect(lead.firstTouch.utm.medium).toBe('paid');
    expect(lead.firstTouch.utm.campaign).toBe(META_CAMPAIGN_ID);
  });

  // ── Case 4: click ids ────────────────────────────────────────────────────────
  it('fbclid on a Meta click URL survives into firstTouch.clickIds', async () => {
    const clickUrl = `${clickUrlFromMetaAd(LANDING_PAGE)}&fbclid=IwAR0_fake_fbclid_123`;

    const { lead } = await clickThroughToCrm(clickUrl, { email: 'fbclid@acme.io' });

    expect(lead.firstTouch.clickIds).toEqual({ fbclid: 'IwAR0_fake_fbclid_123' });
    expect(lead.firstTouch.utm.source).toBe('meta');
  });

  it('gclid on a Google click URL survives into firstTouch.clickIds', async () => {
    const clickUrl = `${clickUrlFromGoogleAd(LANDING_PAGE)}&gclid=Cj0KCQ_fake_gclid_456`;

    const { lead } = await clickThroughToCrm(
      clickUrl,
      { email: 'gclid@acme.io' },
      'https://www.google.com/',
    );

    expect(lead.firstTouch.clickIds).toEqual({ gclid: 'Cj0KCQ_fake_gclid_456' });
    expect(lead.firstTouch.utm.source).toBe('google');
  });
});
