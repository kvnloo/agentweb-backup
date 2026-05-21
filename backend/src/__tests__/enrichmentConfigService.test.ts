// Tests for enrichmentConfigService — config CRUD + LLM type-suggest.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §4.1 + §8.5.
// Validates: GET returns default for empty lists, PUT enforces uniqueness +
// reserved-name + enum-option rules, suggest-types passes through.

import {
  getEnrichmentConfig,
  setEnrichmentConfig,
  suggestFieldTypes,
  processEnrichmentConfig,
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
    llmClassifySmartFields: jest.fn().mockResolvedValue({}),
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

  it('never assigns aliasFor to emailDomain even when client sends one', async () => {
    // emailDomain is computed server-side from the email field. If it were aliased
    // to a canonical enrichment field, the waterfall would overwrite the computed
    // value with fetched data — incorrect behavior. This is the regression guard.
    const deps = makeDeps({
      llmInferAliases: jest.fn().mockResolvedValue({ emailDomain: 'email_domain' }),
    });
    const config = validConfig({
      fields: [
        { name: 'emailDomain', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email_domain' as any },
      ],
    });
    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields.find(f => f.name === 'emailDomain')?.aliasFor).toBeUndefined();
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

// ─── Smart field classification ───────────────────────────────────────────────

describe('setEnrichmentConfig — smart field classification', () => {
  it('calls llmClassifySmartFields for fields that have instructions', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({}),
    });
    const config = validConfig({
      fields: [
        { name: 'industry', type: 'string', instruction: 'company industry', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    expect(deps.llmClassifySmartFields).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'industry' })]),
    );
  });

  it('stores smartCondition and smartDependencies when LLM classifies a field as smart', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        isQualified: { isSmartField: true, dependencies: ['funding_stage', 'total_funding'] },
      }),
    });
    const config = validConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'true when series A or later and total funding > $1M',
          include: true,
          overwritePolicy: 'fill_if_empty',
        },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const qualField = saved.config.fields.find(f => f.name === 'isQualified');
    expect(qualField?.smartCondition).toBe('true when series A or later and total funding > $1M');
    expect(qualField?.smartDependencies).toEqual(['funding_stage', 'total_funding']);
  });

  it('does NOT tag a normal field as smart', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        industry: { isSmartField: false, dependencies: [] },
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'industry', type: 'string', instruction: 'company industry', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const field = saved.config.fields.find(f => f.name === 'industry');
    expect(field?.smartCondition).toBeUndefined();
    expect(field?.smartDependencies).toBeUndefined();
  });

  it('does NOT re-classify a field whose instruction matches existing smartCondition', async () => {
    // The stored DB config holds the cached smartCondition — client-supplied
    // classification keys are stripped and re-loaded from DB (concern #1 fix).
    const storedConfig = validConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'true when series A or later',
          include: true,
          overwritePolicy: 'fill_if_empty',
          smartCondition: 'true when series A or later',
          smartDependencies: ['funding_stage'],
        },
      ],
    });
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(storedConfig),
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({}),
    });
    const config = validConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'true when series A or later',  // same as stored smartCondition
          include: true,
          overwritePolicy: 'fill_if_empty',
          // client does NOT send smartCondition — server must read it from DB
        },
      ],
    });

    await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    // instruction == stored smartCondition → NOT in classification call
    const classifyCall = (deps.llmClassifySmartFields as jest.Mock).mock.calls[0]?.[0] ?? [];
    const names = classifyCall.map((f: any) => f.name);
    expect(names).not.toContain('isQualified');
  });

  it('re-classifies a smart field when its instruction changes', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        isQualified: { isSmartField: true, dependencies: ['employee_count'] },
      }),
    });
    const config = validConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'NEW condition: large company with > 500 employees',  // changed
          include: true,
          overwritePolicy: 'fill_if_empty',
          smartCondition: 'OLD condition: series A or later',  // stale
          smartDependencies: ['funding_stage'],
        },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    // Should be re-classified with new instruction and new deps
    const field = saved.config.fields.find(f => f.name === 'isQualified');
    expect(field?.smartCondition).toBe('NEW condition: large company with > 500 employees');
    expect(field?.smartDependencies).toEqual(['employee_count']);
  });

  it('clears smartCondition when user changes instruction to a plain fetch field', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        industry: { isSmartField: false, dependencies: [] },
      }),
    });
    const config = validConfig({
      fields: [
        {
          name: 'industry',
          type: 'string',
          instruction: 'company industry sector',  // changed to plain fetch
          include: true,
          overwritePolicy: 'fill_if_empty',
          smartCondition: 'old condition that was wrong',  // stale
          smartDependencies: ['employee_count'],
        },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const field = saved.config.fields.find(f => f.name === 'industry');
    expect(field?.smartCondition).toBeUndefined();
    expect(field?.smartDependencies).toBeUndefined();
  });

  it('proceeds with save when llmClassifySmartFields throws (fail-soft)', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockRejectedValue(new Error('LLM down')),
    });
    const config = validConfig();

    await expect(
      setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps),
    ).resolves.not.toThrow();
    expect(deps.writeListConfig).toHaveBeenCalled();
  });

  it('sets inferred fieldType from classification on all classified fields', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        isQualified: { isSmartField: true, dependencies: ['funding_stage'], fieldType: 'boolean' },
        companyScore: { isSmartField: true, dependencies: ['employee_count'], fieldType: 'number' },
        industry: { isSmartField: false, dependencies: [], fieldType: 'string' },
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'isQualified', type: 'string', instruction: 'true when series A', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'companyScore', type: 'string', instruction: '0-100 score based on size', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'industry', type: 'string', instruction: 'industry of the company', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    expect(saved.config.fields.find(f => f.name === 'isQualified')?.type).toBe('boolean');
    expect(saved.config.fields.find(f => f.name === 'companyScore')?.type).toBe('number');
    expect(saved.config.fields.find(f => f.name === 'industry')?.type).toBe('string');
  });

  it('sets date type for date fields', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        foundedYear: { isSmartField: false, dependencies: [], fieldType: 'date' },
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'foundedYear', type: 'string', instruction: 'year the company was founded', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields.find(f => f.name === 'foundedYear')?.type).toBe('date');
  });

  it('sets enum type and enumOptions for categorical fields', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        companyTier: { isSmartField: true, dependencies: ['employee_count', 'revenue_range'], fieldType: 'enum', enumOptions: ['A', 'B', 'C'] },
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'companyTier', type: 'string', instruction: 'tier A/B/C based on size and revenue', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    const field = saved.config.fields.find(f => f.name === 'companyTier');
    expect(field?.type).toBe('enum');
    expect(field?.enumOptions).toEqual(['A', 'B', 'C']);
  });

  it('skips enum type when LLM returns enum but no enumOptions', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        companyTier: { isSmartField: false, dependencies: [], fieldType: 'enum', enumOptions: [] },
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'companyTier', type: 'string', instruction: 'company tier', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    // enum with no options is useless — original type preserved
    expect(saved.config.fields.find(f => f.name === 'companyTier')?.type).toBe('string');
  });

  it('filters blank strings out of LLM-returned enumOptions', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        tier: { isSmartField: false, dependencies: [], fieldType: 'enum', enumOptions: ['A', '', 'B', '  '] },
      }),
    });
    const config = validConfig({
      fields: [{ name: 'tier', type: 'string', instruction: 'tier A or B', include: true, overwritePolicy: 'fill_if_empty' }],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    expect(saved.config.fields.find(f => f.name === 'tier')?.enumOptions).toEqual(['A', 'B']);
  });

  it('clears stale enumOptions when type changes away from enum', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        tier: { isSmartField: false, dependencies: [], fieldType: 'string' },
      }),
    });
    const config = validConfig({
      fields: [{ name: 'tier', type: 'enum', enumOptions: ['A', 'B', 'C'], instruction: 'company tier', include: true, overwritePolicy: 'fill_if_empty' }],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);
    const field = saved.config.fields.find(f => f.name === 'tier');
    expect(field?.type).toBe('string');
    expect(field?.enumOptions).toBeUndefined();
  });

  it('ignores invalid fieldType from LLM — keeps user-set type', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        isQualified: { isSmartField: true, dependencies: [], fieldType: 'invalid_type' },
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'isQualified', type: 'string', instruction: 'some condition', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    // Invalid type rejected → original type preserved
    expect(saved.config.fields.find(f => f.name === 'isQualified')?.type).toBe('string');
  });

  it('silently drops smartDependencies that are not valid canonical field names', async () => {
    const deps = makeDeps({
      writeListConfig: jest.fn().mockResolvedValue(undefined),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        isQualified: {
          isSmartField: true,
          dependencies: ['funding_stage', 'made_up_field_xyz'],  // second is invalid
        },
      }),
    });
    const config = validConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'some condition',
          include: true,
          overwritePolicy: 'fill_if_empty',
        },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const field = saved.config.fields.find(f => f.name === 'isQualified');
    expect(field?.smartDependencies).toEqual(['funding_stage']);
    expect(field?.smartDependencies).not.toContain('made_up_field_xyz');
  });

  it('ignores client-supplied notSmartInstruction — uses DB as source of truth', async () => {
    // Security: a malicious client could send notSmartInstruction === instruction
    // to permanently suppress LLM classification. Server must discard client values
    // and restore only from DB. With no stored config, field should be classified.
    const classifyMock = jest.fn().mockResolvedValue({
      industry: { isSmartField: false, dependencies: [] },
    });
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(null),  // no stored config
      llmClassifySmartFields: classifyMock,
    });
    const config = validConfig({
      fields: [
        {
          name: 'industry',
          type: 'string',
          instruction: 'company industry',
          include: true,
          overwritePolicy: 'fill_if_empty',
          notSmartInstruction: 'company industry',  // forged by client — must be ignored
        },
      ],
    });

    await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    // Field must appear in classification call despite client-supplied notSmartInstruction
    const classifyCall = classifyMock.mock.calls[0]?.[0] ?? [];
    expect(classifyCall.map((f: any) => f.name)).toContain('industry');
  });

  it('stores notSmartInstruction when LLM classifies a field as not smart', async () => {
    const deps = makeDeps({
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        industry: { isSmartField: false, dependencies: [] },
      }),
    });
    const config = validConfig({
      fields: [
        { name: 'industry', type: 'string', instruction: 'company industry', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const field = saved.config.fields.find(f => f.name === 'industry');
    expect(field?.notSmartInstruction).toBe('company industry');
    expect(field?.smartCondition).toBeUndefined();
  });

  it('skips re-classification when notSmartInstruction matches current instruction (cached not-smart)', async () => {
    // DB holds the cached notSmartInstruction — client classification keys are
    // stripped and restored from DB (concern #1 fix).
    const storedConfig = validConfig({
      fields: [
        {
          name: 'industry',
          type: 'string',
          instruction: 'company industry',
          include: true,
          overwritePolicy: 'fill_if_empty',
          notSmartInstruction: 'company industry',
        },
      ],
    });
    const classifyMock = jest.fn().mockResolvedValue({});
    const deps = makeDeps({
      readListConfig: jest.fn().mockResolvedValue(storedConfig),
      llmClassifySmartFields: classifyMock,
    });
    const config = validConfig({
      fields: [
        {
          name: 'industry',
          type: 'string',
          instruction: 'company industry',  // same as stored notSmartInstruction
          include: true,
          overwritePolicy: 'fill_if_empty',
          // client does NOT send notSmartInstruction — server reads from DB
        },
      ],
    });

    await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const classifyCall = classifyMock.mock.calls[0]?.[0] ?? [];
    expect(classifyCall.map((f: any) => f.name)).not.toContain('industry');
  });

  it('re-classifies a not-smart field when its instruction changes', async () => {
    const deps = makeDeps({
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        industry: { isSmartField: false, dependencies: [], fieldType: 'string' },
      }),
    });
    const config = validConfig({
      fields: [
        {
          name: 'industry',
          type: 'string',
          instruction: 'NEW: primary industry sector',  // changed
          include: true,
          overwritePolicy: 'fill_if_empty',
          notSmartInstruction: 'OLD: company industry',  // stale
        },
      ],
    });

    await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    expect(deps.llmClassifySmartFields).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'industry' })]),
    );
  });

  it('clears notSmartInstruction when field flips from not-smart to smart', async () => {
    const deps = makeDeps({
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        score: { isSmartField: true, dependencies: ['employee_count'], fieldType: 'number' },
      }),
    });
    const config = validConfig({
      fields: [
        {
          name: 'score',
          type: 'number',
          instruction: '1-100 score based on employee count',
          include: true,
          overwritePolicy: 'fill_if_empty',
          notSmartInstruction: 'OLD: plain score field',  // stale from previous not-smart run
        },
      ],
    });

    const saved = await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const field = saved.config.fields.find(f => f.name === 'score');
    expect(field?.smartCondition).toBe('1-100 score based on employee count');
    expect(field?.notSmartInstruction).toBeUndefined();
  });

  it('skips classification for include:false fields', async () => {
    const classifyMock = jest.fn().mockResolvedValue({});
    const deps = makeDeps({ llmClassifySmartFields: classifyMock });
    const config = validConfig({
      fields: [
        { name: 'industry', type: 'string', instruction: 'company industry', include: false, overwritePolicy: 'fill_if_empty' },
        { name: 'company', type: 'string', instruction: 'company name', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'company_name' },
      ],
    });

    await setEnrichmentConfig({ listId: LIST_ID, userId: USER_ID, config }, deps);

    const classifyCall = classifyMock.mock.calls[0]?.[0] ?? [];
    const names = classifyCall.map((f: any) => f.name);
    expect(names).not.toContain('industry');   // include:false — skipped
    expect(names).toContain('company');         // include:true — classified
  });
});

// ─── processEnrichmentConfig ──────────────────────────────────────────────────

describe('processEnrichmentConfig', () => {
  it('resolves heuristic aliases without writing to the DB', async () => {
    const deps = makeDeps();
    const { config } = await processEnrichmentConfig(
      {
        listId: 'list-1',
        userId: 'user-1',
        config: {
          fields: [
            { name: 'fundingRound', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
          ],
          globalOverwriteDefault: 'fill_if_empty',
          schemaVersion: 1,
          updatedAt: '2020-01-01T00:00:00.000Z',
          updatedBy: 'old',
        },
      },
      deps,
    );
    expect(config.fields[0].aliasFor).toBe('funding_stage');
    expect(config.updatedBy).toBe('user-1');
    expect(deps.writeListConfig).not.toHaveBeenCalled();
  });

  it('throws ConfigValidationError on a duplicate field name', async () => {
    const deps = makeDeps();
    await expect(
      processEnrichmentConfig(
        {
          listId: 'list-1',
          userId: 'user-1',
          config: {
            fields: [
              { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
              { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
            ],
            globalOverwriteDefault: 'fill_if_empty',
            schemaVersion: 1,
            updatedAt: '2020-01-01T00:00:00.000Z',
            updatedBy: 'old',
          },
        },
        deps,
      ),
    ).rejects.toThrow(/already in the list/);
  });

  it('survives an llmInferAliases failure (soft-fail branch)', async () => {
    const deps = makeDeps();
    deps.llmInferAliases = jest.fn().mockRejectedValue(new Error('llm down'));
    const { config } = await processEnrichmentConfig(
      {
        listId: 'list-1',
        userId: 'user-1',
        config: {
          fields: [
            { name: 'opaque_xyz', type: 'string', instruction: 'something custom', include: true, overwritePolicy: 'fill_if_empty' },
          ],
          globalOverwriteDefault: 'fill_if_empty',
          schemaVersion: 1,
          updatedAt: '2020-01-01T00:00:00.000Z',
          updatedBy: 'old',
        },
      },
      deps,
    );
    expect(config.fields[0].aliasFor).toBeUndefined();
  });

  it('survives an llmClassifySmartFields failure (soft-fail branch)', async () => {
    const deps = makeDeps();
    deps.llmClassifySmartFields = jest.fn().mockRejectedValue(new Error('llm down'));
    const { config } = await processEnrichmentConfig(
      {
        listId: 'list-1',
        userId: 'user-1',
        config: {
          fields: [
            { name: 'is_hiring', type: 'string', instruction: 'are they hiring engineers', include: true, overwritePolicy: 'fill_if_empty' },
          ],
          globalOverwriteDefault: 'fill_if_empty',
          schemaVersion: 1,
          updatedAt: '2020-01-01T00:00:00.000Z',
          updatedBy: 'old',
        },
      },
      deps,
    );
    expect(config.fields[0].smartCondition).toBeUndefined();
  });
});
