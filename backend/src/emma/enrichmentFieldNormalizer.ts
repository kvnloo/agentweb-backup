// Maps Emma-requested output field names onto existing CRM columns (standard or
// custom) when the requested name is a synonym/alias, preventing duplicate columns.
//
// Example: 'company_name' → 'company' (standard column synonym)
//          'funding_round' when list has 'funding_stage' → 'funding_stage' (existing custom)

import type { EmmaEnrichmentOutputField } from './enrichmentToolConfig';
import { canonicalFieldName } from '../services/enrichmentConfigService';

export interface FieldRemap {
  from: string;
  to: string;
  reason: 'standard_column' | 'existing_custom_field';
}

export interface NormalizeResult {
  fields: EmmaEnrichmentOutputField[];
  remaps: FieldRemap[];
}

// ─── Standard column synonym table ──────────────────────────────────────────
// Maps a normalized synonym key → the standard CRM column name.
// Standard columns: firstName, lastName, email, company, phone, title, linkedin, notes, website.
// Key normalization: trim().toLowerCase().replace(/[\s-]+/g, '_')
// (underscores already present stay as-is; camelCase handled via separate lookup below)

const STANDARD_FIELD_SYNONYMS: Record<string, string> = {
  // company
  company: 'company',
  company_name: 'company',
  companyname: 'company',
  organization: 'company',
  organisation: 'company',
  org: 'company',
  employer: 'company',

  // title
  title: 'title',
  job_title: 'title',
  jobtitle: 'title',
  role: 'title',
  position: 'title',
  designation: 'title',
  job_role: 'title',

  // linkedin
  linkedin: 'linkedin',
  linkedin_url: 'linkedin',
  linkedinurl: 'linkedin',
  linkedin_profile: 'linkedin',
  linkedin_link: 'linkedin',
  linkedin_profile_url: 'linkedin',

  // email
  email: 'email',
  email_address: 'email',
  emailaddress: 'email',
  work_email: 'email',

  // phone
  phone: 'phone',
  phone_number: 'phone',
  phonenumber: 'phone',
  telephone: 'phone',
  mobile: 'phone',
  contact_number: 'phone',

  // website
  website: 'website',
  company_website: 'website',
  web_site: 'website',
  company_url: 'website',

  // firstName
  firstname: 'firstName',
  first_name: 'firstName',
  fname: 'firstName',
  given_name: 'firstName',

  // lastName
  lastname: 'lastName',
  last_name: 'lastName',
  lname: 'lastName',
  surname: 'lastName',
  family_name: 'lastName',

  // notes
  notes: 'notes',
  note: 'notes',
};

/** The set of standard CRM columns (values in STANDARD_FIELD_SYNONYMS). */
const STANDARD_COLUMNS = new Set<string>([
  'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes', 'website',
]);

/** Normalize a field name to a lookup key: trim, lowercase, collapse spaces/hyphens to underscore. */
function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Look up a field name in STANDARD_FIELD_SYNONYMS. Tries both the normalized
 *  key (e.g. 'company_name') and the no-underscore variant (e.g. 'companyname'). */
function lookupStandardSynonym(name: string): string | undefined {
  const key = normalizeKey(name);
  if (STANDARD_FIELD_SYNONYMS[key] !== undefined) return STANDARD_FIELD_SYNONYMS[key];
  // Also try without underscores so 'companyName' → 'companyname' matches
  const noUnderscore = key.replace(/_/g, '');
  if (STANDARD_FIELD_SYNONYMS[noUnderscore] !== undefined) return STANDARD_FIELD_SYNONYMS[noUnderscore];
  return undefined;
}

/** Map each requested output field onto an existing column (standard or an
 *  existing custom field on the list) when it is a synonym/alias, so enrichment
 *  writes into the existing column instead of creating a duplicate. */
export function normalizeOutputFields(
  outputFields: EmmaEnrichmentOutputField[],
  existingFieldNames: string[],
): NormalizeResult {
  const remaps: FieldRemap[] = [];
  const seenNames = new Set<string>();
  const normalizedFields: EmmaEnrichmentOutputField[] = [];

  for (const f of outputFields) {
    const originalName = f.name;
    let resolvedName = originalName;
    let remapped = false;

    // Step 1: Standard column synonym match
    const standardMatch = lookupStandardSynonym(originalName);
    if (standardMatch !== undefined) {
      remapped = true; // identified as a standard column — Step 2 must not run
      if (standardMatch !== originalName) {
        resolvedName = standardMatch;
        remaps.push({ from: originalName, to: standardMatch, reason: 'standard_column' });
      }
    }

    // Step 2: Existing custom field match (only if step 1 didn't produce a remap)
    if (!remapped) {
      const reqCanon = canonicalFieldName(originalName);
      if (reqCanon !== undefined) {
        for (const existingName of existingFieldNames) {
          // Only consider non-standard fields (no matching against standard columns)
          if (STANDARD_COLUMNS.has(existingName)) continue;
          // Don't remap onto itself
          if (existingName === originalName) continue;
          const existingCanon = canonicalFieldName(existingName);
          if (existingCanon !== undefined && existingCanon === reqCanon) {
            resolvedName = existingName;
            remaps.push({ from: originalName, to: existingName, reason: 'existing_custom_field' });
            remapped = true;
            break;
          }
        }
      }
    }

    // Post-dedup: if another field already resolved to this name, skip this one
    if (seenNames.has(resolvedName)) {
      continue;
    }
    seenNames.add(resolvedName);

    normalizedFields.push({
      ...f,
      name: resolvedName,
    });
  }

  return { fields: normalizedFields, remaps };
}
