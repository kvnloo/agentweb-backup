/**
 * ENG-1716 — who may change a schedule template's visibility.
 *
 * THE HOLE. `PUT /api/agent-mode/schedule-templates/:templateId` wrote whatever
 * `visibility` the caller sent, behind an OWNERSHIP check only. So any
 * authenticated user could promote their own private template to `system` or
 * `public` and put it in every user's template picker — skipping the review
 * workflow (`submitForReview` → admin `approveTemplate`) that exists for exactly
 * this decision and is reachable one route over.
 *
 * WHY IT MATTERS MORE THAN A NORMAL AUTHZ SLIP. A schedule template carries a
 * `startingMessage` — an agent prompt — plus `requiredFunctionCalls`. A
 * platform-wide one is prompt-injection surface reaching every customer's agent.
 * And `createScheduleFromTemplate` COPIES `startingMessage` onto each schedule at
 * creation, so revoking the template afterwards does not undo the schedules
 * already made from it. There is no clean rollback.
 *
 * THE RULE. Visibility is the only field on that route that grants reach beyond
 * the owner, so it is the only one that needs an authorization decision rather
 * than a validation one:
 *
 *   - `system` / `public` — ADMIN ONLY. These are the platform-wide values, and
 *     `public` has a review path a non-admin is supposed to go through.
 *   - `private` ⇄ `pending_review` — the owner's own self-service transitions,
 *     mirroring `submitForReview` (private → pending_review) and letting an owner
 *     withdraw their own submission (pending_review → private).
 *   - anything else — rejected as invalid rather than persisted. The route
 *     previously wrote any string at all, so `visibility: 'nonsense'` became a
 *     stored value that no reader understands.
 *
 * REJECT, NEVER SILENTLY DROP. `manage_schedule_template`'s MCP schema advertises
 * `system` while routing to the create endpoint that hardcodes `private` and
 * ignores the field — so Emma asking for a system template gets a private one and
 * no error. That silent drop is why the confusion existed; this returns an
 * explicit refusal instead.
 */

export const TEMPLATE_VISIBILITIES = ['system', 'private', 'public', 'pending_review'] as const;
export type TemplateVisibility = typeof TEMPLATE_VISIBILITIES[number];

/** Values that publish a template beyond its owner. Admin-only. */
export const PLATFORM_WIDE_VISIBILITIES: ReadonlySet<string> = new Set(['system', 'public']);

/**
 * Legacy alias. `scheduleTemplateService.normalizeVisibility` rewrites a stored
 * `'platform'` to `'system'` on read, so accepting it here as an unrecognised
 * value would have been a bypass: a non-admin writes `'platform'`, every reader
 * then reports `'system'`. Folded to its real meaning BEFORE the authorization
 * decision, not after.
 */
const VISIBILITY_ALIASES: Record<string, TemplateVisibility> = { platform: 'system' };

export function canonicalizeVisibility(raw: unknown): TemplateVisibility | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  const aliased = VISIBILITY_ALIASES[value] ?? value;
  return (TEMPLATE_VISIBILITIES as readonly string[]).includes(aliased)
    ? (aliased as TemplateVisibility)
    : null;
}

export type VisibilityUpdateDecision =
  /** No visibility change requested — the caller should leave the field alone. */
  | { ok: true; visibility?: undefined }
  /** Allowed; write this canonical value (which may differ from what was sent). */
  | { ok: true; visibility: TemplateVisibility }
  /** Refused. `status` is the HTTP code and `error` is safe to return verbatim. */
  | { ok: false; status: 400 | 403; error: string };

/**
 * Decide whether this caller may set this visibility on this template.
 *
 * Pure: no I/O, no request object, no database. The route supplies the current
 * stored value, what was asked for, and whether the caller is an admin.
 *
 * `isAdmin` widens rather than bypasses — an admin editing their OWN template
 * through this route can still set any valid value, and the ownership check the
 * route already performs stays in force above this. Creating a template for the
 * whole platform remains the admin route's job (`adminScheduleTemplateRoutes`),
 * which is untouched.
 */
export function resolveVisibilityUpdate(params: {
  current: string | undefined;
  requested: unknown;
  isAdmin: boolean;
}): VisibilityUpdateDecision {
  const { requested, isAdmin } = params;
  if (requested === undefined) return { ok: true };

  const next = canonicalizeVisibility(requested);
  if (!next) {
    return {
      ok: false,
      status: 400,
      error:
        `Invalid visibility. Expected one of: ${TEMPLATE_VISIBILITIES.join(', ')}.`,
    };
  }

  const current = canonicalizeVisibility(params.current) ?? 'private';
  // A no-op restatement of the existing value is never a promotion, so it needs
  // no privilege — this keeps a client that PUTs the whole object back (the
  // common shape) working without having to strip the field.
  //
  // It must also emit NO WRITE (CodeRabbit on PR #2797's stale diff). Returning a
  // visibility here looked harmless, but for a legacy stored `'platform'` both
  // sides canonicalize to `'system'`, so the caller wrote `visibility` while its
  // own "is this changing?" test — which compares the same canonical values —
  // found them equal and SKIPPED the compare-and-swap. An owner's stale request
  // could then restore `system` after an administrator had demoted the template.
  // Normalising a legacy value belongs in a migration, not in an unguarded write
  // on the user route.
  if (next === current) return { ok: true };

  if (isAdmin) return { ok: true, visibility: next };

  if (PLATFORM_WIDE_VISIBILITIES.has(next)) {
    return {
      ok: false,
      status: 403,
      error:
        `Only an administrator can set a template's visibility to "${next}". `
        + 'To share a template platform-wide, submit it for review '
        + '(POST /api/agent-mode/schedule-templates/:templateId/submit-for-review) '
        + 'and an administrator will approve or reject it.',
    };
  }

  // Remaining non-admin targets are 'private' and 'pending_review'.
  if (next === 'pending_review' && current !== 'private') {
    return {
      ok: false,
      status: 403,
      error: 'Only a private template can be submitted for review.',
    };
  }
  if (next === 'private' && !(current === 'private' || current === 'pending_review')) {
    // i.e. currently system/public — taking a published template back is an
    // administrative act, and doing it silently would break schedules that
    // reference it.
    return {
      ok: false,
      status: 403,
      error:
        'Only an administrator can change the visibility of a template that is already published.',
    };
  }
  return { ok: true, visibility: next };
}
