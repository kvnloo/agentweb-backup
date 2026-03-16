# Design: Support Multiple GSC, GA4, and Clarity Accounts for SEO/GEO Page

## Problem Statement

Currently, users can only configure one Google Analytics Property ID and one Microsoft Clarity Project ID for the SEO/GEO page. Some clients have multiple GA4 properties and Clarity projects (e.g., one for their main website, another for their product site, etc.) and need to view metrics from all accounts in a unified dashboard.

## Current Implementation

### Data Structure (User table)
```typescript
interface User {
  seoDomains?: string[];  // Array of domains - already supports multiple
  googleAnalyticsPropertyId?: string;  // Single GA4 property
  clarityProjectId?: string;  // Single Clarity project
  productDomain?: string;  // Single product domain
  gaFilteredDomains?: string[];  // Already supports multiple
}
```

### Backend Flow
1. Admin configures single GA4 property ID and Clarity project ID via partner portal
2. `/api/seo/metrics` endpoint fetches data from the single configured GA4 property
3. Customer portal displays metrics from single GA4 and Clarity account

## Proposed Solution

### 1. Data Structure Changes

Update the User interface to support multiple accounts:

```typescript
interface User {
  seoDomains?: string[];  // Keep as-is (already array)

  // NEW: Array of GA4 properties with labels
  googleAnalyticsProperties?: Array<{
    propertyId: string;  // GA4 Property ID (e.g., "123456789")
    label: string;  // User-friendly label (e.g., "Main Website", "Product Site")
  }>;

  // NEW: Array of Clarity projects with labels
  clarityProjects?: Array<{
    projectId: string;  // Clarity Project ID (e.g., "ul13e4f7fe")
    label: string;  // User-friendly label (e.g., "Main Site Clarity", "Product Clarity")
  }>;

  // DEPRECATED (keep for backward compatibility during migration)
  googleAnalyticsPropertyId?: string;
  clarityProjectId?: string;

  productDomain?: string;  // Keep as-is (single value is fine)
  gaFilteredDomains?: string[];  // Keep as-is (already array)
}
```

### 2. Backend API Changes

#### Admin Routes (`/api/admin/users/:userId/seo-aeo`)

**Request Payload (PUT):**
```typescript
{
  seoDomains: string[];
  googleAnalyticsProperties: Array<{ propertyId: string; label: string }>;
  clarityProjects: Array<{ projectId: string; label: string }>;
  gaFilteredDomains: string[];
  productDomain: string | null;
}
```

**Validation:**
- Each `propertyId` must be numeric (digits only)
- Each `projectId` must match pattern `^[a-zA-Z0-9_-]{6,32}$`
- Each `label` must be non-empty string, max 100 characters
- No duplicate `propertyId` or `projectId` within the same user

#### SEO Routes (`/api/seo/metrics`)

**Changes:**
1. Fetch GA4 metrics for **all** configured properties
2. Return array of GA metrics, one per property
3. Include property label in response for UI display

**Response Structure:**
```typescript
{
  metrics: DomainMetrics[];  // GSC metrics (unchanged)
  gaMetrics: Array<{  // NEW: Array instead of single object
    propertyId: string;
    label: string;
    sessions: number;
    users: number;
    // ... other GA metrics
  }> | null;
  clarityData: Array<{  // NEW: If Clarity metrics are fetched in the future
    projectId: string;
    label: string;
    // ... clarity metrics
  }> | null;
  funnelMetrics: FunnelMetrics | null;  // Keep as-is for now
  timestamp: string;
}
```

### 3. Frontend Changes

#### Partner Portal (AdminDashboard.tsx)

**Dialog UI Changes:**
Replace single text fields with dynamic list UI:

**Google Analytics Properties:**
- Show list of configured properties with labels
- Each row: `[Label TextField] [Property ID TextField] [Remove Button]`
- "Add GA4 Property" button at bottom
- Validation: same as current (numeric property ID)

**Microsoft Clarity Projects:**
- Show list of configured projects with labels
- Each row: `[Label TextField] [Project ID TextField] [Remove Button]`
- "Add Clarity Project" button at bottom
- Validation: same as current (alphanumeric with _ and -)

**Display in Table:**
```
GA: Main Site (123456789), Product (987654321)
Clarity: Main (ul13e4f7fe), Product (xk9f2d8a1b)
```

#### Customer Portal (SEO.tsx)

**UI Changes:**

1. **Tab/Selector for Multiple GA Properties:**
   - Add dropdown or tabs to switch between GA4 properties
   - Default to first property
   - Display property label in selector

2. **Metrics Display:**
   - Fetch all GA4 properties' data in parallel
   - Allow user to view each property's metrics separately OR
   - Show aggregated view with ability to drill down per property

3. **Clarity Integration (Future):**
   - Similar dropdown for multiple Clarity projects
   - Note: Currently Clarity is only configured but not displayed in SEO page

### 4. Migration Strategy

**Backward Compatibility:**

When reading user data:
1. Check if `googleAnalyticsProperties` exists and has items → use new format
2. Otherwise, check if `googleAnalyticsPropertyId` exists → auto-migrate to new format with default label "Main Property"
3. Same logic for Clarity: `clarityProjects` vs `clarityProjectId`

**Migration Logic (in backend):**
```typescript
function getGoogleAnalyticsProperties(user: User): Array<{ propertyId: string; label: string }> {
  if (user.googleAnalyticsProperties && user.googleAnalyticsProperties.length > 0) {
    return user.googleAnalyticsProperties;
  }
  // Fallback: migrate from old single field
  if (user.googleAnalyticsPropertyId) {
    return [{ propertyId: user.googleAnalyticsPropertyId, label: "Main Property" }];
  }
  return [];
}

function getClarityProjects(user: User): Array<{ projectId: string; label: string }> {
  if (user.clarityProjects && user.clarityProjects.length > 0) {
    return user.clarityProjects;
  }
  // Fallback: migrate from old single field
  if (user.clarityProjectId) {
    return [{ projectId: user.clarityProjectId, label: "Main Project" }];
  }
  return [];
}
```

**Admin Dashboard Migration:**
When opening the SEO/AEO config dialog:
1. If old fields exist but new fields don't, auto-populate with migrated values
2. Allow admin to add more properties/projects
3. On save, write to new fields and optionally clear old fields (or keep for rollback safety)

### 5. Implementation Plan

#### Phase 1: Backend Foundation
1. Update User interface in `backend/src/services/db.ts`
2. Add migration helper functions
3. Update admin routes to accept and validate array format
4. Keep old fields for backward compatibility

#### Phase 2: SEO Metrics Endpoint
1. Update `/api/seo/metrics` to fetch data for all GA4 properties
2. Return array of GA metrics in response
3. Test with multiple properties

#### Phase 3: Partner Portal UI
1. Update AdminDashboard dialog to support multiple entries
2. Add/remove buttons for GA4 and Clarity accounts
3. Show labels in user table display

#### Phase 4: Customer Portal UI
1. Update SEO.tsx to handle array of GA metrics
2. Add property selector dropdown/tabs
3. Display metrics per selected property

#### Phase 5: Testing & Rollout
1. Write unit tests for migration logic
2. Test with existing users (backward compatibility)
3. Test with new multi-account users
4. Update documentation

### 6. Out of Scope (Future Enhancements)

- **Per-property funnel configs:** Currently, funnel is tied to user. In the future, might want funnel per GA4 property.
- **Aggregated metrics across properties:** Show combined metrics from all properties.
- **Clarity metrics display:** Currently Clarity is only configured but not displayed on SEO page. This will require API integration with Clarity's API.
- **Per-property filtered domains:** Currently `gaFilteredDomains` is global. Might want per-property filters.

### 7. Testing Strategy

**Unit Tests:**
- Migration helper functions (old → new format)
- Validation for duplicate property IDs
- Array handling in admin routes

**Integration Tests:**
- Admin configures multiple GA4 properties
- SEO metrics endpoint returns all properties' data
- Customer portal displays correct data per property

**Manual Testing:**
- Test with user who has old single property (backward compat)
- Test with user who has multiple properties (new format)
- Test empty state (no properties configured)

### 8. Rollback Plan

If issues arise:
1. Keep old fields (`googleAnalyticsPropertyId`, `clarityProjectId`) populated
2. Backend can fallback to reading old fields if new fields are empty
3. Frontend can detect old format and show single property UI

### 9. Questions to Resolve

1. **Funnel config:** Should funnels be per-GA4-property or remain global per user?
   - **Decision:** Keep global for now. Add `?propertyId=xxx` query param to funnel endpoint in future if needed.

2. **Default property:** Which property should be selected by default in customer portal?
   - **Decision:** First property in array. Admin can reorder properties if needed (future enhancement).

3. **Clarity display:** Should we also add Clarity metrics display to SEO page?
   - **Decision:** Out of scope for this task. This requires API integration with Microsoft Clarity API.

4. **Aggregated view:** Should we show combined metrics from all properties?
   - **Decision:** Out of scope. Start with per-property view. Add aggregation later if requested.

## Summary

This design enables users to configure and view metrics from multiple Google Analytics 4 properties and Microsoft Clarity projects. The implementation maintains backward compatibility by keeping old single-value fields and providing migration logic. The UI is enhanced to support adding/removing multiple accounts with user-friendly labels.
