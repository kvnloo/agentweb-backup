/**
 * ENG-2430 acceptance: dry-run planner/CLI/mock endpoint returns the Meta objects it WOULD
 * create, validates specs, and makes zero network calls (no Meta Graph access).
 */
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { planPublish } from '../adsPublisherDemo/planner';
import { handlePublish } from '../adsPublisherDemo/server';
import { runCli } from '../adsPublisherDemo/cli';

const SAMPLES = path.join(__dirname, '..', 'adsPublisherDemo', 'samples');
const sample = (f: string) => JSON.parse(fs.readFileSync(path.join(SAMPLES, f), 'utf8'));

describe('ENG-2430 Ads Auto Publisher demo', () => {
  let netSpies: jest.SpyInstance[] = [];
  const fetchSpy = jest.fn();
  const realFetch = (global as { fetch?: unknown }).fetch;

  beforeEach(() => {
    (global as { fetch?: unknown }).fetch = fetchSpy;
    netSpies = [
      jest.spyOn(http, 'request'),
      jest.spyOn(http, 'get'),
      jest.spyOn(https, 'request'),
      jest.spyOn(https, 'get'),
      jest.spyOn(net, 'connect'),
      jest.spyOn(net, 'createConnection'),
    ];
  });

  afterEach(() => {
    // AC2 invariant: no outbound network of any kind on any code path.
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const s of netSpies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
    (global as { fetch?: unknown }).fetch = realFetch;
  });

  it('plans campaign -> adset -> creative/ad pairs, all PAUSED, for the sales sample', () => {
    const r = planPublish(sample('ecommerce-sales.json'));
    expect(r).toMatchObject({ dryRun: true, valid: true, errors: [] });
    expect(r.objects.map((o) => o.type)).toEqual(['campaign', 'adset', 'adcreative', 'ad', 'adcreative', 'ad']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adset = r.objects[1].payload as Record<string, any>;
    expect(adset.daily_budget).toBe(5000);
    expect(adset.optimization_goal).toBe('OFFSITE_CONVERSIONS');
    expect(adset.targeting.flexible_spec[0].interests).toHaveLength(2);
    for (const o of r.objects.filter((x) => x.type !== 'adcreative')) {
      expect(o.payload.status).toBe('PAUSED');
    }
  });

  it('plans the leads sample with lead-gen optimization', () => {
    const r = planPublish(sample('local-leads.json'));
    expect(r.valid).toBe(true);
    expect((r.objects[1].payload as Record<string, unknown>).optimization_goal).toBe('LEAD_GENERATION');
    expect(r.objects).toHaveLength(4);
  });

  it('returns validation errors and no objects for a bad spec', () => {
    const r = planPublish({
      name: '',
      objective: 'BUY_STUFF',
      dailyBudget: 0,
      audience: { countries: ['usa'], ageMin: 50, ageMax: 20 },
      creatives: [{ primaryText: 'x', headline: '', imageUrl: 'ftp://x', linkUrl: 'nope' }],
    });
    expect(r.valid).toBe(false);
    expect(r.objects).toEqual([]);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        'name is required',
        expect.stringContaining('objective must be one of'),
        'dailyBudget must be a number >= 1',
        expect.stringContaining('audience.countries'),
        expect.stringContaining('age range'),
        'creatives[0].headline is required',
        'creatives[0].imageUrl must be an http(s) URL',
        'creatives[0].linkUrl must be an http(s) URL',
      ]),
    );
    expect(planPublish(null).errors).toEqual(['spec must be a JSON object']);
  });

  it('mock POST /v1/publish forces dryRun even when the client asks for a live publish', () => {
    const ok = handlePublish(JSON.stringify({ dryRun: false, spec: sample('local-leads.json') }));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ dryRun: true, valid: true });
    expect(handlePublish('{not json').status).toBe(400);
    expect(handlePublish(JSON.stringify({ name: 'x' })).status).toBe(422);
  });

  it('CLI prints the plan and exits 0 / 2 / 1', () => {
    const lines: string[] = [];
    expect(runCli([path.join(SAMPLES, 'ecommerce-sales.json')], (s) => lines.push(s))).toBe(0);
    expect(JSON.parse(lines[0]).dryRun).toBe(true);
    expect(runCli([], () => undefined)).toBe(1);
  });

  it('the demo module never references Meta tokens or the Graph host', () => {
    const dir = path.join(__dirname, '..', 'adsPublisherDemo');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).not.toMatch(/graph\.facebook\.com|access_token|META_.*TOKEN|from '\.\.\/(services|emma)/);
    }
  });
});
