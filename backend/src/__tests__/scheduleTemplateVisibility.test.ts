// ENG-1716: PUT /api/agent-mode/schedule-templates/:templateId wrote whatever
// `visibility` the caller sent behind an OWNERSHIP check only, so any
// authenticated user could promote their own private template to `system` or
// `public` and put its agent prompt in every customer's template picker —
// skipping the submit-for-review → admin-approve workflow one route over.

import {
  TEMPLATE_VISIBILITIES,
  PLATFORM_WIDE_VISIBILITIES,
  canonicalizeVisibility,
  resolveVisibilityUpdate,
} from '../utils/scheduleTemplateVisibility';

const decide = (current: string | undefined, requested: unknown, isAdmin = false) =>
  resolveVisibilityUpdate({ current, requested, isAdmin });

describe('canonicalizeVisibility', () => {
  it('accepts the four real values, case- and space-insensitively', () => {
    TEMPLATE_VISIBILITIES.forEach((v) => {
      expect(canonicalizeVisibility(v)).toBe(v);
      expect(canonicalizeVisibility(` ${v.toUpperCase()} `)).toBe(v);
    });
  });

  it('folds the legacy "platform" alias to system BEFORE any decision', () => {
    // scheduleTemplateService.normalizeVisibility rewrites a stored 'platform' to
    // 'system' on read. Treating it as an unknown value here would have been a
    // bypass: a non-admin writes 'platform', every reader then reports 'system'.
    expect(canonicalizeVisibility('platform')).toBe('system');
  });

  it('rejects anything else instead of letting it be persisted', () => {
    // The route used to write any string at all.
    [undefined, null, 42, {}, [], '', '   ', 'nonsense', 'SYSTEM_'].forEach((v) => {
      expect(canonicalizeVisibility(v as any)).toBeNull();
    });
  });
});

describe('resolveVisibilityUpdate — the hole this closes', () => {
  it('THE BUG: a non-admin owner cannot promote their template platform-wide', () => {
    ['system', 'public'].forEach((target) => {
      const d = decide('private', target);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.status).toBe(403);
        expect(d.error).toContain('administrator');
        // Explicit refusal, not a silent drop — AC #1.
        expect(d.error).toContain('submit-for-review');
      }
    });
  });

  it('closes the "platform" alias route to the same promotion', () => {
    const d = decide('private', 'platform');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });

  it('rejects an unknown value rather than persisting it', () => {
    const d = decide('private', 'nonsense');
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(400);
      expect(d.error).toContain('Invalid visibility');
    }
  });
});

describe('resolveVisibilityUpdate — what a non-admin owner may still do (AC #2)', () => {
  it('submits a private template for review', () => {
    expect(decide('private', 'pending_review')).toEqual({ ok: true, visibility: 'pending_review' });
  });

  it('withdraws its own pending submission', () => {
    expect(decide('pending_review', 'private')).toEqual({ ok: true, visibility: 'private' });
  });

  it('cannot submit a template that is not private', () => {
    ['public', 'system'].forEach((current) => {
      const d = decide(current, 'pending_review');
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.error).toContain('Only a private template');
    });
  });

  it('cannot quietly un-publish a template others may already be using', () => {
    // Demoting a live template would break the schedules referencing it, so it is
    // an administrative act — see ENG-1716 AC #5's "not silently demoted".
    const d = decide('public', 'private');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });

  it('restating the existing value is never a promotion, so it needs no privilege', () => {
    // A client that PUTs the whole object back must keep working without stripping
    // the field.
    TEMPLATE_VISIBILITIES.forEach((v) => {
      expect(decide(v, v)).toEqual({ ok: true, visibility: v });
    });
  });

  it('leaves the field alone when the caller sends none', () => {
    expect(decide('private', undefined)).toEqual({ ok: true });
    expect(decide('public', undefined)).toEqual({ ok: true });
  });

  it('treats a template with no stored visibility as private', () => {
    const d = decide(undefined, 'system');
    expect(d.ok).toBe(false);
    expect(decide(undefined, 'pending_review')).toEqual({ ok: true, visibility: 'pending_review' });
  });
});

describe('resolveVisibilityUpdate — admins (AC #3)', () => {
  it('may set any valid visibility', () => {
    TEMPLATE_VISIBILITIES.forEach((v) => {
      expect(decide('private', v, true)).toEqual({ ok: true, visibility: v });
    });
    expect(decide('private', 'platform', true)).toEqual({ ok: true, visibility: 'system' });
  });

  it('is still held to the value enum', () => {
    const d = decide('private', 'nonsense', true);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(400);
  });
});

describe('the platform-wide set is exactly the two publishing values', () => {
  it('names system and public, and nothing else', () => {
    expect([...PLATFORM_WIDE_VISIBILITIES].sort()).toEqual(['public', 'system']);
    expect(PLATFORM_WIDE_VISIBILITIES.has('private')).toBe(false);
    expect(PLATFORM_WIDE_VISIBILITIES.has('pending_review')).toBe(false);
  });
});
