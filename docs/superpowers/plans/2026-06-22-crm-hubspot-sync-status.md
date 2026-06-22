# CRM per-lead HubSpot sync status (mark + filter) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-lead "in sync with HubSpot" chip and a sync-status filter (`synced` / `sync_pending` / `update_pending` / `sync_failed`) in the customer-portal CRM, backed by a persisted per-lead status.

**Architecture:** Persist `syncStatus` / `lastSyncedAt` / `syncError` under `lead.syncMetadata`, written by the HubSpot adapter (push + auto-sync) and the lead create/update routes. Read paths derive a fallback for legacy leads (no field yet). The leads endpoint gains a `syncStatus` filter (in-memory, no GSI/migration) and returns a resolved `syncStatus` + a `hubspotConnected` flag. The CRM page renders a chip and a filter, both gated on connection.

**Tech Stack:** Node/TypeScript (Express, DynamoDB DocumentClient), Jest (backend); React/TypeScript + Tailwind + shadcn/ui (customer-portal).

**Spec:** `docs/superpowers/specs/2026-06-22-crm-hubspot-sync-status-design.md`

---

## File Structure

**New:**
- `backend/src/utils/leadSyncStatus.ts` — pure helpers: status type, connection read, status resolution (with legacy fallback), mapped-field detection, metadata builders. Leaf module (no imports from services/adapters) to avoid an import cycle.
- `backend/src/__tests__/leadSyncStatus.test.ts` — unit tests for the helpers.

**Modified (backend):**
- `backend/src/services/adapters/hubspotAdapter.ts` — write per-lead `synced`/`sync_failed` during push; consolidate writebacks so they don't clobber each other.
- `backend/src/routes/crm.ts` — create → `sync_pending`; mapped-field update → `update_pending`; `GET leads` `syncStatus` filter + `hubspotConnected` + resolved per-lead `syncStatus`.

**Modified (backend tests):**
- `backend/src/__tests__/hubspotAdapter.pushLeads.batch.test.ts`, `hubspotService.batch.test.ts`, `externalCrmSync.service.test.ts` — assert per-lead status writes.

**Modified (customer-portal):**
- `customer-portal/src/pages/CRM.tsx` — `Lead` type, state, `fetchLeads` param + read `hubspotConnected`, chip near contact name, filter control + pill + URL persistence.

---

## Canonical values (use these EXACT strings everywhere)

```
'synced' | 'sync_pending' | 'update_pending' | 'sync_failed'
```

Do NOT use `'pending'`, `'error'`, or `'never_synced'` anywhere — they are not valid.

---

## Task 1: `leadSyncStatus.ts` util + tests

**Files:**
- Create: `backend/src/utils/leadSyncStatus.ts`
- Test: `backend/src/__tests__/leadSyncStatus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/leadSyncStatus.test.ts`:

```typescript
import {
  resolveSyncStatus,
  getHubspotConnection,
  getMappedAgentwebFields,
  mappedFieldChanged,
  buildSyncedMetadata,
  buildFailedMetadata,
} from '../utils/leadSyncStatus';

describe('getHubspotConnection', () => {
  it('returns connected=false when no hubspot config on list', () => {
    expect(getHubspotConnection({}).connected).toBe(false);
    expect(getHubspotConnection({ externalCrmSyncConfigs: {} }).connected).toBe(false);
  });

  it('returns connected=true with an OAuth accountId', () => {
    const list = { externalCrmSyncConfigs: { hubspot: { accountId: 'acc1', autoSyncEnabled: true } } };
    const c = getHubspotConnection(list);
    expect(c.connected).toBe(true);
    expect(c.autoSyncEnabled).toBe(true);
    expect(c.config).toBeTruthy();
  });

  it('returns connected=true with a manual apiKeyEncrypted', () => {
    const list = { externalCrmSyncConfigs: { hubspot: { apiKeyEncrypted: 'enc' } } };
    expect(getHubspotConnection(list).connected).toBe(true);
    expect(getHubspotConnection(list).autoSyncEnabled).toBe(false);
  });
});

describe('resolveSyncStatus', () => {
  it('returns null when not connected', () => {
    expect(resolveSyncStatus({ syncMetadata: { syncStatus: 'synced' } }, false)).toBeNull();
  });

  it('returns the persisted status when present', () => {
    expect(resolveSyncStatus({ syncMetadata: { syncStatus: 'update_pending' } }, true)).toBe('update_pending');
    expect(resolveSyncStatus({ syncMetadata: { syncStatus: 'sync_failed' } }, true)).toBe('sync_failed');
  });

  it('derives synced for a legacy lead with a hubspot_contact_id and no status', () => {
    expect(resolveSyncStatus({ syncMetadata: { hubspot_contact_id: '123' } }, true)).toBe('synced');
  });

  it('derives sync_pending for a connected lead never pushed', () => {
    expect(resolveSyncStatus({ syncMetadata: {} }, true)).toBe('sync_pending');
    expect(resolveSyncStatus({}, true)).toBe('sync_pending');
  });
});

describe('getMappedAgentwebFields', () => {
  it('collects enabled push/both agentwebFields across contact, deal, custom mappings', () => {
    const config = {
      contactFieldMapping: [
        { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
        { agentwebField: 'phone', crmProperty: 'phone', direction: 'pull', enabled: true }, // pull-only excluded
        { agentwebField: 'title', crmProperty: 'jobtitle', direction: 'push', enabled: false }, // disabled excluded
      ],
      dealFieldMapping: [
        { agentwebField: 'dealValue', crmProperty: 'amount', direction: 'both', enabled: true },
      ],
      customFieldMapping: [
        { agentwebField: 'notes', crmProperty: 'notes', direction: 'both', enabled: true },
      ],
    };
    const fields = getMappedAgentwebFields(config);
    expect(fields.has('email')).toBe(true);
    expect(fields.has('dealValue')).toBe(true);
    expect(fields.has('notes')).toBe(true);
    expect(fields.has('phone')).toBe(false);
    expect(fields.has('title')).toBe(false);
  });

  it('falls back to a default field set when config has no enabled mappings', () => {
    const fields = getMappedAgentwebFields({ contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [] });
    expect(fields.has('email')).toBe(true);
    expect(fields.has('firstName')).toBe(true);
  });
});

describe('mappedFieldChanged', () => {
  const mapped = new Set(['email', 'company', 'notes']);

  it('true when a mapped standard field value changes', () => {
    expect(mappedFieldChanged({ company: 'Acme' }, { company: 'Beta' }, mapped)).toBe(true);
  });

  it('false when only an unmapped field changes', () => {
    expect(mappedFieldChanged({ priority: 'Low' }, { priority: 'High' }, mapped)).toBe(false);
  });

  it('false when a mapped field is present but unchanged', () => {
    expect(mappedFieldChanged({ company: 'Acme' }, { company: 'Acme' }, mapped)).toBe(false);
  });

  it('treats null/undefined/empty-string as equal (no spurious change)', () => {
    expect(mappedFieldChanged({ company: '' }, { company: null }, mapped)).toBe(false);
    expect(mappedFieldChanged({}, { company: undefined }, mapped)).toBe(false);
  });

  it('true when a mapped custom field value changes', () => {
    expect(mappedFieldChanged(
      { customFields: { notes: 'old' } },
      { customFields: { notes: 'new' } },
      mapped,
    )).toBe(true);
  });
});

describe('buildSyncedMetadata / buildFailedMetadata', () => {
  it('buildSyncedMetadata sets contact id + synced + lastSyncedAt and clears syncError', () => {
    const out = buildSyncedMetadata(
      { hubspot_deal_id: 'd1', syncError: 'old error' }, 'c1', '2026-06-22T00:00:00.000Z',
    );
    expect(out).toEqual({
      hubspot_deal_id: 'd1',
      hubspot_contact_id: 'c1',
      syncStatus: 'synced',
      lastSyncedAt: '2026-06-22T00:00:00.000Z',
    });
    expect('syncError' in out).toBe(false);
  });

  it('buildFailedMetadata sets sync_failed + error and preserves existing ids', () => {
    const out = buildFailedMetadata({ hubspot_contact_id: 'c1' }, 'boom');
    expect(out).toEqual({ hubspot_contact_id: 'c1', syncStatus: 'sync_failed', syncError: 'boom' });
  });

  it('builders tolerate undefined existing metadata', () => {
    expect(buildSyncedMetadata(undefined, 'c1', 'now').hubspot_contact_id).toBe('c1');
    expect(buildFailedMetadata(undefined, 'e').syncStatus).toBe('sync_failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest leadSyncStatus.test.ts`
Expected: FAIL — `Cannot find module '../utils/leadSyncStatus'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/utils/leadSyncStatus.ts`:

```typescript
/**
 * Per-lead external-CRM (HubSpot) sync status helpers.
 *
 * This is a LEAF module: it must not import from services/ or adapters/ so the
 * adapter (which imports these builders) doesn't create a require cycle.
 */

export type LeadSyncStatus = 'synced' | 'sync_pending' | 'update_pending' | 'sync_failed';

export interface HubspotConnection {
  connected: boolean;
  autoSyncEnabled: boolean;
  /** The raw stored ExternalCrmSyncConfig for the hubspot provider, or null. */
  config: any | null;
}

// Native lead fields we treat as "mapped" when a connected config has no
// enabled mappings of its own (defensive fallback only — real configs always
// carry contactFieldMapping). Kept local to avoid importing the service module.
const DEFAULT_MAPPED_FIELDS = [
  'email', 'firstName', 'lastName', 'phone', 'company', 'title',
  'linkedin', 'notes', 'status', 'dealValue', 'dealCurrency',
];

/** Read the HubSpot connection state off a lead-list record. */
export function getHubspotConnection(list: any): HubspotConnection {
  const config = list?.externalCrmSyncConfigs?.hubspot ?? null;
  const connected = !!config && (!!config.accountId || !!config.apiKeyEncrypted);
  return { connected, autoSyncEnabled: !!config?.autoSyncEnabled, config };
}

/**
 * Resolve a lead's sync status for display/filtering. Authoritative when the
 * persisted field is present; otherwise derives a value for legacy leads:
 *   hubspot_contact_id present -> 'synced', else 'sync_pending'.
 * Returns null when the list isn't connected (no chip / no filter).
 */
export function resolveSyncStatus(lead: any, connected: boolean): LeadSyncStatus | null {
  if (!connected) return null;
  const persisted = lead?.syncMetadata?.syncStatus as LeadSyncStatus | undefined;
  if (persisted) return persisted;
  return lead?.syncMetadata?.hubspot_contact_id ? 'synced' : 'sync_pending';
}

/** Set of agentwebField names that are pushed to HubSpot (enabled, not pull-only). */
export function getMappedAgentwebFields(config: any): Set<string> {
  const all = [
    ...(config?.contactFieldMapping || []),
    ...(config?.dealFieldMapping || []),
    ...(config?.customFieldMapping || []),
  ];
  const fields = new Set<string>();
  for (const m of all) {
    if (m?.enabled && m?.direction !== 'pull' && m?.agentwebField) {
      fields.add(m.agentwebField);
    }
  }
  if (fields.size === 0) {
    for (const f of DEFAULT_MAPPED_FIELDS) fields.add(f);
  }
  return fields;
}

// Treat null / undefined / '' as the same "empty" value so clearing a field or
// re-saving an unchanged blank doesn't read as a change.
function norm(v: any): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * True if `updates` changes the value of any HubSpot-mapped field relative to
 * `existing`. Checks top-level fields and nested customFields. Over-marking is
 * acceptable (worst case: one extra re-push); under-marking is not.
 */
export function mappedFieldChanged(existing: any, updates: any, mappedFields: Set<string>): boolean {
  for (const f of mappedFields) {
    if (updates && Object.prototype.hasOwnProperty.call(updates, f)) {
      if (norm(existing?.[f]) !== norm(updates[f])) return true;
    }
    if (updates?.customFields && Object.prototype.hasOwnProperty.call(updates.customFields, f)) {
      if (norm(existing?.customFields?.[f]) !== norm(updates.customFields[f])) return true;
    }
  }
  return false;
}

/**
 * Merge for a successful per-lead push: stamp contact id + synced + lastSyncedAt,
 * preserve any other ids (e.g. hubspot_deal_id), and CLEAR a prior syncError.
 */
export function buildSyncedMetadata(
  existing: Record<string, any> | undefined,
  contactId: string,
  nowIso: string,
): Record<string, any> {
  const merged: Record<string, any> = {
    ...(existing || {}),
    hubspot_contact_id: contactId,
    syncStatus: 'synced',
    lastSyncedAt: nowIso,
  };
  delete merged.syncError; // omit (not undefined) so DynamoDB drops it cleanly
  return merged;
}

/** Merge for a failed per-lead push: stamp sync_failed + error, preserve ids. */
export function buildFailedMetadata(
  existing: Record<string, any> | undefined,
  errorMsg: string,
): Record<string, any> {
  return { ...(existing || {}), syncStatus: 'sync_failed', syncError: errorMsg };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest leadSyncStatus.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/leadSyncStatus.ts backend/src/__tests__/leadSyncStatus.test.ts
git commit -m "feat(crm): add leadSyncStatus helpers for per-lead HubSpot sync state"
```

---

## Task 2: Adapter writes per-lead `synced` / `sync_failed` (and stops clobbering)

The HubSpot adapter is the single choke point for both manual push and
auto-sync (auto-sync calls `adapter.pushLeads([lead])`). We:
1. Add a `persistSyncMetadata(lead, listId, meta)` helper that writes the map
   AND updates the in-memory `lead.syncMetadata`, so sequential writebacks in
   one push don't clobber each other (also fixes a latent drop of
   `hubspot_contact_id` when deals are configured).
2. Route the contact-id writeback through `buildSyncedMetadata`.
3. Mark failed leads (`sync_failed`) on the per-lead catch, the batch
   failed-email reconcile, and both invalid-email guards.

**Files:**
- Modify: `backend/src/services/adapters/hubspotAdapter.ts`
- Test: `backend/src/__tests__/hubspotAdapter.pushLeads.batch.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/__tests__/hubspotAdapter.pushLeads.batch.test.ts` (follow the existing mock setup in that file — reuse its `crmDb.updateLead` mock and `HubSpotService` mock; the assertions below describe the required behavior). Add a new `describe`:

```typescript
describe('pushLeads — per-lead sync status', () => {
  it('marks a successfully upserted lead synced with lastSyncedAt and clears prior error', async () => {
    // Arrange: one email lead, batchUpsertContacts returns a contactId.
    // (Mirror the existing batch test's happy-path arrangement.)
    // Act: await adapter.pushLeads(auth, [lead], config)
    // Assert: crmDb.updateLead called for the lead with syncMetadata containing
    //   syncStatus: 'synced', hubspot_contact_id: <id>, lastSyncedAt: <string>,
    //   and NO syncError key.
    const calls = (crmDb.updateLead as jest.Mock).mock.calls;
    const meta = calls.find(c => c[1] === lead.leadId)?.[2]?.syncMetadata;
    expect(meta.syncStatus).toBe('synced');
    expect(meta.hubspot_contact_id).toBeTruthy();
    expect(typeof meta.lastSyncedAt).toBe('string');
    expect('syncError' in meta).toBe(false);
  });

  it('marks exactly the failing lead sync_failed when its email is rejected', async () => {
    // Arrange: two email leads; mock batchUpsertContacts so good@x.com resolves
    // and bad@x.com is reported invalid (use the existing invalid-email mock
    // pattern in this file). Act: pushLeads with both.
    // Assert: good lead -> syncStatus 'synced'; bad lead -> syncStatus
    //   'sync_failed' with a syncError string.
    const calls = (crmDb.updateLead as jest.Mock).mock.calls;
    const goodMeta = calls.find(c => c[1] === goodLead.leadId)?.[2]?.syncMetadata;
    const badMeta = calls.find(c => c[1] === badLead.leadId)?.[2]?.syncMetadata;
    expect(goodMeta.syncStatus).toBe('synced');
    expect(badMeta.syncStatus).toBe('sync_failed');
    expect(typeof badMeta.syncError).toBe('string');
  });

  it('preserves hubspot_contact_id AND syncStatus after the deal writeback', async () => {
    // Arrange: deal mappings configured so Stage 4 runs; mock deal create to
    // return a dealId. Act: pushLeads([leadWithDealFields]).
    // Assert: the LAST updateLead for the lead has syncMetadata with all of:
    //   hubspot_contact_id, hubspot_deal_id, syncStatus: 'synced'.
    const calls = (crmDb.updateLead as jest.Mock).mock.calls.filter(c => c[1] === lead.leadId);
    const last = calls[calls.length - 1][2].syncMetadata;
    expect(last.hubspot_contact_id).toBeTruthy();
    expect(last.hubspot_deal_id).toBeTruthy();
    expect(last.syncStatus).toBe('synced');
  });
});
```

> Note: fill the Arrange/Act sections using the exact mock helpers already
> present at the top of this test file (do not invent new mocking infrastructure
> — reuse `crmDb.updateLead`, the `HubSpotService` mock, and the `config`/`auth`
> fixtures the existing tests use). The assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest hubspotAdapter.pushLeads.batch.test.ts -t "per-lead sync status"`
Expected: FAIL — `syncStatus` undefined / deal writeback drops `hubspot_contact_id`.

- [ ] **Step 3: Add the import and the persist helper**

In `hubspotAdapter.ts`, add to the imports near line 6:

```typescript
import { buildSyncedMetadata, buildFailedMetadata } from '../../utils/leadSyncStatus';
```

Add this private helper to the `HubspotAdapter` class (place it next to
`writebackDealId`, around line 680):

```typescript
    /**
     * Persist a syncMetadata map for a lead AND update the in-memory lead so
     * later writebacks in the SAME push spread the latest value instead of a
     * stale snapshot (updateLead replaces the whole map). Non-critical: logs on
     * failure, never throws.
     */
    private async persistSyncMetadata(lead: any, listId: string, meta: Record<string, any>): Promise<void> {
        lead.syncMetadata = meta;
        await crmDb.updateLead(lead.listId || listId, lead.leadId, { syncMetadata: meta })
            .catch((err: any) => {
                console.error(`[HubspotAdapter] failed to persist syncMetadata for ${lead.email || lead.leadId}: ${this.formatError(err)}`);
            });
    }
```

- [ ] **Step 4: Per-lead path — mark synced on success, failed on error/invalid**

In `pushLeadsPerLead`, replace the contact-id writeback (current lines 287–292):

```typescript
                // Persist HubSpot contact ID back to our DB
                await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                    syncMetadata: { ...(lead.syncMetadata || {}), hubspot_contact_id: contactId },
                }).catch((err) => {
                    console.error(`[HubspotAdapter] failed to persist hubspot_contact_id for ${lead.email}: ${this.formatError(err)}`);
                });
```

with:

```typescript
                // Persist HubSpot contact ID + synced status back to our DB.
                await this.persistSyncMetadata(
                    lead, config.listId,
                    buildSyncedMetadata(lead.syncMetadata, contactId, new Date().toISOString()),
                );
```

In the same method, update the invalid-email guard (current lines ~225–233) to
mark the lead failed before `continue`. Replace:

```typescript
                if (email && !validateEmail(email)) {
                    result.errorCount++;
                    const msg = `Invalid email "${email}" — skipped (not a valid email address)`;
                    console.warn(`[HubspotAdapter] ${msg} for lead=${lead.leadId}`);
                    result.errors.push(`${email}: ${msg}`);
                    continue;
                }
```

with:

```typescript
                if (email && !validateEmail(email)) {
                    result.errorCount++;
                    const msg = `Invalid email "${email}" — skipped (not a valid email address)`;
                    console.warn(`[HubspotAdapter] ${msg} for lead=${lead.leadId}`);
                    result.errors.push(`${email}: ${msg}`);
                    await this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, msg));
                    continue;
                }
```

And update the catch block (current lines 305–310) to mark the lead failed:

```typescript
            } catch (err: any) {
                result.errorCount++;
                const msg = this.formatError(err);
                console.error(`[HubspotAdapter] lead sync failed for ${lead.email || lead.leadId}: ${msg}`);
                result.errors.push(`${lead.email || lead.leadId}: ${msg}`);
                await this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, msg));
            }
```

- [ ] **Step 5: Batch path — mark synced on success, failed on reconcile + invalid-email**

In `pushLeadsBatched`, update the Stage 1 invalid-email guard (current lines
347–353) to mark failed before `continue`:

```typescript
            if (email && !validateEmail(email)) {
                result.errorCount++;
                const msg = `Invalid email "${email}" — skipped (not a valid email address)`;
                console.warn(`[HubspotAdapter] ${msg} for lead=${lead.leadId}`);
                result.errors.push(`${email}: ${msg}`);
                await this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, msg));
                continue;
            }
```

In the reconcile loop (current lines 426–437), capture failed leads. Replace:

```typescript
        const contactIdByLead = new Map<any, string>();      // lead → contactId
        const succeededEmailLeads: any[] = [];
        for (const p of emailLeads) {
            const r = contactResults.get(p.emailLower);
            if (r) {
                result.successCount++;
                if (r.isNew) result.newCount++; else result.updatedCount++;
                contactIdByLead.set(p.lead, r.contactId);
                succeededEmailLeads.push(p.lead);
            } else {
                result.errorCount++;
                result.errors.push(`${p.emailLower}: ${failureReason.get(p.emailLower) || 'contact upsert failed'}`);
            }
        }
```

with:

```typescript
        const contactIdByLead = new Map<any, string>();      // lead → contactId
        const succeededEmailLeads: any[] = [];
        const failedEmailLeads: Array<{ lead: any; reason: string }> = [];
        for (const p of emailLeads) {
            const r = contactResults.get(p.emailLower);
            if (r) {
                result.successCount++;
                if (r.isNew) result.newCount++; else result.updatedCount++;
                contactIdByLead.set(p.lead, r.contactId);
                succeededEmailLeads.push(p.lead);
            } else {
                result.errorCount++;
                const reason = failureReason.get(p.emailLower) || 'contact upsert failed';
                result.errors.push(`${p.emailLower}: ${reason}`);
                failedEmailLeads.push({ lead: p.lead, reason });
            }
        }
```

Replace the Stage 3 writeback (current lines 439–448) to mark succeeded leads
synced and failed leads sync_failed:

```typescript
        // ── Stage 3: write back contact ids + synced status BEFORE deals ───────
        const stage3Now = new Date().toISOString();
        await Promise.all([
            ...succeededEmailLeads.map(lead =>
                this.persistSyncMetadata(
                    lead, config.listId,
                    buildSyncedMetadata(lead.syncMetadata, contactIdByLead.get(lead)!, stage3Now),
                )
            ),
            ...failedEmailLeads.map(({ lead, reason }) =>
                this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, reason))
            ),
        ]);
```

- [ ] **Step 6: Route the deal writeback through the in-memory-safe helper**

Replace `writebackDealId` (current lines 681–687):

```typescript
    private writebackDealId(lead: any, dealId: string, config: ExternalCrmSyncConfig): Promise<any> {
        return crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
            syncMetadata: { ...(lead.syncMetadata || {}), hubspot_deal_id: dealId },
        }).catch((err: any) => {
            console.error(`[HubspotAdapter] failed to persist hubspot_deal_id for lead=${lead.email || lead.leadId}: ${this.formatError(err)}`);
        });
    }
```

with:

```typescript
    private writebackDealId(lead: any, dealId: string, config: ExternalCrmSyncConfig): Promise<any> {
        // Merge onto the latest in-memory syncMetadata (set by Stage 3's synced
        // writeback) so we don't clobber hubspot_contact_id / syncStatus.
        return this.persistSyncMetadata(lead, config.listId, {
            ...(lead.syncMetadata || {}),
            hubspot_deal_id: dealId,
        });
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && npx jest hubspotAdapter.pushLeads.batch.test.ts`
Expected: PASS, including the new `per-lead sync status` cases and all pre-existing cases.

- [ ] **Step 8: Verify compilation + full adapter suites**

Run: `cd backend && npx tsc && npx jest hubspotAdapter hubspotService hubspotBatchRetry`
Expected: no type errors; all suites pass.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/adapters/hubspotAdapter.ts backend/src/__tests__/hubspotAdapter.pushLeads.batch.test.ts
git commit -m "feat(crm): write per-lead HubSpot sync status during push (and stop syncMetadata clobber)"
```

---

## Task 3: Confirm auto-sync propagates per-lead status (test only)

Auto-sync (`externalCrmSyncService.autoSyncLead`) re-reads the lead and calls
`adapter.pushLeads(auth, [fresh], cfg)`, so Task 2 already makes it write
per-lead status. This task locks that in with a test — no production change
expected. If the test reveals `fresh` isn't passed through, fix `autoSyncLead`
to pass the re-read lead (it already does at the `reReadLead` call).

**Files:**
- Test: `backend/src/__tests__/externalCrmSync.service.test.ts`

- [ ] **Step 1: Write the test**

Add to `backend/src/__tests__/externalCrmSync.service.test.ts` (reuse the file's
existing mocks for `crmDb` and the adapter registry / HubSpot service):

```typescript
describe('autoSyncLead — per-lead status propagation', () => {
  it('a successful auto-sync results in the lead being marked synced', async () => {
    // Arrange: getConfig returns a connected config with autoSyncEnabled:true;
    // the hubspot adapter mock resolves the upsert. Act: autoSyncLead(...,'updated').
    // Assert: crmDb.updateLead was called with syncMetadata.syncStatus === 'synced'.
    const meta = (crmDb.updateLead as jest.Mock).mock.calls.at(-1)?.[2]?.syncMetadata;
    expect(meta?.syncStatus).toBe('synced');
  });

  it('does nothing per-lead when autoSync is disabled', async () => {
    // Arrange: config.autoSyncEnabled = false. Act: autoSyncLead(...).
    // Assert: adapter.pushLeads NOT called (no status write from auto-sync).
    expect(pushLeadsMock).not.toHaveBeenCalled();
  });
});
```

> Use the suite's existing adapter mock; if the suite stubs `getAdapter`/the
> HubSpot service, assert on that mock rather than `crmDb` for the disabled case.

- [ ] **Step 2: Run the test**

Run: `cd backend && npx jest externalCrmSync.service.test.ts -t "per-lead status propagation"`
Expected: PASS (Task 2 supplies the behavior). If FAIL because `autoSyncLead`
doesn't forward the re-read lead, ensure the `reReadLead(...)` result is the
object passed to `adapter.pushLeads`, then re-run.

- [ ] **Step 3: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/__tests__/externalCrmSync.service.test.ts
git commit -m "test(crm): auto-sync propagates per-lead HubSpot sync status"
```

---

## Task 4: Create route stamps `sync_pending` when connected

**Files:**
- Modify: `backend/src/routes/crm.ts` (POST `/lists/:listId/leads`, ~line 1895)
- Test: `backend/src/__tests__/crm.leads.syncStatus.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/crm.leads.syncStatus.test.ts`. Mock `crmDb` and
`externalCrmSyncService`, mount the crm router on an Express app, and exercise
the route (follow the pattern of any existing `crm.*.test.ts` route test in the
folder for app/router setup and auth-middleware stubbing):

```typescript
// (Setup: supertest app with the crm router, authenticated as a user who can
// access the list; crmDb.getLeadListById returns a list; crmDb.createLead
// echoes back the leadData it received.)

describe('POST /lists/:listId/leads — sync_pending stamping', () => {
  it('stamps syncStatus sync_pending in syncMetadata when the list is HubSpot-connected', async () => {
    // Arrange: getLeadListById returns a list with
    //   externalCrmSyncConfigs.hubspot = { accountId: 'acc1', autoSyncEnabled: false }
    // Act: POST a new lead.
    // Assert: crmDb.createLead was called with leadData.syncMetadata.syncStatus === 'sync_pending'
    const arg = (crmDb.createLead as jest.Mock).mock.calls[0][1];
    expect(arg.syncMetadata.syncStatus).toBe('sync_pending');
  });

  it('does NOT stamp syncStatus when the list is not connected', async () => {
    // Arrange: list with no externalCrmSyncConfigs.
    // Assert: createLead called with leadData having no syncMetadata.syncStatus.
    const arg = (crmDb.createLead as jest.Mock).mock.calls[0][1];
    expect(arg.syncMetadata?.syncStatus).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest crm.leads.syncStatus.test.ts -t "sync_pending stamping"`
Expected: FAIL — `syncStatus` not stamped.

- [ ] **Step 3: Implement**

In `backend/src/routes/crm.ts`, add the import near the other util imports at the
top of the file:

```typescript
import { getHubspotConnection, getMappedAgentwebFields, mappedFieldChanged, resolveSyncStatus } from '../utils/leadSyncStatus';
```

In the POST `/lists/:listId/leads` handler, after the access check and BEFORE
`const lead = await crmDb.createLead(listId, leadData);` (current ~line 1944),
insert:

```typescript
    // Stamp an initial per-lead sync status when this list is connected to
    // HubSpot. If auto-sync is on, the subsequent autoSyncLead push overwrites
    // this with 'synced'/'sync_failed' via the adapter.
    const hsConn = getHubspotConnection(list);
    if (hsConn.connected) {
      leadData.syncMetadata = { ...(leadData.syncMetadata || {}), syncStatus: 'sync_pending' };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest crm.leads.syncStatus.test.ts -t "sync_pending stamping"`
Expected: PASS.

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/crm.ts backend/src/__tests__/crm.leads.syncStatus.test.ts
git commit -m "feat(crm): stamp sync_pending on new leads when HubSpot-connected"
```

---

## Task 5: Update route stamps `update_pending` on a mapped-field change

**Files:**
- Modify: `backend/src/routes/crm.ts` (PUT `/lists/:listId/leads/:leadId`, ~line 2412)
- Test: `backend/src/__tests__/crm.leads.syncStatus.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `backend/src/__tests__/crm.leads.syncStatus.test.ts`:

```typescript
describe('PUT /lists/:listId/leads/:leadId — update_pending stamping', () => {
  it('marks a synced lead update_pending when a mapped field changes and auto-sync is off', async () => {
    // Arrange: list connected, hubspot.autoSyncEnabled = false, default mappings.
    //   crmDb.getLeadById returns an existing lead:
    //   { leadId, company: 'Acme', syncMetadata: { hubspot_contact_id: 'c1', syncStatus: 'synced' } }
    // Act: PUT { company: 'Beta' }
    // Assert: crmDb.updateLead called with updateData.syncMetadata.syncStatus === 'update_pending'
    const arg = (crmDb.updateLead as jest.Mock).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata.syncStatus).toBe('update_pending');
    expect(arg.syncMetadata.hubspot_contact_id).toBe('c1'); // preserved
  });

  it('does NOT mark update_pending when only an unmapped field changes', async () => {
    // existing lead synced; PUT { priority: 'High' } (priority is not mapped)
    const arg = (crmDb.updateLead as jest.Mock).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata?.syncStatus).not.toBe('update_pending');
  });

  it('does NOT mark update_pending when auto-sync is enabled (adapter will set status)', async () => {
    // list connected, autoSyncEnabled = true; PUT { company: 'Beta' }
    const arg = (crmDb.updateLead as jest.Mock).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata?.syncStatus).not.toBe('update_pending');
  });

  it('does NOT mark update_pending when the lead was never synced (stays sync_pending)', async () => {
    // existing lead { syncMetadata: {} } (resolves to sync_pending); PUT { company: 'Beta' }
    const arg = (crmDb.updateLead as jest.Mock).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata?.syncStatus).not.toBe('update_pending');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest crm.leads.syncStatus.test.ts -t "update_pending stamping"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the PUT handler, after the access check and before
`const updateData = updates;` (current ~line 2447), insert:

```typescript
    // When this list is connected to HubSpot with auto-sync OFF, a change to a
    // HubSpot-mapped field on an already-synced lead means it needs re-pushing —
    // surface that as update_pending so it shows in the sync filter. With
    // auto-sync ON the adapter sets synced/sync_failed instead, so we skip.
    const hsConnUpd = getHubspotConnection(list);
    if (hsConnUpd.connected && !hsConnUpd.autoSyncEnabled) {
      const existingForSync = await crmDb.getLeadById(listId, leadId);
      if (existingForSync && resolveSyncStatus(existingForSync, true) === 'synced'
          && mappedFieldChanged(existingForSync, updates, getMappedAgentwebFields(hsConnUpd.config))) {
        updates.syncMetadata = { ...(existingForSync.syncMetadata || {}), syncStatus: 'update_pending' };
      }
    }
```

> `updates` is the same object referenced by `const updateData = updates;`, so
> the stamped `syncMetadata` flows into `crmDb.updateLead(listId, leadId, updateData)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest crm.leads.syncStatus.test.ts`
Expected: PASS (both create and update describes).

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/crm.ts backend/src/__tests__/crm.leads.syncStatus.test.ts
git commit -m "feat(crm): mark leads update_pending when a mapped field changes (auto-sync off)"
```

---

## Task 6: `GET leads` — syncStatus filter, hubspotConnected flag, resolved status

**Files:**
- Modify: `backend/src/routes/crm.ts` (GET `/lists/:listId/leads`, ~line 1705)
- Test: `backend/src/__tests__/crm.leads.syncStatus.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `backend/src/__tests__/crm.leads.syncStatus.test.ts`:

```typescript
describe('GET /lists/:listId/leads — sync status filter + flags', () => {
  it('returns hubspotConnected:true and a resolved syncStatus per lead when connected', async () => {
    // Arrange: connected list; crmDb.getLeadsByListId returns leads:
    //   A { syncMetadata: { syncStatus: 'synced' } }
    //   B { syncMetadata: { hubspot_contact_id: 'c1' } }  // legacy -> synced
    //   C { syncMetadata: {} }                            // -> sync_pending
    // Act: GET (no syncStatus filter)
    // Assert: body.hubspotConnected === true and each returned lead has
    //   syncStatus resolved (A,B -> 'synced'; C -> 'sync_pending').
    expect(res.body.hubspotConnected).toBe(true);
  });

  it('filters to only leads whose resolved status matches ?syncStatus=', async () => {
    // Same candidates; Act: GET ?syncStatus=sync_pending
    // Assert: only lead C returned.
    expect(res.body.leads.map((l: any) => l.leadId)).toEqual(['C']);
  });

  it('returns hubspotConnected:false and no syncStatus filtering when not connected', async () => {
    // Arrange: list with no hubspot config. Act: GET ?syncStatus=synced
    // Assert: body.hubspotConnected === false; the syncStatus param is ignored
    //   (all leads returned).
    expect(res.body.hubspotConnected).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest crm.leads.syncStatus.test.ts -t "sync status filter"`
Expected: FAIL — `hubspotConnected` undefined; param not applied.

- [ ] **Step 3: Implement — parse param + connection**

In the GET handler, add to the query parsing block (after `linkedInConnectedQuery`, ~line 1716):

```typescript
    const syncStatusQuery = typeof req.query.syncStatus === 'string' ? req.query.syncStatus.trim() : '';
```

After the list is fetched and access-checked (after the `canAccessCrmList` block,
~line 1733), compute connection:

```typescript
    const hsConn = getHubspotConnection(list);
    const syncStatusFilter = hsConn.connected ? syncStatusQuery : '';
```

- [ ] **Step 4: Implement — include syncStatus in the filtered-mode trigger**

Replace the filtered-mode condition (current ~line 1751):

```typescript
    if (list.icpsOnly || search || effectiveEngagedOnly || statusQuery || linkedInConnectedFilter) {
```

with:

```typescript
    if (list.icpsOnly || search || effectiveEngagedOnly || statusQuery || linkedInConnectedFilter || syncStatusFilter) {
```

- [ ] **Step 5: Implement — apply the in-memory sync filter**

In the `allMatchingLeads` filter callback (the `candidateLeads.filter(...)` block,
current ~lines 1789–1810), add this clause before the final `return true;`:

```typescript
        if (syncStatusFilter && resolveSyncStatus(lead, hsConn.connected) !== syncStatusFilter) {
          return false;
        }
```

> When `syncStatusFilter` is the only active filter, `candidateLeads` comes from
> the `else` branch (`fetchAllLeadsByList`), which loads the full list — the same
> approach `search` already uses. No GSI required.

- [ ] **Step 6: Implement — add resolved status + connected flag to the response**

In the `leadsWithCounts` map (current ~lines 1854–1865), attach the resolved
status. Replace the `return sanitizeLeadForResponse({ ... });` with:

```typescript
        return {
          ...sanitizeLeadForResponse({
            ...lead,
            engagementCount: engagementCounts.total,
            engagementCountLast7Days: engagementCounts.last7Days,
            totalAllMessages: engagementCounts.totalAllMessages,
          }),
          syncStatus: resolveSyncStatus(lead, hsConn.connected),
        };
```

Then add `hubspotConnected` to the final `res.json({ ... })` payload (current
~line 1878):

```typescript
    res.json({
      leads: leadsWithCounts,
      page: validPage,
      limit: validLimit,
      totalPages: knownTotalPages ?? (hasMoreLeads ? null : validPage),
      hasMore: hasMoreLeads,
      totalFilteredCount,
      hubspotConnected: hsConn.connected,
    });
```

> Note: the two early `res.json({ leads: [], ... })` returns inside the handler
> (empty-page short-circuits) don't need `hubspotConnected` — the frontend keeps
> its last known value and those paths return zero leads anyway. Leave them as-is.

- [ ] **Step 7: Run test to verify it passes**

Run: `cd backend && npx jest crm.leads.syncStatus.test.ts`
Expected: PASS (all describes).

- [ ] **Step 8: Verify compilation + full crm route suite**

Run: `cd backend && npx tsc && npx jest crm`
Expected: no type errors; crm route suites pass.

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes/crm.ts backend/src/__tests__/crm.leads.syncStatus.test.ts
git commit -m "feat(crm): syncStatus filter + hubspotConnected flag + resolved status on GET leads"
```

---

## Task 7: Customer-portal — Lead type, state, fetch wiring

> Frontend UI is exempt from strict TDD (CLAUDE.md Rule 2); verify via
> `npx tsc`/build and manual check. Keep value strings identical to the backend.

**Files:**
- Modify: `customer-portal/src/pages/CRM.tsx`

- [ ] **Step 1: Extend the `Lead` interface**

In the `interface Lead { ... }` block (~lines 177–225), add after `updatedAt: string;`:

```typescript
  syncMetadata?: {
    hubspot_contact_id?: string;
    hubspot_deal_id?: string;
    syncStatus?: 'synced' | 'sync_pending' | 'update_pending' | 'sync_failed';
    lastSyncedAt?: string;
    syncError?: string;
  };
  /** Resolved per-lead sync status injected by GET /leads when HubSpot-connected. */
  syncStatus?: 'synced' | 'sync_pending' | 'update_pending' | 'sync_failed' | null;
```

- [ ] **Step 2: Add state**

Near the other filter state declarations in the `CRM` component (e.g. close to
`statusFilter`), add:

```typescript
  const [syncStatusFilter, setSyncStatusFilter] = useState<string>('');
  const [hubspotConnected, setHubspotConnected] = useState<boolean>(false);
```

- [ ] **Step 3: Send the filter param in `fetchLeads`**

In `fetchLeads` (~line 1487), add to the axios `params` object, after the
`linkedInConnected` line:

```typescript
            ...(syncStatusFilter ? { syncStatus: syncStatusFilter } : {}),
```

- [ ] **Step 4: Read `hubspotConnected` from the response**

In `fetchLeads`, where the response is handled (right after `const response = await axios.get(...)`),
add (guarded so a stale request doesn't overwrite — place beside the existing
`requestId`/`latestLeadsRequestIdRef` check):

```typescript
      if (requestId === latestLeadsRequestIdRef.current) {
        setHubspotConnected(response.data?.hubspotConnected === true);
      }
```

- [ ] **Step 5: Re-fetch when the sync filter changes**

Find the effect/handler that triggers `fetchLeads` on filter changes (the same
place `statusFilter` is wired). Add `syncStatusFilter` to that effect's
dependency array so changing it refetches page 1. If status changes reset the
page (look for `setCurrentPage(1)` on `statusFilter` change), mirror that for
`syncStatusFilter`.

- [ ] **Step 6: Verify compilation**

Run: `cd customer-portal && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add customer-portal/src/pages/CRM.tsx
git commit -m "feat(crm-ui): lead sync status type, state, and fetch wiring"
```

---

## Task 8: Customer-portal — sync chip near contact name

**Files:**
- Modify: `customer-portal/src/pages/CRM.tsx`

- [ ] **Step 1: Add a chip helper above the component**

Near `STATUS_COLOR_MAP` (~line 227), add:

```typescript
const SYNC_STATUS_CHIP: Record<string, { label: string; className: string }> = {
  synced: {
    label: 'Synced',
    className: 'bg-green-50 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700',
  },
  sync_pending: {
    label: 'Sync pending',
    className: 'bg-gray-50 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600',
  },
  update_pending: {
    label: 'Update pending',
    className: 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  },
  sync_failed: {
    label: 'Sync failed',
    className: 'bg-red-50 text-red-700 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
  },
};
```

- [ ] **Step 2: Render the chip in the contact cell**

In the contact `TableCell`, at the `{/* ADD SYNC-STATUS CHIP HERE */}` location
(inside the name `div`, after the `unsubscribedFromGroupEmail` icon, ~line 9893),
insert:

```typescript
                                      {hubspotConnected && lead.syncStatus && SYNC_STATUS_CHIP[lead.syncStatus] && (
                                        <Badge
                                          variant="outline"
                                          title={
                                            lead.syncStatus === 'sync_failed' && lead.syncMetadata?.syncError
                                              ? lead.syncMetadata.syncError
                                              : lead.syncMetadata?.lastSyncedAt
                                                ? `Last synced ${new Date(lead.syncMetadata.lastSyncedAt).toLocaleString()}`
                                                : SYNC_STATUS_CHIP[lead.syncStatus].label
                                          }
                                          className={`text-[10px] font-medium px-1.5 py-0.5 whitespace-nowrap ${SYNC_STATUS_CHIP[lead.syncStatus].className}`}
                                        >
                                          {SYNC_STATUS_CHIP[lead.syncStatus].label}
                                        </Badge>
                                      )}
```

- [ ] **Step 3: Verify compilation**

Run: `cd customer-portal && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add customer-portal/src/pages/CRM.tsx
git commit -m "feat(crm-ui): per-lead HubSpot sync status chip"
```

---

## Task 9: Customer-portal — filter control, pill, URL persistence

**Files:**
- Modify: `customer-portal/src/pages/CRM.tsx`

- [ ] **Step 1: Add the filter control in the Filters popover**

In the `PopoverContent` (~line 5495, near the Status `<select>`), add (gated on
connection):

```typescript
                        {hubspotConnected && (
                          <div className="space-y-1.5">
                            <label htmlFor="syncStatusFilter" className="text-sm font-medium leading-none">Sync status</label>
                            <select
                              id="syncStatusFilter"
                              className="w-full text-sm border rounded px-2 py-1.5 bg-background"
                              value={syncStatusFilter}
                              onChange={(e) => setSyncStatusFilter(e.target.value)}
                            >
                              <option value="">All</option>
                              <option value="synced">Synced</option>
                              <option value="sync_pending">Sync pending</option>
                              <option value="update_pending">Update pending</option>
                              <option value="sync_failed">Sync failed</option>
                            </select>
                          </div>
                        )}
```

- [ ] **Step 2: Show the active-filter pill**

In the active-filter pills row (~line 5356, after the LinkedIn-connected pill),
add:

```typescript
                    {hubspotConnected && syncStatusFilter && SYNC_STATUS_CHIP[syncStatusFilter] && (
                      <Badge variant="secondary" className="gap-1 pl-2 pr-1 py-1 text-xs">
                        Sync: {SYNC_STATUS_CHIP[syncStatusFilter].label}
                        <button
                          type="button"
                          onClick={() => setSyncStatusFilter('')}
                          className="hover:bg-muted rounded-sm p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    )}
```

Also include the sync filter in the Filters-button "active filter count" badge
and the pills-row visibility condition (both currently around lines 5356–5371
and 5222): add `|| (hubspotConnected && !!syncStatusFilter)` to the boolean
guards, and `+ (hubspotConnected && syncStatusFilter ? 1 : 0)` to the count.

- [ ] **Step 3: Persist to URL + restore on load**

In the URL-persistence `useEffect` (~lines 896–939), add after the
`linkedInConnectedFilter` block:

```typescript
    if (syncStatusFilter) {
      params.set('syncStatus', syncStatusFilter);
    } else {
      params.delete('syncStatus');
    }
```

Add `syncStatusFilter` to that effect's dependency array.

For restore-on-load, find where the other filters are initialized from the URL
(the code that reads `params.get('status')` etc. on mount) and add:

```typescript
    const syncStatusParam = params.get('syncStatus');
    if (syncStatusParam) setSyncStatusFilter(syncStatusParam);
```

- [ ] **Step 4: Verify compilation + build**

Run: `cd customer-portal && npx tsc --noEmit && npm run build`
Expected: no errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add customer-portal/src/pages/CRM.tsx
git commit -m "feat(crm-ui): HubSpot sync status filter, pill, and URL persistence"
```

---

## Task 10: Full verification

- [ ] **Step 1: Backend types + tests**

Run: `cd backend && npx tsc && npm test`
Expected: compilation clean; all suites pass (new + existing).

- [ ] **Step 2: Customer-portal types + tests**

Run: `cd customer-portal && npx tsc --noEmit && npm test`
Expected: clean; tests pass.

- [ ] **Step 3: Manual smoke (cloud test env, optional)**

If a cloud test env is active: `./test-env/test-env.sh sync`, connect a list to
HubSpot, then verify in the CRM UI:
- chips appear only on connected lists;
- a new lead shows "Sync pending" (auto-sync off), "Synced" after a push;
- editing a mapped field on a synced lead (auto-sync off) shows "Update pending";
- the Sync-status filter narrows the list and persists across reload.

---

## Self-review notes (coverage check)

- Spec "data model" → Task 1 (`syncMetadata.syncStatus/lastSyncedAt/syncError`).
- Spec "state machine: push success/failure" → Task 2; "auto-sync" → Tasks 2+3;
  "create → sync_pending" → Task 4; "update → update_pending (mapped only)" →
  Task 5; "never-synced derive" → Task 1 `resolveSyncStatus` + Task 6.
- Spec "connected gate" → `getHubspotConnection` (Task 1) used in Tasks 4/5/6 and
  surfaced as `hubspotConnected` (Task 6) for the UI gate (Tasks 8/9).
- Spec "in-memory filter, no GSI/migration" → Task 6.
- Spec "chip beside contact name" → Task 8; "filter in popover, URL-persisted" →
  Task 9.
- Spec "display + filter only, no per-row action" → no retry/push task included.
- Value strings (`synced`/`sync_pending`/`update_pending`/`sync_failed`) are
  identical across backend (Tasks 1–6) and frontend (Tasks 7–9).
```
