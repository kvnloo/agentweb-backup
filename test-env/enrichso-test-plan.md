# enrich.so Integration — End-to-End Test Plan

Test env: `54.203.132.155` (vendor-argusoft-access-agentweb)
- Backend: `http://54.203.132.155:3001`
- Customer portal: `http://54.203.132.155:5174`

Account: `test@example.com / Test123!`

---

## Module-grouped tests (per page, all related features in one visit)

### Module A — Add Lead dialog (Quick Lookup by email)
**Page:** Customer portal → CRM → pick or create a list → "Add Lead"
1. **Open dialog** — verify Email input + new "Lookup" button present
2. **Edge: empty email** — Lookup button disabled
3. **Edge: invalid format** — paste `notanemail` → click Lookup → expect 400 toast "invalid email format"
4. **Edge: too-long email (>254 chars)** — pasted long string → 400
5. **Happy: known email** — paste a real LinkedIn-indexed email → fields auto-fill (firstName, lastName, company, title, linkedin)
6. **Edge: not-found email** — paste `nobody-xyz@nowhere-zzz.com` → "no profile found" toast, fields untouched
7. **Save lead** — click Save, lead appears in list

### Module B — Lead Detail Panel (validation pill + revalidate)
**Page:** Customer portal → CRM → click a lead with email
1. **Lead with no validation yet** — pill area shows "Validate" button (no pill)
2. **Click Validate** — busy spinner → pill appears (deliverable/risky/undeliverable color)
3. **Background validation on new lead** — after Module A save, wait ~3s, refresh — pill should appear automatically
4. **Edge: lead with no email** — pill hidden entirely
5. **Click Revalidate (refresh icon)** — re-runs, pill updates with `forceRefresh: true`
6. **Tooltip on pill** — hover shows status, confidence, provider, checkedAt

### Module C — Bulk CSV Import (opt-in validation)
**Page:** Customer portal → CRM → list → ⋮ menu → "Import CSV"
1. **Dialog opens with file input + opt-in checkbox** — "Validate emails on import"
2. **Edge: import WITHOUT checkbox** — small CSV (3 rows) imports, toast shows "Successfully imported 3 leads" (no validation queue mention)
3. **Edge: import WITH checkbox** — same CSV + checkbox → toast shows "Successfully imported 3 leads — validating 3 emails via enrich.so in background"
4. **Verify background validation** — wait ~10s, open one of the imported leads → email_validation pill should appear

### Module D — Group Email Composer (deliverability gate)
**Page:** Customer portal → CRM → list → ⋮ menu → "Group Email"
1. **Preview displays buckets** — modal shows "Will send to N of M leads (X unsubscribed) (Y no email)" — and if applicable: `(Z undeliverable — blocked)` (red), `(W risky — will warn)` (amber)
2. **Edge: list with no validation** — preview shows zero undeliverable/risky (graceful)
3. **Risky confirm** — fill content → click Prepare → Send → if any risky exist, browser confirm fires "N recipients flagged as RISKY" → Cancel → no send
4. **Risky confirm — accept** → send proceeds
5. **Undeliverable block** — undeliverable count > 0 → primary Send button still works (skips them); result toast shows "N undeliverable address(es) skipped"
6. **Admin override button** — when undeliverableCount > 0, "Send incl. undeliverable" appears (destructive style) → clicks browser confirm → sends including bad addresses

### Module E — Backend abuse gates (API smoke via curl/UI)
1. **Lookup-by-email format check** — POST `/api/crm/leads/lookup-by-email` with `{"email":"notanemail"}` → 400
2. **Lookup-by-email empty** — POST with `{}` → 400
3. **Lookup-by-email quota** — burn 50 lookups via the Quick Add UI → 51st returns 429 with `scope: "lookup-by-email"`
4. **Validate-email no email on lead** — call `/lists/:listId/leads/:leadId/validate-email` for a lead with empty email → 400
5. **Cross-user isolation** — log in as `test1@example.com` (Basic) → can only validate leads in own lists (existing access check)

### Module F — Cache + service health (observable via repeat actions)
1. **Cache hit** — call validate-email twice on same lead. First call: ~500ms latency. Second call (within 30d): instant via cache (`fromCache: true` in network response).
2. **Force refresh** — Revalidate button always uses `forceRefresh: true` → bypasses cache → fresh API call
3. **Service unavailable** — if API key missing/invalid, validate-email returns 500 with clear error. Lead create still succeeds; Group Email still sends (no validation = no block).

### Module G — Backend boot verification
1. SSH into test env
2. `docker logs test-env-backend-1 | grep -E "enrich.so|specialist"`
3. Expected: either "enrich.so service initialized" + "Enrichment specialists registered", OR "enrich.so service not initialized — ..." (graceful warn) + specialists still registered

---

## Edge cases covered

| Scenario | Module | Expected |
|---|---|---|
| Empty email | A.2, E.2 | 400 / disabled button |
| Invalid format | A.3, E.1 | 400 "invalid email format" |
| Email too long (>254) | A.4 | 400 |
| Email not found | A.6 | `found: false`, no field overwrite |
| Lead with no email | B.4 | Pill + revalidate hidden |
| List with no validation data | D.2 | Buckets show 0, send works normally |
| Risky recipients in send | D.3, D.4 | Browser confirm; cancel blocks; accept proceeds |
| Undeliverable in send | D.5 | Skipped silently with count in toast |
| Admin override on undeliverable | D.6 | Override button → second confirm → sends |
| Quota exceeded | E.3 | 429 with limit + scope |
| Cross-user list access | E.5 | 403 |
| API down / no key | F.3 | 500 on revalidate route; lead create continues; sends continue |
| Cache hit | F.1 | Faster response, fromCache: true |
| Force refresh | F.2 | Always fresh API call |
| Concurrent customField edit during validation | (M4 fix) | User edit preserved (DDB document-path SET) |

---

## Test execution order (optimized for browser flow)

1. **Module G** (boot check via docker logs — non-interactive)
2. **Module A** (single lead via Add Lead — sets up data for later)
3. **Module B** (validate the just-created lead)
4. **Module C** (CSV import with opt-in)
5. **Module D** (group email — uses leads from A/C)
6. **Module E** (abuse via curl — fast smoke after UI flows)
7. **Module F** (cache observation — sneak in during other modules via Network tab)
