# V3 Enrichment — Source Attribution: Test Scenarios

**What this covers:** the 7 fixes shipped in PR
[agentweb#1609](https://github.com/AgentWebPro/agentweb/pull/1609) (backend) and PR
[customer-portal#814](https://github.com/AgentWebPro/agentweb-customer-portal/pull/814)
(portal badge).

**How to use:** every scenario can be exercised **via the API** (curl / any HTTP client)
or **via Playwright** (the customer-portal UI). Run the Must scenarios first; Edge and
Good-to-have are deeper coverage. This file is self-contained — you can run it from a
fresh session.

---

## The 7 things under test

| Fix | What changed | Where to see it |
|-----|--------------|-----------------|
| 1 | Web-tier fills carry `provider:'llm_web_search'` + `sourceUrl` + `sourceQuote` | `enrichmentMetadata[field]` |
| 2 | Pattern-guessed emails → `provider:'pattern'`, `confidence:'medium'`, `sourceQuote:'pattern: …'` | `enrichmentMetadata.email` |
| 3 | Smart-field (`source:'llm'`) fills record the producing model in `provider` | `enrichmentMetadata[smartField]` |
| 5 | Critic verdict surfaced as `criticView` (`high`/`low`/`drop`) on web fields | `enrichmentMetadata[webField]` |
| 6 | Every enriched field carries a `confidence` (`high`/`medium`/`low`) | `enrichmentMetadata[field]` |
| 7 | Run id stamped as `enrichedJobId` on every persisted field | `enrichmentMetadata[field]` |
| 8 | Portal renders a critic-view badge on the enriched-value hover card | CRM page UI |

> **Not in scope (dropped):** Fix 4. The `existing_data` bucketing branch was deliberately
> kept — it is a live guard, not dead code. Edge case **E7** verifies it still works.

---

## Setup

### Environment & accounts
- **API base** — set `API_BASE` to your target:
  - Cloud test env: the EC2 URL from your `./test-env/test-env.sh` run.
  - Staging: `https://api-stage.agentweb.pro`
- **Portal base** (`PORTAL_BASE`) — the matching customer-portal URL (test env, or local `npm run dev` pointed at staging).
- **Test accounts** (from `CLAUDE.md`): admin `test@example.com` / `Test123!`; basic `test1@example.com` / `Test123!`.

### Get an auth token (API path)
```bash
API_BASE="https://api-stage.agentweb.pro"
TOKEN=$(curl -s -X POST "$API_BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"Test123!"}' | jq -r '.token')
echo "$TOKEN"
```

### Test data — a list with leads + a saved config
Enrichment in `mode=enrich` needs a **saved per-list config**; `mode=preview` takes an
inline config in the body instead.

1. Pick or create a CRM list and note its id as `LIST_ID`:
   ```bash
   curl -s "$API_BASE/api/crm/lists" -H "Authorization: Bearer $TOKEN" | jq '.[] | {listId, name}'
   ```
2. The list should contain a mix of leads that exercise each tier:
   - a lead with **company email + full name** (e.g. `jane.doe@acme.com`) → Apollo / web tiers
   - a lead with **only first/last name + email domain, no email** → pattern tier (Fix 2)
   - a lead with **sparse data** (name only) → identity-resolution failure path (E3)
3. Save an enrichment config covering several field types — standard Apollo fields, a
   web-only field, and at least one **smart field** (a field with a `smartCondition`):
   ```bash
   curl -s -X PUT "$API_BASE/api/crm/lists/$LIST_ID/enrichment-config" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"config":{"fields":[
       {"name":"company_name","type":"string","instruction":"company name","include":true,"overwritePolicy":"always_overwrite"},
       {"name":"funding_stage","type":"string","instruction":"latest funding stage","include":true,"overwritePolicy":"always_overwrite"},
       {"name":"company_description","type":"string","instruction":"one-line company description","include":true,"overwritePolicy":"always_overwrite"},
       {"name":"isEnterprise","type":"string","instruction":"is this an enterprise company","include":true,"overwritePolicy":"always_overwrite","smartCondition":"company has more than 1000 employees"}
     ],"globalOverwriteDefault":"always_overwrite","schemaVersion":1}}'
   ```

### The two API endpoints you will use most
```bash
# Run enrichment (synchronous — returns the run report incl. runId)
curl -s -X POST "$API_BASE/api/crm/lists/$LIST_ID/leads/enrich-v3?mode=enrich" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'

# Read leads back — each lead has an `enrichmentMetadata` map keyed by field name
curl -s "$API_BASE/api/crm/lists/$LIST_ID/leads" -H "Authorization: Bearer $TOKEN" \
  | jq '.leads[]? // .[] | {leadId, enrichmentMetadata}'
```

### Verification surfaces
- **API:** `GET /api/crm/lists/:listId/leads` (or `/leads/:leadId`) — the response is
  sanitized but keeps `source`, `provider`, `confidence`, `sourceUrl`, `sourceQuote`,
  `criticVerdict`, `criticView`, `enrichedJobId`. (Sibling-lineage ids are stripped.)
- **DynamoDB (deepest source of truth):** table `AW-Leads` (`Dev-AW-Leads` in dev),
  key `{listId, leadId}`, attribute `enrichmentMetadata`:
  ```bash
  aws dynamodb get-item --table-name AW-Leads \
    --key '{"listId":{"S":"'"$LIST_ID"'"},"leadId":{"S":"<LEAD_ID>"}}' \
    --query 'Item.enrichmentMetadata'
  ```
- **UI:** the CRM page → an enriched cell → hover shows the provenance card.

### Playwright (UI path) — login once
```
browser_navigate  {{PORTAL_BASE}}/login
browser_fill_form  email=test@example.com  password=Test123!
browser_click  "Sign in"
browser_navigate  {{PORTAL_BASE}}/crm        # open the CRM page, then the test list
```

---

## MUST scenarios

### M1 — Every enriched field carries source, confidence, and enrichedJobId
**Covers:** Fix 6, Fix 7 · **Priority:** Must
**Precondition:** list with ≥2 leads + saved config.
**API:**
1. `POST …/leads/enrich-v3?mode=enrich` → record `runId` from the response.
2. `GET …/leads` → for every lead, inspect each entry of `enrichmentMetadata`.
**Playwright:** open the list → click **Enrich** → wait for the run to finish.
**Expected:** for **every** field in every lead's `enrichmentMetadata`:
`source` is a non-empty string; `confidence` ∈ `{high, medium, low}`; `enrichedAt` is set;
`enrichedJobId` === the `runId` from step 1.
**Fail if:** any enriched field has `confidence` undefined, or `enrichedJobId` missing/mismatched.

### M2 — Web-sourced fields carry full provenance
**Covers:** Fix 1 · **Priority:** Must
**Precondition:** config includes a web-only field (e.g. `company_description`).
**API:** run enrich → `GET …/leads` → inspect `enrichmentMetadata.company_description`.
**Expected:** `source:'web_search'`, `provider:'llm_web_search'`, `confidence:'medium'`,
and `sourceUrl` and/or `sourceQuote` populated when the LLM returned them.
**Fail if:** a `web_search` field has `provider` missing, or `sourceUrl`/`sourceQuote`
never appear on any web field across the whole list.

### M3 — Web-sourced fields get a criticView
**Covers:** Fix 5 · **Priority:** Must
**API:** run enrich → inspect web fields' `enrichmentMetadata[field]`.
**Expected:** each web field that the critic evaluated has `criticVerdict` ∈
`{supported, partially-supported, unsupported, contradicted}` **and** a derived
`criticView` ∈ `{high, low, drop}` per the mapping: `supported→high`,
`unsupported`/`partially-supported→low`, `contradicted→drop`.
**Fail if:** a field has `criticVerdict` but no `criticView`, or the mapping is wrong.

### M4 — Apollo-sourced fields get registry-based confidence
**Covers:** Fix 6 · **Priority:** Must
**Precondition:** config includes `funding_stage` and a generic field.
**API:** run enrich → inspect `enrichmentMetadata.funding_stage`.
**Expected:** `source:'api'`, `provider:'apollo'`, and `confidence:'high'` for
`funding_stage` (registry-rated high). A generic/unlisted field resolves to `'medium'`.
**Fail if:** `funding_stage` comes back `'medium'` (would mean the registry lookup missed).

### M5 — Smart-field records the producing model
**Covers:** Fix 3 · **Priority:** Must
**Precondition:** config has a smart field (e.g. `isEnterprise` with a `smartCondition`).
**API:** run enrich → inspect `enrichmentMetadata.isEnterprise`.
**Expected:** `source:'llm'`, and `provider` set to a model name (a non-empty string).
`confidence:'medium'`. If the smart field produced a value, `provider` is present.
**Fail if:** `source:'llm'` field has no `provider`.

### M6 — Pattern-guessed email is correctly attributed
**Covers:** Fix 2 · **Priority:** Must
**Precondition:** a lead with `firstName` + `lastName` + `emailDomain` but **no email**,
such that the pattern tier resolves one.
**API:** run enrich → inspect `enrichmentMetadata.email` for that lead.
**Expected:** `source:'api'`, `provider:'pattern'` (NOT `'enrich.so'`),
`confidence:'medium'`, and `sourceQuote` starting with `pattern: `.
**Fail if:** a pattern-found email is labelled `provider:'enrich.so'`.

### M7 — One run id across all fields of a run
**Covers:** Fix 7 · **Priority:** Must
**API:** run enrich, note `runId` → `GET …/leads` → collect every `enrichedJobId`
across every field of every lead written in this run.
**Expected:** they are all identical and equal to `runId`. Run enrich again →
all `enrichedJobId` values change to the new `runId`.
**Fail if:** fields from the same run carry different `enrichedJobId`s.

### M8 — Portal shows the critic-view badge
**Covers:** Fix 8 · **Priority:** Must · **UI-only**
**Playwright:**
1. Login → CRM → open the enriched list.
2. `browser_snapshot`, locate an enriched **web-sourced** cell.
3. `browser_hover` over that cell → `browser_snapshot`.
**Expected:** the hover card shows a critic badge — "Critic: verified" (green) /
"Critic: questionable" (amber) / "Critic: recommends removal" (rose) — matching the
field's `criticView`. The cell value itself is still shown (never hidden).
**Fail if:** no badge appears for a field whose API metadata has a `criticView`.

### M9 — Preview mode does not persist
**Covers:** orchestrator safety · **Priority:** Must
**API:**
1. `GET …/leads` → snapshot current `enrichmentMetadata`.
2. `POST …/leads/enrich-v3?mode=preview` with `{"inlineConfig": <a config>}` in the body.
3. `GET …/leads` again.
**Expected:** the preview call returns a run report with `previewSamples`, but the
re-fetched leads' `enrichmentMetadata` is **unchanged** — nothing was written.
**Fail if:** preview mutated stored metadata.

---

## EDGE cases

### E1 — Re-run refreshes enrichedJobId
**Covers:** Fix 7 · run enrich twice. **Expected:** the 2nd run's fields carry the 2nd
`runId`; `always_overwrite` fields are rewritten, `enrichedAt` advances.

### E2 — fill_if_empty does not overwrite a populated field
Add a field with `overwritePolicy:'fill_if_empty'` whose lead value is already set.
Run enrich. **Expected:** that field's value and metadata are unchanged (no spurious write).

### E3 — Unresolvable lead does not crash the run
Include a lead with only a name (no email, no domain). Run enrich.
**Expected:** the run completes; the report's `failed` counters / `processed` reflect it;
other leads still enriched; HTTP 200.

### E4 — Contradicted value is flagged, NOT deleted
**Covers:** Fix 5 non-destructive guarantee. Find (or induce) a web field the critic marks
`contradicted`. **Expected:** the field's **value is still present** in the lead and in
`enrichmentMetadata`; `criticVerdict:'contradicted'`, `criticView:'drop'`. The system
never auto-removes it — `drop` is advisory only.

### E5 — Empty list / no-match leadIds filter
`POST …/enrich-v3` on an empty list, and with `{"leadIds":["does-not-exist"]}`.
**Expected:** HTTP 200, report shows `processed: 0`, no error, no `setLeadFields` write.

### E6 — Web LLM returns a bare string (provenance unavailable)
If a web-tier extraction returns a plain string instead of the `{value,sourceUrl,…}`
object, the field is **still filled** with `provider:'llm_web_search'` but no
`sourceUrl`/`sourceQuote`, and the backend logs
`[v3 deps] web-tier LLM returned bare string for field "<f>" — provenance unavailable`.
**Verify:** check backend logs after a run; a web field with a value but no `sourceUrl`
is acceptable (graceful degradation), not a failure.

### E7 — V2-enriched lead re-run through V3 (existing_data guard)
**Covers:** the deliberately-kept Fix-4 guard. Use a lead whose `enrichmentMetadata`
already contains an entry with `source:'existing_data'` (i.e. previously v2-enriched).
Run V3 enrich. **Expected:** no crash; the run completes; the `existing_data`-sourced
Tier-1 value is handled by the bucketing guard (not re-bucketed). HTTP 200.

### E8 — Large list is fully enriched (pagination)
Run enrich on a list with enough leads to exceed one DynamoDB query page (>~1MB of lead
items). **Expected:** the run report's `processed` equals the full lead count — no silent
truncation after the first page.

### E9 — Aliased / custom-named field metadata keying
Config a field with `aliasFor` pointing at a canonical field, plus a custom-named field.
Run enrich. **Expected:** `enrichmentMetadata` has an entry keyed by **each user-facing
field name**; standard columns land in top-level lead attrs, custom names in `customFields`.

### E10 — Provider confidence differs per field
For an identity-resolved lead, compare `enrichmentMetadata.email` / `firstName` vs
`company` / `title`. **Expected:** identity fields (`firstName`, `lastName`, `email`,
`linkedin`) are `confidence:'high'`; current-state fields (`company`, `title`, `phone`)
are `'medium'` — i.e. confidence is genuinely per-field, not a flat value.

---

## GOOD-TO-HAVE scenarios

### G1 — criticView mapping is exhaustive
Across enough web fields, observe each verdict at least once and confirm:
`supported→high`, `unsupported→low`, `partially-supported→low`, `contradicted→drop`.

### G2 — Tier 3 confidence is one notch below Tier 2
Compare a field filled by Apollo deterministic direct-map (Tier 2) vs one extracted by
the LLM from Apollo raw JSON (Tier 3). **Expected:** the Tier-3 field's `confidence` is
one level lower than the registry value (`high→medium`, `medium→low`).

### G3 — Confidence registry spot-checks
`funding_stage` / `total_funding` / `last_funding_date` / `founded_year` → `'high'`;
`revenue_range` / `valuation` → `'low'`; an unlisted field → `'medium'`.

### G4 — Portal badge colour mapping (Playwright)
Hover fields with `criticView` `high` / `low` / `drop` → badge colours are
emerald / amber / rose respectively, with the expected icon.

### G5 — runId correlation
The `runId` in the `enrich-v3` API response matches the `enrichedJobId` written to DDB
and the `runId=` lines in the backend logs for that run.

### G6 — Async Apollo webhook email — documented limitation
If a lead's email is resolved by the **async Apollo broker webhook** (not the synchronous
run), its `enrichmentMetadata.email` will carry `apolloRequestId` but **no `enrichedJobId`**.
This is expected (documented limitation), not a bug.

### G7 — Sanitizer: provenance reaches the client, lineage is stripped
In the `GET …/leads` response, confirm `provider`, `confidence`, `sourceUrl`,
`sourceQuote`, `criticView`, `enrichedJobId` are present, while `siblingLeadId` /
`siblingListId` / `siblingUserId` are absent, and any `source:'crm-history'` is shown
as `'agentweb'`.

### G8 — Basic vs admin session
Run the same checks logged in as the basic account (`test1@example.com`). Confirm
enrichment behaves correctly; note any provenance fields that are admin-only in the UI.

---

## Quick result log (fill in while testing)

| ID | Pass/Fail | Notes |
|----|-----------|-------|
| M1 | | |
| M2 | | |
| M3 | | |
| M4 | | |
| M5 | | |
| M6 | | |
| M7 | | |
| M8 | | |
| M9 | | |
| E1–E10 | | |
| G1–G8 | | |
