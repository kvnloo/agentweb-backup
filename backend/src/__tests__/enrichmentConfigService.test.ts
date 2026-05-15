// Tests for enrichmentConfigService — config CRUD + LLM type-suggest.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §4.1 + §8.5.
// Validates: GET returns default for empty lists, PUT enforces uniqueness +
// reserved-name + enum-option rules, suggest-types passes through.

import {
  getEnrichmentConfig,
  setEnrichmentConfig,
  suggestFieldTypes,
  RESERVED_FIELD_NAMES,
  type ConfigServiceDeps,
} from '../services/enrichmentConfigService';
import type { EnrichmentConfig } from '../services/crmEnrichmentServiceV3';

const LIST_ID = 'list-1';
const USER_ID = 'user-1';

function validConfig(overrides: Partial<EnrichmentConfig> = {}): EnrichmentConfig {
  return {
    fields: [
      { name: 'industry', type: 'string', instruction: 'industry of the company', include: true, overwritePolicy: 'fill_if_empty' },
    ],
    globalOverwriteDefault: 'fill_if_empty',
    schemaVersion: 1,
    updatedAt: '2026-05-11T00:00:00Z',
    updatedBy: USER_ID,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ConfigServiceDeps> = {}): ConfigServiceDeps {
  return {
    readListConfig: jest.fn().mockResolvedValue(null),
    writeListConfig: jest.fn().mockResolvedValue(undefined),
    loadListFieldNames: jest.fn().mockResolvedValue([]),
    llmSuggestTypes: jest.fn().mockResolvedValue([]),
    llmInferAliases: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

// ─── getEnrichmentConfig ──────────────────────────────────────────────────────

describe('getEnrichmentConfig', () => {
  it('returns knownColumns = standard columns + list schema (minus excluded/reserved)', async () => {
    // knownColumns is the set of field names that will auto-resurface on next
    // dialog open. Frontend uses it to hide the trash icon for these rows —
    // delete is meaningful only for manually-added saved-only fields.
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),
      loadListFieldNames: jest.fn().mockResolvedValue([
        'industry', 'tech_stack',
        'leadId', 'enrichmentMetadata',         // truly reserved → filtered
      ]),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    expect(result.knownColumns).toEqual(expect.arrayContaining([
      'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes',  // standard
      'industry', 'tech_stack',                                                              // list custom
    ]));
    expect(result.knownColumns).not.toContain('leadId');
    expect(result.knownColumns).not.toContain('enrichmentMetadata');
  });

  it('knownColumns excludes manually-added saved-only fields', async () => {
    // A saved config with a manual `stag` field (not in list.fieldNames, not
    // standard). knownColumns must NOT include it — that's how the frontend
    // knows the trash icon should appear for this row.
    const stored = validConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: 'funding stage', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(stored),
      loadListFieldNames: jest.fn().mockResolvedValue(['industry']),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    expect(result.knownColumns).toContain('industry');
    expect(result.knownColumns).not.toContain('stag');
  });

  it('returns the stored config merged with standard candidates when one exists', async () => {
    // After merge, the result includes saved fields PLUS the standard
    // candidate fields the saved config might not have explicitly listed.
    // Saved settings are preserved for saved fields.
    const stored = validConfig();   // one field: industry with include=true
    const deps = makeDeps({ readListConfig: jest.fn().mockResolvedValue(stored) });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);

    expect(result.isDefault).toBe(false);
    // Saved `industry` retains its custom settings
    const industry = result.config.fields.find(f => f.name === 'industry')!;
    expect(industry.include).toBe(true);
    expect(industry.instruction).toBe('industry of the company');
    // Standard candidates added (8 standard fields + saved 'industry' = 9)
    const names = result.config.fields.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining([
      'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes', 'industry',
    ]));
  });

  it('returns a default config with isDefault: true when none stored, including standard + custom list fields', async () => {
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),
      loadListFieldNames: jest.fn().mockResolvedValue(['industry', 'tech_stack']),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);

    expect(result.isDefault).toBe(true);
    // 8 standard enrichable fields + 2 custom
    expect(result.config.fields.map(f => f.name).sort()).toEqual([
      'company', 'email', 'firstName', 'industry', 'lastName', 'linkedin', 'notes', 'phone', 'tech_stack', 'title',
    ]);
    // Default: include=true (opt-out), overwrite=fill_if_empty (safe)
    expect(result.config.fields.every(f => f.include === true)).toBe(true);
    expect(result.config.fields.every(f => f.overwritePolicy === 'fill_if_empty')).toBe(true);
    expect(result.config.globalOverwriteDefault).toBe('fill_if_empty');
    expect(result.config.schemaVersion).toBe(1);
    expect(result.config.updatedBy).toBe(USER_ID);
  });

  it('keeps standard data columns AND filters truly-reserved system columns from defaults', async () => {
    // Standard columns (firstName/email/etc.) are enrichable via Apollo — they
    // appear in the default config with aliasFor pre-set. Truly reserved
    // columns (leadId, enrichmentMetadata, ...) are filtered out entirely.
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),
      loadListFieldNames: jest.fn().mockResolvedValue([
        'firstName', 'lastName', 'email', 'company', 'linkedin', 'phone',
        'leadId', 'enrichmentMetadata',     // truly reserved — filtered
        'industry', 'employee_count',       // custom — kept without alias
      ]),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    const fields = result.config.fields;
    const names = fields.map(f => f.name).sort();

    expect(names).toEqual(['company', 'email', 'employee_count', 'firstName', 'industry', 'lastName', 'linkedin', 'notes', 'phone', 'title']);

    // Standard data columns get auto-mapped aliasFor → canonical FIELD_GROUPS name
    const byName = Object.fromEntries(fields.map(f => [f.name, f]));
    expect(byName.firstName.aliasFor).toBe('first_name');
    expect(byName.lastName.aliasFor).toBe('last_name');
    expect(byName.linkedin.aliasFor).toBe('linkedin_url');
    expect(byName.company.aliasFor).toBe('company_name');
    expect(byName.email.aliasFor).toBe('email');
    // Custom fields don't get an aliasFor — user assigns one if applicable.
    expect(byName.industry.aliasFor).toBeUndefined();
    expect(byName.employee_count.aliasFor).toBeUndefined();

    // Default is saveable round-trip — alias-mapped standard names pass validation.
    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config: result.config }, deps),
    ).resolves.toBeDefined();
  });

  it('always includes the standard enrichable lead columns even when list.fieldNames lacks them', async () => {
    // list.fieldNames may only contain custom fields — the dialog still needs
    // to show standard columns (company, phone, etc.) so users can opt them in.
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),
      loadListFieldNames: jest.fn().mockResolvedValue([]),   // empty list schema
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    const names = result.config.fields.map(f => f.name);

    // The 8 standard enrichable columns always present
    expect(names).toEqual(
      expect.arrayContaining(['firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes'])
    );
  });

  it('merges saved config with current list fields (saved settings preserved, new fields appended)', async () => {
    // Scenario: previously saved config had only `title` toggled on with custom
    // settings. The list now has additional fields (location custom field). The
    // merged config preserves `title`'s saved state and shows the rest.
    const saved: any = {
      fields: [
        { name: 'title', type: 'string', instruction: 'job title', include: true, overwritePolicy: 'always_overwrite' },
        { name: 'stag', type: 'string', instruction: 'funding stage', include: true, overwritePolicy: 'fill_if_empty' },
      ],
      globalOverwriteDefault: 'fill_if_empty',
      schemaVersion: 1,
      updatedAt: '2026-05-11T00:00:00Z',
      updatedBy: USER_ID,
    };
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(saved),
      loadListFieldNames: jest.fn().mockResolvedValue(['location', 'firstName']),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    const byName = Object.fromEntries(result.config.fields.map(f => [f.name, f]));

    // Standard fields all surface (firstName + standard built-ins like company/phone/etc.)
    expect(byName.firstName).toBeDefined();
    expect(byName.company).toBeDefined();
    expect(byName.phone).toBeDefined();

    // Custom list field also surfaces
    expect(byName.location).toBeDefined();
    expect(byName.location.include).toBe(true);  // not in saved → default (opt-out)

    // Saved entry's settings preserved
    expect(byName.title.instruction).toBe('job title');
    expect(byName.title.include).toBe(true);
    expect(byName.title.overwritePolicy).toBe('always_overwrite');

    // Saved manual-add (stag) preserved even though not in current candidates
    expect(byName.stag).toBeDefined();
    expect(byName.stag.include).toBe(true);

    // isDefault is false — there IS a saved config
    expect(result.isDefault).toBe(false);
  });

  it("excludes internal/system fields (enrichmentMetadata, status, dealValue) from candidates", async () => {
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),
      loadListFieldNames: jest.fn().mockResolvedValue([
        'enrichmentMetadata', 'syncMetadata', 'status', 'dealValue', 'dealCurrency',
        'createdAt', 'updatedAt', 'industry',   // industry is a normal custom field, keep
      ]),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    const names = result.config.fields.map(f => f.name);

    expect(names).not.toContain('enrichmentMetadata');
    expect(names).not.toContain('syncMetadata');
    expect(names).not.toContain('status');
    expect(names).not.toContain('dealValue');
    expect(names).not.toContain('dealCurrency');
    expect(names).not.toContain('createdAt');
    expect(names).not.toContain('updatedAt');
    expect(names).toContain('industry');
  });

  it('excludes contactStatus* lifecycle columns from candidates (CRM pipeline state, not enrichable)', async () => {
    // contactStatus tracks pipeline lifecycle (inbox/working/paying) and audit
    // sidecars (note/reason/updatedAt/updatedBy). Showing these in the
    // enrichment dialog is noise — the user can't usefully enrich them.
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),
      loadListFieldNames: jest.fn().mockResolvedValue([
        'contactStatus', 'contactStatusNote', 'contactStatusReason',
        'contactStatusUpdatedAt', 'contactStatusUpdatedBy',
        'industry',     // normal custom field — must still surface
      ]),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    const names = result.config.fields.map(f => f.name);

    expect(names).not.toContain('contactStatus');
    expect(names).not.toContain('contactStatusNote');
    expect(names).not.toContain('contactStatusReason');
    expect(names).not.toContain('contactStatusUpdatedAt');
    expect(names).not.toContain('contactStatusUpdatedBy');
    expect(names).toContain('industry');
  });

  it('drops previously-saved contactStatus* fields from a re-read merge (cleanup of stale defaults)', async () => {
    // Older default-config generator pre-selected lifecycle columns. Now that
    // we exclude them from candidates, they must also be pruned from saved
    // entries on read — otherwise they'd resurface as "manually added" and
    // jump to the top of the dialog.
    const saved: any = {
      fields: [
        { name: 'firstName',              type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'first_name' },
        { name: 'contactStatus',          type: 'string', instruction: '', include: false, overwritePolicy: 'fill_if_empty' },
        { name: 'contactStatusNote',      type: 'string', instruction: '', include: false, overwritePolicy: 'fill_if_empty' },
        { name: 'contactStatusUpdatedAt', type: 'string', instruction: '', include: false, overwritePolicy: 'fill_if_empty' },
        { name: 'Description',            type: 'string', instruction: 'Company description', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'company_description' },
      ],
      globalOverwriteDefault: 'fill_if_empty',
      schemaVersion: 1,
      updatedAt: '2026-05-11T00:00:00Z',
      updatedBy: USER_ID,
    };
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(saved),
      loadListFieldNames: jest.fn().mockResolvedValue(['contactStatus', 'contactStatusNote', 'contactStatusUpdatedAt']),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    const names = result.config.fields.map(f => f.name);

    expect(names).not.toContain('contactStatus');
    expect(names).not.toContain('contactStatusNote');
    expect(names).not.toContain('contactStatusUpdatedAt');
    // Description (genuine manual add) still surfaces, at the top
    expect(names[0]).toBe('Description');
  });

  it('surfaces user-added saved-only fields at the TOP of the merged list (visibility for recent adds)', async () => {
    // When a user adds a custom field via the dialog (not in list.fieldNames),
    // it should appear at the top — most recently added, most likely to be
    // looked at. Otherwise it gets buried after 8 standard + N list-custom
    // fields and users think it vanished.
    const saved: any = {
      fields: [
        // saved order matches what the user last saved — standard fields
        // (default-built first), then their manual add at the end
        { name: 'firstName', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'first_name' },
        { name: 'email',     type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
        { name: 'Description', type: 'string', instruction: 'Company description', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'company_description' },
      ],
      globalOverwriteDefault: 'fill_if_empty',
      schemaVersion: 1,
      updatedAt: '2026-05-11T00:00:00Z',
      updatedBy: USER_ID,
    };
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(saved),
      loadListFieldNames: jest.fn().mockResolvedValue([]),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);
    const names = result.config.fields.map(f => f.name);

    // Description is saved-only (not in candidates) — must be first
    expect(names[0]).toBe('Description');
    // Standard candidates follow
    expect(names).toContain('firstName');
    expect(names).toContain('email');
  });

  it('returns the standard 8 fields when the list has no custom field schema', async () => {
    // Previously this test expected an empty fields array. After the merge
    // change, standard enrichable lead columns are always surfaced.
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),
      loadListFieldNames: jest.fn().mockResolvedValue([]),
    });

    const result = await getEnrichmentConfig({ listId: LIST_ID, userId: USER_ID }, deps);

    expect(result.isDefault).toBe(true);
    expect(result.config.fields).toHaveLength(8);
    expect(result.config.fields.map(f => f.name).sort()).toEqual([
      'company', 'email', 'firstName', 'lastName', 'linkedin', 'notes', 'phone', 'title',
    ]);
  });
});

// ─── setEnrichmentConfig — happy path ─────────────────────────────────────────

describe('setEnrichmentConfig — happy path', () => {
  it('persists a valid config and returns it', async () => {
    const deps = makeDeps();
    const result = await setEnrichmentConfig(
      { listId: LIST_ID, userId: USER_ID, config: validConfig() },
      deps,
    );

    expect(deps.writeListConfig).toHaveBeenCalledTimes(1);
    const writeCall = (deps.writeListConfig as jest.Mock).mock.calls[0];
    expect(writeCall[0]).toBe(LIST_ID);
    expect(writeCall[1].fields).toHaveLength(1);
    expect(result.config.fields[0]?.name).toBe('industry');
    expect(result.warnings).toEqual([]);
  });

  it('stamps updatedAt and updatedBy at write time, overwriting client-provided values', async () => {
    const before = Date.now();
    const deps = makeDeps();
    const result = await setEnrichmentConfig(
      {
        listId: LIST_ID,
        userId: USER_ID,
        config: validConfig({
          updatedAt: '1999-01-01T00:00:00Z',  // bogus stale value the client tried to send
          updatedBy: 'somebody-else',          // user trying to spoof
        }),
      },
      deps,
    );

    expect(result.config.updatedBy).toBe(USER_ID);
    expect(new Date(result.config.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ─── setEnrichmentConfig — validation failures ────────────────────────────────

describe('setEnrichmentConfig — validation', () => {
  it('rejects when a field name is duplicated', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).rejects.toThrow(/'industry'.*already/i);
    expect(deps.writeListConfig).not.toHaveBeenCalled();
  });

  it('rejects truly-reserved system column names outright (no alias exception)', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'leadId', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).rejects.toThrow(/leadId.*reserved|reserved.*leadId/i);
    expect(deps.writeListConfig).not.toHaveBeenCalled();
  });

  it('accepts a standard data column like "email" as a field name (no longer reserved)', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'email', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
      ],
    });

    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).resolves.toBeDefined();
  });

  it('rejects when an enum-typed field has no enumOptions', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'tier', type: 'enum', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).rejects.toThrow(/enum.*tier.*enumOptions/i);
  });

  it('rejects when an enum-typed field has empty enumOptions array', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'tier', type: 'enum', enumOptions: [], instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).rejects.toThrow(/enum.*tier.*enumOptions/i);
  });

  it('auto-infers aliasFor at save time for camelCase standard names (server-side, no UI)', async () => {
    // User saves a config with a `firstName` field but no explicit aliasFor.
    // Server should infer aliasFor='first_name' so the orchestrator routes
    // through Apollo person_identity automatically.
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'firstName', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBe('first_name');
  });

  it('auto-infers aliasFor via camelCase → snake_case conversion for canonical-shaped names', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'companyLinkedinUrl', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBe('company_linkedin_url');
  });

  it('does NOT auto-infer aliasFor when the field name is already canonical', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'tech_stack', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBeUndefined();
  });

  it('auto-infers aliasFor via synonym map (funding_round → funding_stage)', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'funding_round', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBe('funding_stage');
  });

  it('auto-infers aliasFor via synonym map for "tech" → tech_stack', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'tech', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBe('tech_stack');
  });

  it('falls back to LLM for opaque names where the heuristic returned undefined', async () => {
    // Heuristic doesn't know 'stag' = funding_stage. LLM gets the question
    // (with instruction context) and maps it. Only the opaque field hits LLM.
    const llmMock = jest.fn().mockResolvedValue({ stag: 'funding_stage' });
    const deps = makeDeps({ llmInferAliases: llmMock });
    const config = validConfig({
      fields: [
        { name: 'firstName', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty' },
        { name: 'stag', type: 'string', instruction: 'company funding stage',
          include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    // LLM only called for fields the heuristic couldn't resolve
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(llmMock.mock.calls[0][0]).toEqual([
      { name: 'stag', instruction: 'company funding stage' },
    ]);

    const byName = Object.fromEntries(saved.config.fields.map(f => [f.name, f]));
    expect(byName.firstName.aliasFor).toBe('first_name');   // heuristic
    expect(byName.stag.aliasFor).toBe('funding_stage');      // LLM
  });

  it('ignores LLM suggestions that point to unknown canonical names', async () => {
    // Defense against hallucinated canonical names from the LLM.
    const deps = makeDeps({
      llmInferAliases: jest.fn().mockResolvedValue({
        stag: 'not_a_real_canonical_field',
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBeUndefined();
  });

  it('saves successfully if the LLM throws (heuristic results stand)', async () => {
    const deps = makeDeps({
      llmInferAliases: jest.fn().mockRejectedValue(new Error('LLM 503')),
    });
    const config = validConfig({
      fields: [
        { name: 'firstName', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty' },
        { name: 'stag', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    const byName = Object.fromEntries(saved.config.fields.map(f => [f.name, f]));
    expect(byName.firstName.aliasFor).toBe('first_name');   // heuristic still applied
    expect(byName.stag.aliasFor).toBeUndefined();            // LLM failed, no inference
  });

  it('skips LLM call entirely when heuristic resolved every field', async () => {
    const llmMock = jest.fn().mockResolvedValue({});
    const deps = makeDeps({ llmInferAliases: llmMock });
    const config = validConfig({
      fields: [
        { name: 'firstName', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'companyLinkedinUrl', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(llmMock).not.toHaveBeenCalled();
  });

  it('leaves opaque custom names without aliasFor (heuristic cannot guess)', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: 'funding stage', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBeUndefined();
    // Future: LLM fallback would set this to 'funding_stage'.
  });

  it('preserves explicit aliasFor passed by the client (heuristic never overrides)', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'funding_stage' },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields[0].aliasFor).toBe('funding_stage');
  });

  it("accepts a valid aliasFor pointing at a real FIELD_GROUPS field", async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: 'funding stage', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'funding_stage' },
      ],
    });
    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).resolves.toBeDefined();
  });

  it("rejects aliasFor that doesn't match any FIELD_GROUPS canonical field", async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'not_a_real_canonical_field' },
      ],
    });
    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).rejects.toThrow(/aliasFor.*not a known canonical field/i);
  });

  it('returns a warning (does not throw) when two fields map to the same canonical name', async () => {
    // Old CRM lists frequently have data in BOTH `company` and `company_name`
    // (or `email` + `Email`). We allow the collision and fan out fills to all
    // user-facing names, but surface a warning so the user knows both columns
    // will receive the same enriched value.
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'email', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
        { name: 'Email', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
      ],
    });
    const result = await setEnrichmentConfig(
      { listId: LIST_ID, userId: USER_ID, config },
      deps,
    );
    expect(result.config.fields).toHaveLength(2);
    // Backend emits just the duplicate-group descriptor; the frontend wraps it
    // with a shared "duplicate fields detected" header + explainer.
    expect(result.warnings).toEqual([`'email' and 'Email'`]);
  });

  it('returns a warning for the self-canonical + inferred-alias collision case', async () => {
    // `email` (self-canonical) + `Email` (aliasFor inferred → 'email')
    // both route to canonical 'email'. Warn, don't throw.
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'email', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'Email', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
      ],
    });
    const result = await setEnrichmentConfig(
      { listId: LIST_ID, userId: USER_ID, config },
      deps,
    );
    expect(result.warnings).toEqual([`'email' and 'Email'`]);
  });

  it('returns a warning for the standard-column + self-canonical case (company + company_name)', async () => {
    // The exact scenario from the screenshot: `company` is a STANDARD_DATA_ALIAS
    // pointing to canonical `company_name`, and `company_name` is itself
    // canonical. Old lists have data in both — allow the save with a warning.
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'company',      type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'company_name' },
        { name: 'company_name', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty' },
      ],
    });
    const result = await setEnrichmentConfig(
      { listId: LIST_ID, userId: USER_ID, config },
      deps,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings).toEqual([`'company' and 'company_name'`]);
  });

  it('returns one warning per canonical when three fields collide on the same canonical', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'email',  type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'Email',  type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
        { name: 'e_mail', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
      ],
    });
    const result = await setEnrichmentConfig(
      { listId: LIST_ID, userId: USER_ID, config },
      deps,
    );
    expect(result.warnings).toEqual([`'email', 'Email', and 'e_mail'`]);
  });

  it('returns no warnings when there are no canonical collisions', async () => {
    const deps = makeDeps();
    const config = validConfig({
      fields: [
        { name: 'email',   type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'company', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'company_name' },
      ],
    });
    const result = await setEnrichmentConfig(
      { listId: LIST_ID, userId: USER_ID, config },
      deps,
    );
    expect(result.warnings).toEqual([]);
  });

  it('rejects when schemaVersion is not 1', async () => {
    const deps = makeDeps();
    const config = validConfig({ schemaVersion: 2 as any });

    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).rejects.toThrow(/schemaVersion/i);
  });

  it('exports TRULY_RESERVED_NAMES with the expected system columns', async () => {
    // Sanity check — system/sidecar columns that never enter customFields
    expect(RESERVED_FIELD_NAMES).toEqual(
      expect.arrayContaining(['leadId', 'listId', 'enrichmentMetadata', 'customFields']),
    );
  });
});

// ─── suggestFieldTypes ────────────────────────────────────────────────────────

describe('suggestFieldTypes', () => {
  it('delegates to llmSuggestTypes and returns the result', async () => {
    const deps = makeDeps({
      llmSuggestTypes: jest.fn().mockResolvedValue([
        { name: 'stag', type: 'enum', enumOptions: ['Seed', 'A', 'B', 'C'] },
        { name: 'employees', type: 'number' },
      ]),
    });

    const result = await suggestFieldTypes(
      {
        fields: [
          { name: 'stag', instruction: 'funding stage of the company' },
          { name: 'employees', instruction: 'number of employees' },
        ],
      },
      deps,
    );

    expect(deps.llmSuggestTypes).toHaveBeenCalledWith([
      { name: 'stag', instruction: 'funding stage of the company' },
      { name: 'employees', instruction: 'number of employees' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.type).toBe('enum');
    expect(result[1]?.type).toBe('number');
  });

  it('returns empty result for empty input without calling the LLM', async () => {
    const deps = makeDeps();
    const result = await suggestFieldTypes({ fields: [] }, deps);

    expect(result).toEqual([]);
    expect(deps.llmSuggestTypes).not.toHaveBeenCalled();
  });
});
