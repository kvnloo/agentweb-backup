/**
 * Migration script: Normalize HTML template storage.
 *
 * Does two things in a single pass:
 *   1. Adds a unique `template_id` (randomUUID) to every template that lacks one.
 *   2. Merges legacy `email_templates_*` templates into the canonical `templates_*` keys.
 *
 * NOTE: Legacy `email_templates_*` keys are intentionally left in DynamoDB as-is.
 * They are no longer read by the application but are kept as a historical backup.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/migrate-html-templates.ts
 *   NODE_ENV=production  npx ts-node src/scripts/migrate-html-templates.ts
 *
 * Safety guarantees:
 *   - Idempotent: safe to re-run any number of times. Already-migrated templates
 *     are detected by the presence of `template_id` and skipped.
 *   - Additive only: no templates are deleted or overwritten. Legacy templates are
 *     appended to the canonical key; same-name duplicates are kept as distinct
 *     records (each gets its own ID).
 *   - Write-only-if-changed: DynamoDB writes are skipped for keys where nothing
 *     actually changed, avoiding unnecessary churn.
 */

import path from 'path';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { settingsService } from '../services/settingsService';
import { parseTemplateArray } from '../utils/templateParser';

// ── Types ────────────────────────────────────────────────────────────────────

interface HtmlTemplate {
  template_id?: string;
  template_name: string;
  type?: string[];
  subject?: string;
  html_content: string;
  variables?: string[];
  arrayVariables?: string[];
  created_at?: string;
  updated_at?: string;
  isPublic?: boolean;
  [key: string]: unknown;
}

interface KeyResult {
  canonicalKey: string;
  legacyKey: string | null;
  templatesFound: number;
  idsAdded: number;
  legacyMerged: number;
  written: boolean;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Assigns a template_id to any template that doesn't already have one.
 * Returns the (possibly mutated) array and the count of IDs added.
 */
function backfillIds(templates: HtmlTemplate[]): { templates: HtmlTemplate[]; idsAdded: number } {
  let idsAdded = 0;
  const result = templates.map((t) => {
    if (t.template_id) return t;
    idsAdded++;
    return { ...t, template_id: randomUUID() };
  });
  return { templates: result, idsAdded };
}

/**
 * Merges `incoming` templates into `base`. Every incoming template is appended
 * as a distinct record — even if a same-named template exists in base — because
 * they now have different IDs and represent different data.
 */
function mergeTemplates(base: HtmlTemplate[], incoming: HtmlTemplate[]): HtmlTemplate[] {
  return [...base, ...incoming];
}

/**
 * Extracts the suffix after a known prefix from a settings key.
 * e.g. keyAfter('templates_', 'templates_abc123') → 'abc123'
 */
function keyAfter(prefix: string, key: string): string {
  return key.slice(prefix.length);
}

// ── Core migration for a single canonical/legacy key pair ────────────────────

async function migrateKeyPair(
  canonicalKey: string,
  legacyKey: string | null,
): Promise<KeyResult> {
  const result: KeyResult = {
    canonicalKey,
    legacyKey,
    templatesFound: 0,
    idsAdded: 0,
    legacyMerged: 0,
    written: false,
  };

  try {
    // 1. Fetch both settings in parallel
    const [canonicalSetting, legacySetting] = await Promise.all([
      settingsService.getSetting(canonicalKey),
      legacyKey ? settingsService.getSetting(legacyKey) : Promise.resolve(null),
    ]);

    // 2. Parse arrays (parseTemplateArray returns [] safely on null/invalid JSON)
    let canonicalTemplates: HtmlTemplate[] = parseTemplateArray(canonicalSetting);
    const legacyTemplates: HtmlTemplate[] = legacyKey ? parseTemplateArray(legacySetting) : [];

    result.templatesFound = canonicalTemplates.length + legacyTemplates.length;

    // 3. Backfill IDs on canonical templates
    const { templates: canonicalWithIds, idsAdded: canonicalIdsAdded } =
      backfillIds(canonicalTemplates);
    canonicalTemplates = canonicalWithIds;
    result.idsAdded += canonicalIdsAdded;

    // 4. Backfill IDs on legacy templates, then merge into canonical
    let merged = canonicalTemplates;
    if (legacyTemplates.length > 0) {
      const { templates: legacyWithIds, idsAdded: legacyIdsAdded } = backfillIds(legacyTemplates);
      result.idsAdded += legacyIdsAdded;
      result.legacyMerged = legacyTemplates.length;
      merged = mergeTemplates(canonicalTemplates, legacyWithIds);
    }

    // 5. Write back only if something actually changed
    const nothingChanged = result.idsAdded === 0 && result.legacyMerged === 0;
    if (!nothingChanged) {
      await settingsService.setSetting(
        canonicalKey,
        JSON.stringify(merged),
        canonicalSetting?.description ?? canonicalKey,
        'migrate-html-templates-script',
      );
      result.written = true;
    }

    // NOTE: legacy keys are intentionally NOT deleted — kept as historical backup.

  } catch (err: any) {
    result.error = err?.message ?? String(err);
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const env = process.env.NODE_ENV || 'development';
  // tablePrefix mirrors the logic inside SettingsService — it is used here only
  // for display purposes. The actual table name is determined by SettingsService
  // itself using the same NODE_ENV check.
  const tablePrefix = env === 'development' ? 'Dev-' : '';

  console.log('\n🗄️  HTML Templates Migration');
  console.log(`   Environment : ${env}`);
  console.log(`   Table prefix: "${tablePrefix}" (display only — SettingsService owns table selection)`);
  console.log(`   Table       : ${tablePrefix}AW-Settings`);
  console.log(`   Note        : legacy email_templates_* keys are kept in DB as backup\n`);

  // 1. Full table scan to find all relevant keys
  console.log('🔍 Scanning settings table for template keys...');
  const allSettings = await settingsService.getAllSettings();

  const canonicalUserKeys = new Set<string>(); // templates_{userId}
  const legacyUserKeys    = new Set<string>(); // email_templates_{userId}
  let hasCanonicalPublic  = false;
  let hasLegacyPublic     = false;

  for (const setting of allSettings) {
    const k = setting.settingName;
    if (k === 'templates_public')       { hasCanonicalPublic = true; continue; }
    if (k === 'email_templates_public') { hasLegacyPublic    = true; continue; }
    if (k.startsWith('templates_'))       canonicalUserKeys.add(k);
    if (k.startsWith('email_templates_')) legacyUserKeys.add(k);
  }

  // Collect all unique userIds seen across both key namespaces
  const userIds = new Set<string>();
  for (const k of canonicalUserKeys) userIds.add(keyAfter('templates_', k));
  for (const k of legacyUserKeys)    userIds.add(keyAfter('email_templates_', k));

  const totalKeyPairs =
    (hasCanonicalPublic || hasLegacyPublic ? 1 : 0) + userIds.size;

  console.log(`   Found ${totalKeyPairs} key pair(s) to process`);
  console.log(`   ${userIds.size} user(s), public key: ${hasCanonicalPublic || hasLegacyPublic ? 'yes' : 'no'}\n`);

  if (totalKeyPairs === 0) {
    console.log('✅ No template keys found. Nothing to do.\n');
    return;
  }

  // 2. Build list of (canonicalKey, legacyKey | null) pairs to process
  const pairs: Array<{ canonical: string; legacy: string | null }> = [];

  // Public pair
  if (hasCanonicalPublic || hasLegacyPublic) {
    pairs.push({
      canonical: 'templates_public',
      legacy: hasLegacyPublic ? 'email_templates_public' : null,
    });
  }

  // Per-user pairs
  for (const userId of userIds) {
    const canonical = `templates_${userId}`;
    const legacy    = `email_templates_${userId}`;
    pairs.push({
      canonical,
      legacy: legacyUserKeys.has(legacy) ? legacy : null,
    });
  }

  // 3. Process all pairs sequentially (avoids DynamoDB hot-key contention)
  const results: KeyResult[] = [];

  for (const { canonical, legacy } of pairs) {
    const label = legacy ? `${canonical} ← ${legacy}` : canonical;
    process.stdout.write(`  ⏳ ${label} ... `);

    const result = await migrateKeyPair(canonical, legacy);
    results.push(result);

    if (result.error) {
      console.log(`❌ ERROR: ${result.error}`);
    } else if (!result.written) {
      console.log(`⏭️  already normalized (${result.templatesFound} templates)`);
    } else {
      const parts: string[] = [];
      if (result.idsAdded > 0)     parts.push(`+${result.idsAdded} IDs`);
      if (result.legacyMerged > 0) parts.push(`merged ${result.legacyMerged} legacy`);
      console.log(`✅ ${parts.join(', ')} (${result.templatesFound} total templates)`);
    }
  }

  // 4. Summary
  const succeeded = results.filter((r) => !r.error);
  const failed    = results.filter((r) => !!r.error);
  const skipped   = succeeded.filter((r) => !r.written);
  const modified  = succeeded.filter((r) => r.written);
  const totalIds    = results.reduce((n, r) => n + r.idsAdded, 0);
  const totalMerged = results.reduce((n, r) => n + r.legacyMerged, 0);

  console.log('\n─────────────────────────────────────────');
  console.log('📊 Migration Summary');
  console.log(`   Key pairs processed : ${results.length}`);
  console.log(`   Modified            : ${modified.length}`);
  console.log(`   Already normalized  : ${skipped.length}`);
  console.log(`   Failed              : ${failed.length}`);
  console.log(`   IDs assigned        : ${totalIds}`);
  console.log(`   Legacy templates    : ${totalMerged} merged (legacy keys kept as backup)`);

  if (failed.length > 0) {
    console.log('\n❌ Failed key pairs:');
    for (const r of failed) {
      console.log(`   - ${r.canonicalKey}: ${r.error}`);
    }
    process.exit(1);
  }

  console.log('\n✅ Migration complete!\n');
}

main().catch((err) => {
  console.error('Fatal error in migration script:', err);
  process.exit(1);
});
