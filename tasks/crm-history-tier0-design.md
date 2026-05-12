# CRM History Tier 0 — Design

**Status:** locked 2026-05-12 — ready for implementation
**Branch:** TBD (will likely branch off `harshit/crm-enrichment-upgrade2` or a fresh branch from `main`)

## Goal

Insert a Tier 0 lookup in `resolveIdentity` (and, transitively, the v3.1 enrichment waterfall) that, **before any external API call**, queries the user's existing leads across all their lists for a prior enrichment by email, LinkedIn, or exact name+company. Tier 0 hits copy identity fields and stamp `source: 'crm-history'` in `enrichmentMetadata`. Misses fall through to existing Apollo / enrich.so behavior unchanged.

### Why
Same user often has the same person on multiple lists (e.g., `Q1-ICP` and `Q2-sequence`). The first list got enriched fully; the second list has empty rows. Today, the second-list enrichment hits Apollo + enrich.so for every lead, even when the user already paid to enrich the same person on another list. Tier 0 reuses that prior work, free.

The service-level `AW-EnrichmentRawCache` already dedupes at the **API-cost** layer (same Apollo email match → cache row reused), but does NOT save the DDB+identity-resolution roundtrips, and doesn't help when fields come from web extraction / user manual edits on the prior lead.

## Locked decisions (from grilling 2026-05-12)

| Decision | Locked value |
|---|---|
| Scope | **Cross-user (global)** — Tier 0 searches all leads regardless of which user owns them. Extends the precedent set by `AW-EnrichmentRawCache` (already cross-tenant for raw API responses). **Implies** that user-edited fields propagate across customer accounts; team has accepted this trade-off for higher hit-rate. |
| Lookup keys | Email + LinkedIn + name+company exact match (lowercased) |
| Infra approach | Three new global GSIs on `AW-Leads` keyed by the lookup field directly (no `userId` partition). `userId` still denormalized onto leads for audit metadata only. |
| Production table size | < 100K rows → single-pass backfill, no chunking |
| Feature flag | None — Tier 0 self-gates on whether the GSIs return matches. Pre-backfill leads with missing `nameCompanyKey` simply don't appear in `NameCompanyIndex` (sparse). Email/linkedin existing columns mean those indexes light up immediately on GSI creation. |
| Audit metadata | Yes — `EnrichedFieldMeta` records `siblingLeadId` + `siblingListId` + `siblingUserId` (cross-user traceability required for any future "data lineage" or "delete my data" workflow). |
| `refreshFields` semantics | Tier 0 respects `refreshFields` (same way the waterfall's Tier 1 does) |
| Multiple sibling matches | Take the freshest by `updatedAt desc` |
| Overwrite policy | Tier 0 fills empties only — never overwrites a non-empty lead value |
| Self-match | `findSiblingLead` filters out the current `leadId` |

### Privacy / business note

Cross-user pooling means User A's enrichment investment (including any manual edits) becomes available to all other customers. This was an explicit decision (2026-05-12) prioritizing data hit-rate over per-tenant isolation. End-user UX hides the cross-tenant origin: Tier-0-sourced fields are surfaced to the customer-portal as if they originate from "AgentWeb" generically (see "End-user presentation" below). Internal audit metadata (`siblingLeadId`, `siblingListId`, `siblingUserId`) is retained server-side for debugging / data-lineage / future opt-out workflows, but stripped from API responses.

## Data-model changes

### New attributes on `AW-Leads`

| Attribute | Type | Written when | Sparse? |
|---|---|---|---|
| `userId` | String | Every `createLead`, derived from `lists[listId].userId` | No (audit only — not used as GSI partition key) |
| `nameCompanyKey` | String | Every lead write that touches firstName/lastName/company | Yes — only when all three are non-empty |

`nameCompanyKey` format: `${lower(firstName.trim())}|${lower(lastName.trim())}|${lower(company.trim())}`

Note: `linkedin` and `email` already exist as Lead attributes; just adds GSIs on them.

### New GSIs on `AW-Leads` (global, not user-scoped)

| GSI name | Partition key | Sort key | Projection | Sparseness |
|---|---|---|---|---|
| `EmailLookupIndex` | `email` | `updatedAt` | ALL | Sparse on email (no key when email is missing) |
| `LinkedinLookupIndex` | `linkedin` | `updatedAt` | ALL | Sparse on linkedin |
| `NameCompanyLookupIndex` | `nameCompanyKey` | `updatedAt` | ALL | Sparse on nameCompanyKey (only fully-populated triples indexed) |

Sort key `updatedAt` enables `ScanIndexForward: false` queries to get the freshest match in O(1) without sorting in memory.

Provisioned throughput: 5/5 each (matches existing GSI defaults). Move to on-demand later if write hot-spotting appears.

**Hot-partition assessment:** All three partition keys are high-cardinality (emails / linkedin URLs / name-company triples are highly varied across customers). No hot-partition risk anticipated.

### Cost considerations
- Write amplification: every lead write goes to 4 GSIs (existing `email-index` + 3 new). Acceptable at <100K rows.
- Read cost per identity-resolve, worst case: 3 GSI queries (email → linkedin → namecompany). All cache-cold reads dwarfed by per-lead Apollo cost saved.
- Cross-tenant: a single Query on `EmailLookupIndex` for `jane@acme.com` returns ALL leads with that email across ALL customers. Most queries will be 0–1 rows (unique per real-world email); a few may return >1 (same person on multiple customer CRMs). Bounded.

## `EnrichedFieldMeta` extension

### Internal stored shape (for audit / debugging / future data-lineage work)

Add new variant in `backend/src/utils/enrichedFieldValue.ts`:

```ts
{
  source: 'crm-history',
  provider: 'agentweb',
  enrichedAt: string,
  // Audit trail — required for source: 'crm-history'.
  // siblingUserId is required because Tier 0 is cross-tenant: a match may
  // come from a different customer's lead. Technical hook for any future
  // "data lineage" or "purge my data from cross-user pool" workflow.
  siblingLeadId: string,
  siblingListId: string,
  siblingUserId: string,
}
```

### End-user presentation (what the customer-portal UI sees)

**Decision (2026-05-12):** End-users must NOT see that a field originated from another customer's lead. To the customer-portal UI, Tier 0 fills appear to come from "AgentWeb" generically, indistinguishable from any other internal source.

**Existing UI vocabulary** (verified 2026-05-12 from `backend/src/utils/enrichedFieldValue.ts:9`):
```ts
source: 'web_search' | 'linkedin' | 'existing_data' | 'manual' | 'api';
```
The UI has icons for each value at `customer-portal/src/components/crm/EnrichedValue.tsx:36`. We need a new public-facing value — `'existing_data'` looks tempting but is special-cased server-side (`crmEnrichmentServiceV3.ts:261` skips writes for it), so reusing it would break the write path. `'api'` would conflate Tier 0 with Apollo/enrich.so. **Best fit: introduce a new `'agentweb'` value**, branded as "AgentWeb DB" in the UI.

**Mapping at the API boundary** (when serializing a lead for the customer-portal response):

| Internal stored | What the API returns to the customer-portal |
|---|---|
| `source: 'crm-history'` | `source: 'agentweb'` |
| `provider: 'agentweb'` | unchanged |
| `siblingLeadId`, `siblingListId`, `siblingUserId` | **STRIPPED** — never sent to the customer-portal |
| `enrichedAt` | unchanged |

**Additional UI changes required** (for step 4 PR):
- `backend/src/utils/enrichedFieldValue.ts:9` — extend `source` union to add `'agentweb'` for the public-facing type. Note: the internally-stored `'crm-history'` is server-only and not part of the public type union (kept internal so the API contract stays clean).
- `customer-portal/src/lib/enrichedFieldValue.ts` (or wherever the FE-facing type lives) — add `'agentweb'` to the source union
- `customer-portal/src/components/crm/EnrichedValue.tsx:36` — add an icon entry for `'agentweb'` in `sourceIcons` (Database icon from lucide, or AgentWeb logo). Label: "AgentWeb"

**Where the mapping lives:**
- A new helper `sanitizeEnrichmentMetadataForResponse(meta)` in (TBD) — likely `backend/src/services/db.ts` near the existing lead-serialization paths, or a new `backend/src/utils/enrichmentMetadataPresentation.ts`
- Called by every route handler that returns lead data to the customer-portal (GET `/api/crm/lists/:listId/leads`, GET `/api/crm/lists/:listId/leads/:leadId`, any others that include `enrichmentMetadata`)
- **NOT** called for internal/admin debug endpoints — those should see the full audit shape

**Audit-logs path:**
- Backend logs (`[v3]` log lines) MAY include the sibling IDs for debugging
- These logs go to CloudWatch / EB log bundle, not to the customer
- Useful for "this customer says field X is wrong, where did it come from?" investigations

**Tests required for the presentation layer:**
- `enrichmentMetadataPresentation.test.ts` — verifies stripping of sibling IDs and source remap
- `crm.routes.test.ts` — add an assertion that responses do NOT contain `siblingLeadId` / `siblingListId` / `siblingUserId` for Tier-0-sourced fields

## Code changes (by file)

### `backend/src/scripts/create-tables.ts`
- Add `userId`, `linkedin`, `nameCompanyKey` to `AttributeDefinitions` for `AW-Leads`
- Add the three GSIs

### `backend/src/services/db.ts`
- `createLead`: **require** `userId` (caller passes it), compute `nameCompanyKey`, write both
- All other write paths that mutate firstName/lastName/company (`updateLead`, `setLeadFields`, sync routes, importers): recompute `nameCompanyKey` and write through
- New methods (cross-tenant — no userId filter):
  - `findLeadsByEmail(email: string): Promise<LeadRecord[]>`
  - `findLeadsByLinkedin(linkedin: string): Promise<LeadRecord[]>`
  - `findLeadsByNameCompany(firstName: string, lastName: string, company: string): Promise<LeadRecord[]>`
- All three: Query against the relevant GSI with `ScanIndexForward: false` (freshest first via `updatedAt` sort key), `Limit: 10` (defensive — bounds payload for any unusually shared key), return `LeadRecord[]`

### `backend/src/services/enrichmentIdentityResolver.ts`
- Extend `IdentityResolverDeps`:
  ```ts
  findSiblingLead(input: {
    excludeLeadId: string;
    email?: string;
    linkedinUrl?: string;
    firstName?: string;
    lastName?: string;
    company?: string;
  }): Promise<LeadRecord | null>;
  ```
  Note: no `userId` parameter — cross-tenant lookup. The current lead's `userId` is only used by the resolver for AUDIT meta, not for filtering candidates.
- New **Step 1.5** in `resolveIdentity`, between current steps 1 (input check) and 2 (LinkedIn-first Apollo):
  - Skip if neither email nor linkedinUrl nor (firstName+lastName+company) is present (existing line-85 early return covers most of this)
  - Call `findSiblingLead` with all available keys
  - On hit: for each identity field in `['firstName','lastName','email','linkedin','company','website','title']` where:
    - sibling has a non-empty value, AND
    - the current lead's value IS empty, AND
    - `refreshFields` does NOT include `${leadId}:${field}`
    → copy with meta `{ source: 'crm-history', provider: 'crm', enrichedAt: now, siblingLeadId, siblingListId, siblingUserId }`
- All downstream steps (Apollo person/org, enrich.so) run as before with the partial fill in place — Apollo only fills what Tier 0 left empty

### `backend/src/services/crmEnrichmentServiceV3.ts`
- Thread `userId` into the call to `deps.resolveIdentity` (already in `RunEnrichmentInput.userId`)
- Pass `refreshFields` set down to the resolver (currently only the waterfall sees it)

### `backend/src/services/enrichmentV3RealDeps.ts`
- `buildIdentityDeps()` gets a new `findSiblingLead` impl:
  1. Try email first (most precise) → `crmDb.findLeadsByEmail`
  2. Try linkedinUrl on miss → `crmDb.findLeadsByLinkedin`
  3. Try name+company on miss → `crmDb.findLeadsByNameCompany`
  4. Filter out `excludeLeadId` (self-match)
  5. Return the first survivor (already sorted by GSI sort key, freshest-first)

### `backend/src/scripts/backfill-leads-userid.ts` (new)
- Build `listId → userId` map from `AW-Lists`
- Scan `AW-Leads` with pagination, throttle at 100 items/sec
- For each lead missing `userId`:
  - Look up userId via map; if list is orphaned, log + skip
  - Compute `nameCompanyKey` (if firstName/lastName/company all set)
  - `UpdateItem` with both attributes + `_userIdBackfilledAt`
  - Use `attribute_not_exists(userId)` ConditionExpression for idempotency
- Print summary: touched/skipped/orphaned/errored
- Designed to be safe to re-run

### Tests (TDD, per CLAUDE.md Rule 2)

All written FAIL-first:

| Test file | Coverage |
|---|---|
| `db.findLeadsByEmail.test.ts` | Empty input returns []; no matches returns []; single match; multiple matches sorted by updatedAt desc; Limit 10 enforced |
| `db.findLeadsByLinkedin.test.ts` | Same shape |
| `db.findLeadsByNameCompany.test.ts` | Same shape; missing any of f/l/c → no GSI key, returns []; case normalization (input vs stored key) |
| `db.createLead.userId.test.ts` | Verifies userId + nameCompanyKey written; nameCompanyKey omitted when any of f/l/c is missing |
| `enrichmentIdentityResolver.tier0.test.ts` | Tier 0 hits by email/linkedin/namecompany; miss falls through; self-match excluded; refreshFields respected; multiple siblings → freshest wins; partial fill; sibling has empty fields → don't copy; **cross-user match** copies fields with siblingUserId in meta |
| `crmEnrichmentServiceV3.test.ts` | Update `makeDeps` to include `findSiblingLead` stub |
| `backfill-leads-userid.test.ts` | Orphaned lead skipped; already-backfilled skipped; nameCompanyKey omitted when partial; idempotent re-run |

## Behavior contract — tricky cases

| Case | Behavior |
|---|---|
| Pre-backfill lead with no `nameCompanyKey` | Sparse `NameCompanyLookupIndex` excludes it. Email/linkedin indexes already have the keys (those columns exist pre-feature) — those branches light up as soon as the GSI is ACTIVE. So Tier 0 starts working partially even before backfill completes. |
| Lead is the *only* match in `findSiblingLead` (self-match) | Filtered out via `excludeLeadId`. Returns null. Apollo runs. |
| Sibling has stale `linkedin` (person changed jobs) | Copied as-is. User can use `refreshFields` to force Apollo refetch. |
| `refreshFields` includes `lead-1:linkedin` | Tier 0 skips `linkedin` for lead-1. Apollo path runs for that field. Consistent with waterfall Tier 1 bypass at `enrichmentGroupWaterfall.ts:215`. |
| Two siblings, one fresher | Freshest wins (GSI sort key on `updatedAt`, `ScanIndexForward: false`, take first). |
| Sibling found by email but has *different* `linkedin` than current lead's existing linkedin | Sibling's linkedin is NOT copied (current lead's linkedin is non-empty → fill-empties rule). |
| Sibling has empty `firstName` | Don't copy empty values. Tier 0 only copies non-empty sibling fields. |
| Two-list overlap, both lists owned by same user | Tier 0 hits. Identity fields filled with sibling values; `siblingUserId === currentUserId` in audit meta. |
| Cross-user overlap (Jane is on user-A's list AND user-B's list) | Tier 0 hits. Identity fields filled with sibling values; `siblingUserId !== currentUserId` in audit meta. **User A's manual edits propagate to User B.** This is the intended cross-tenant behavior. |
| User A has Jane with `title='VP Eng'` (manually edited from Apollo's stale `'Director'`), User B's run for Jane finds A's lead | User B gets `title='VP Eng'`. User A's correction propagates. |
| Cross-user hot match: same email exists on 5 customers' lists | GSI returns up to 10 (Limit). Sort key `updatedAt` ensures freshest wins. Audit meta names which lead/user/list won. |
| Sibling lead is owned by a deleted user | Still hits the GSI. `siblingUserId` records the (now-orphan) userId. Not a correctness issue but worth a periodic-cleanup TODO. |

## Rollout phases (each a separate PR)

| # | PR | Risk | Verification |
|---|---|---|---|
| 1 | Add GSIs + new attributes in `create-tables.ts`; run create-tables in staging | Low — index creation is async, doesn't block writes | Inspect AWS console; GSI status = ACTIVE |
| 2 | Update lead-write paths to write `userId` + `nameCompanyKey` | Low — additive on new writes | New leads in staging show both attributes |
| 3 | Add new `crmDb` find methods + TDD tests | Low | Unit tests pass; integration sanity in staging |
| 4 | Add Tier 0 to resolver + TDD tests | Medium — touches active enrichment path | Existing tests still pass; new Tier 0 tests pass; manual smoke in test-env |
| 5 | Backfill script + dry-run on staging | Medium | Dry-run report matches expectation; idempotent re-run is no-op |
| 6 | Run backfill in prod | Medium — production data write | Spot-check 10 leads; AW-Leads metrics stable |

Tier 0 is **effectively dormant until step 6 completes** because the GSI partition is sparse before backfill. So 1–5 can all ship without behavior change.

## Open items for follow-up (post-launch)

- **Pointer-table alternative:** if write amplification becomes a problem (3 GSIs × every lead write), consider migrating to a separate `AW-LeadLookupIndex` table keyed by `userId#lookupKey`. Same lookup ergonomics, fewer GSIs on the hot Lead table. Defer until measured.
- **Cross-user enterprise pooling:** some customers may want lead-history sharing within an org/team. Not in scope here. Requires separate ACL design.
- **Confidence scoring:** Tier 0 currently treats sibling data with 100% trust. Could add age-based decay or a "verified by" count. Defer.

## Memory link

Save to `~/.claude/projects/.../memory/crm-history-tier0-design.md` and add to `MEMORY.md` Active Designs.
