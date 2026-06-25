/**
 * Unit tests for resolveLandingPageGa4 — the pure resolver that maps a landing
 * page hostname to the correct GA4 property/measurement ID. Backs the fix for
 * the "audit.agentweb.pro emits no GA4" funnel data gap: the platform now
 * supports multiple domain→GA4 mappings (base mapping + additionalDomains[])
 * instead of a single agentwebforms.com mapping.
 */

import {
  resolveLandingPageGa4,
  LandingPageDomainMapping,
} from '../utils/landingPageGa4';
import { LandingPagesConfig } from '../utils/secretsManager';

const FORMS: LandingPagesConfig = {
  ga4PropertyId: '111111111',
  gscDomain: 'agentwebforms.com',
  ga4MeasurementId: 'G-FORMS',
};

const FORMS_WITH_AUDIT: LandingPagesConfig = {
  ...FORMS,
  additionalDomains: [
    {
      gscDomain: 'agentweb.pro',
      ga4PropertyId: '222222222',
      ga4MeasurementId: 'G-AUDIT',
    },
  ],
};

describe('resolveLandingPageGa4', () => {
  it('returns null for a null config', () => {
    expect(resolveLandingPageGa4(null, 'audit.agentweb.pro')).toBeNull();
  });

  it('returns null when no mapping matches the host', () => {
    expect(resolveLandingPageGa4(FORMS, 'foo.example.com')).toBeNull();
  });

  it('returns null for an empty host', () => {
    expect(resolveLandingPageGa4(FORMS_WITH_AUDIT, '')).toBeNull();
  });

  it('matches a subdomain of the base gscDomain', () => {
    const m = resolveLandingPageGa4(FORMS, 'lead123.agentwebforms.com');
    expect(m).toEqual({
      gscDomain: 'agentwebforms.com',
      ga4PropertyId: '111111111',
      ga4MeasurementId: 'G-FORMS',
    });
  });

  it('matches the bare base gscDomain (no subdomain)', () => {
    const m = resolveLandingPageGa4(FORMS, 'agentwebforms.com');
    expect(m?.ga4PropertyId).toBe('111111111');
  });

  it('audit.agentweb.pro misses an agentwebforms.com-only config (reproduces the bug)', () => {
    expect(resolveLandingPageGa4(FORMS, 'audit.agentweb.pro')).toBeNull();
  });

  it('matches an additional agentweb.pro mapping for audit subdomains (the fix)', () => {
    const m = resolveLandingPageGa4(FORMS_WITH_AUDIT, 'audit.agentweb.pro');
    expect(m).toEqual({
      gscDomain: 'agentweb.pro',
      ga4PropertyId: '222222222',
      ga4MeasurementId: 'G-AUDIT',
    });
  });

  it('still matches the base mapping when additionalDomains are present', () => {
    const m = resolveLandingPageGa4(FORMS_WITH_AUDIT, 'x.agentwebforms.com');
    expect(m?.ga4PropertyId).toBe('111111111');
  });

  it('is case-insensitive on the host', () => {
    const m = resolveLandingPageGa4(FORMS_WITH_AUDIT, 'Audit.AgentWeb.PRO');
    expect(m?.ga4PropertyId).toBe('222222222');
  });

  it('strips a port from the host before matching', () => {
    const m = resolveLandingPageGa4(FORMS_WITH_AUDIT, 'audit.agentweb.pro:443');
    expect(m?.ga4PropertyId).toBe('222222222');
  });

  it('prefers the most specific (longest) matching gscDomain', () => {
    const cfg: LandingPagesConfig = {
      ga4PropertyId: '100',
      gscDomain: 'agentweb.pro',
      additionalDomains: [
        { gscDomain: 'audit.agentweb.pro', ga4PropertyId: '200', ga4MeasurementId: 'G-AUDIT' },
      ],
    };
    const m = resolveLandingPageGa4(cfg, 'page.audit.agentweb.pro');
    expect(m?.ga4PropertyId).toBe('200');
  });

  it('does not match a domain that merely shares a suffix substring', () => {
    // notagentweb.pro must NOT match agentweb.pro
    const m = resolveLandingPageGa4(FORMS_WITH_AUDIT, 'notagentweb.pro');
    expect(m).toBeNull();
  });

  it('ignores additional mappings missing required fields', () => {
    const cfg: LandingPagesConfig = {
      ...FORMS,
      additionalDomains: [
        { gscDomain: 'agentweb.pro' } as unknown as LandingPageDomainMapping,
      ],
    };
    expect(resolveLandingPageGa4(cfg, 'audit.agentweb.pro')).toBeNull();
  });
});
