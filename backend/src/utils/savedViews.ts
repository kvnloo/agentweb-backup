/**
 * Saved Views (H1) utilities.
 *
 * Saved Views are user-customized filter+sort combinations over the /crm
 * dashboard tabs (Inbox, Working, Paying, All). Built-in presets are
 * returned from code and are read-only. User-saved views are persisted on
 * the User record in DynamoDB via `User.savedViews`.
 *
 * This module is the source of truth for:
 *  - Preset definitions (stable viewIds with `preset:` prefix)
 *  - Input validation for create/update endpoints
 *
 * The HTTP routes live in `backend/src/routes/crm.ts`.
 */

export type SavedViewScope = 'inbox' | 'working' | 'paying' | 'all';

export interface SavedView {
  viewId: string;
  name: string;
  scope: SavedViewScope;
  filters?: Record<string, any>;
  sort?: string;
  isPreset: boolean;
  createdAt: string;
}

export const VALID_SCOPES: SavedViewScope[] = ['inbox', 'working', 'paying', 'all'];

export const PRESET_PREFIX = 'preset:';

export function isPresetViewId(viewId: string): boolean {
  return typeof viewId === 'string' && viewId.startsWith(PRESET_PREFIX);
}

/**
 * Return the 5 built-in presets. `currentUserId` is injected into "My Deals"
 * so the filter actually resolves to the caller.
 */
export function buildBuiltInPresets(currentUserId: string): SavedView[] {
  return [
    {
      viewId: 'preset:hot-in-inbox',
      name: 'Hot in Inbox',
      scope: 'inbox',
      filters: { minHeatScore: 50 },
      sort: 'heatScore:desc',
      isPreset: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    },
    {
      viewId: 'preset:my-deals',
      name: 'My Deals',
      scope: 'working',
      filters: { accountOwnerUserId: currentUserId },
      sort: 'heatScore:desc',
      isPreset: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    },
    {
      viewId: 'preset:unassigned',
      name: 'Unassigned',
      scope: 'all',
      filters: { accountOwnerUserId: null },
      isPreset: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    },
    {
      viewId: 'preset:at-risk-customers',
      name: 'At-risk Customers',
      scope: 'paying',
      filters: { lifecycle: 'at_risk' },
      sort: 'healthScore:asc',
      isPreset: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    },
    {
      viewId: 'preset:gone-cold',
      name: 'Gone Cold',
      scope: 'all',
      filters: { lastEngagementDaysAgo: '>30', lifecycle: '!churned' },
      isPreset: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    },
  ];
}

export interface SavedViewCreateInput {
  name?: unknown;
  scope?: unknown;
  filters?: unknown;
  sort?: unknown;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateCreateInput(
  input: SavedViewCreateInput
): ValidationResult<{
  name: string;
  scope: SavedViewScope;
  filters: Record<string, any>;
  sort?: string;
}> {
  const { name, scope, filters, sort } = input || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, error: 'name is required' };
  }
  if (typeof scope !== 'string' || !VALID_SCOPES.includes(scope as SavedViewScope)) {
    return { ok: false, error: `scope must be one of ${VALID_SCOPES.join(', ')}` };
  }
  if (filters !== undefined && (typeof filters !== 'object' || Array.isArray(filters) || filters === null)) {
    return { ok: false, error: 'filters must be an object' };
  }
  if (sort !== undefined && typeof sort !== 'string') {
    return { ok: false, error: 'sort must be a string' };
  }
  return {
    ok: true,
    value: {
      name: name.trim(),
      scope: scope as SavedViewScope,
      filters: (filters as Record<string, any>) || {},
      sort: sort as string | undefined,
    },
  };
}

export function generateViewId(): string {
  return `view_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
