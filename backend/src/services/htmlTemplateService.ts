/**
 * htmlTemplateService.ts
 *
 * Manages HTML templates stored in AW-Settings (no separate table).
 *
 * Storage keys:
 *   templates_<userId>   — per-user private templates (JSON-stringified array)
 *   templates_public     — admin-published public templates
 *
 * This keeps full backward compatibility with the legacy controller
 * (htmlTemplatesController.ts) field names.
 */
import { settingsService } from "./settingsService";
import { v4 as uuidv4 } from "uuid";

export interface HtmlTemplate {
  template_id: string;
  template_name: string;
  type: ("email" | "landing_page")[];
  subject?: string;
  html_content: string;
  variables?: string[];
  arrayVariables?: string[];
  created_at: string;
  updated_at: string;
}

const USER_KEY = (userId: string): string => `templates_${userId}`;
const PUBLIC_KEY = "templates_public";

/** Parse a raw `settingValue` JSON string into normalized templates. Malformed JSON or a
 * non-array parses to empty rather than throwing — a corrupt row should read as "nothing
 * here yet", not crash every caller. */
function parseRow(settingValue: string | undefined | null): HtmlTemplate[] {
  if (!settingValue) return [];
  try {
    const parsed = JSON.parse(settingValue);
    return Array.isArray(parsed) ? parsed.map(normalize) : [];
  } catch {
    return [];
  }
}

async function readRow(key: string): Promise<HtmlTemplate[]> {
  const row = await settingsService.getSetting(key);
  return parseRow(row?.settingValue);
}

function normalize(t: any): HtmlTemplate {
  return {
    ...t,
    type: Array.isArray(t.type) ? t.type : t.type ? [t.type] : ["email"],
    template_id: t.template_id || uuidv4(),
  } as HtmlTemplate;
}

async function writeRow(
  key: string,
  templates: HtmlTemplate[],
  updatedBy: string,
): Promise<void> {
  await settingsService.setSetting(
    key,
    JSON.stringify(templates),
    "User templates",
    updatedBy,
  );
}

export const htmlTemplateService = {
  async getTemplatesByOwner(userId: string): Promise<HtmlTemplate[]> {
    return readRow(USER_KEY(userId));
  },

  async getPublicTemplates(): Promise<HtmlTemplate[]> {
    return readRow(PUBLIC_KEY);
  },

  async getTemplate(
    templateId: string,
    ownerUserId: string,
  ): Promise<HtmlTemplate | null> {
    const all = await readRow(USER_KEY(ownerUserId));
    return all.find((t) => t.template_id === templateId) ?? null;
  },

  async getPublicTemplate(templateId: string): Promise<HtmlTemplate | null> {
    const all = await readRow(PUBLIC_KEY);
    return all.find((t) => t.template_id === templateId) ?? null;
  },

  async createTemplate(
    ownerUserId: string,
    input: Omit<HtmlTemplate, "template_id" | "created_at" | "updated_at">,
    updatedBy: string,
  ): Promise<HtmlTemplate> {
    const all = await readRow(USER_KEY(ownerUserId));
    const now = new Date().toISOString();
    const tpl: HtmlTemplate = {
      ...input,
      template_id: uuidv4(),
      created_at: now,
      updated_at: now,
    };
    all.push(tpl);
    await writeRow(USER_KEY(ownerUserId), all, updatedBy);
    return tpl;
  },

  async updateTemplate(
    templateId: string,
    ownerUserId: string,
    fields: Partial<Omit<HtmlTemplate, "template_id" | "created_at">>,
    updatedBy: string,
  ): Promise<HtmlTemplate | null> {
    const all = await readRow(USER_KEY(ownerUserId));
    const idx = all.findIndex((t) => t.template_id === templateId);
    if (idx === -1) return null;
    const next: HtmlTemplate = {
      ...all[idx],
      ...fields,
      updated_at: new Date().toISOString(),
    };
    all[idx] = next;
    await writeRow(USER_KEY(ownerUserId), all, updatedBy);
    return next;
  },

  async deleteTemplate(
    templateId: string,
    ownerUserId: string,
    updatedBy: string,
  ): Promise<boolean> {
    const all = await readRow(USER_KEY(ownerUserId));
    const next = all.filter((t) => t.template_id !== templateId);
    if (next.length === all.length) return false;
    await writeRow(USER_KEY(ownerUserId), next, updatedBy);
    return true;
  },

  /**
   * Move ALL templates from one user's row to another's.
   * Used by member-removal "transfer" decision (bulk, single call).
   */
  async transferAllTemplates(
    fromUserId: string,
    toUserId: string,
    updatedBy: string,
  ): Promise<number> {
    const fromAll = await readRow(USER_KEY(fromUserId));
    if (fromAll.length === 0) return 0;
    const toAll = await readRow(USER_KEY(toUserId));
    await writeRow(USER_KEY(toUserId), [...toAll, ...fromAll], updatedBy);
    await writeRow(USER_KEY(fromUserId), [], updatedBy);
    return fromAll.length;
  },

  /**
   * Delete ALL templates for a user.
   * Used by member-removal "delete" decision (bulk, single call).
   */
  async deleteAllTemplates(userId: string, updatedBy: string): Promise<number> {
    const all = await readRow(USER_KEY(userId));
    if (all.length === 0) return 0;
    await writeRow(USER_KEY(userId), [], updatedBy);
    return all.length;
  },

  /**
   * ENG-1552: create or update a row in `templates_public` by a caller-supplied,
   * STABLE `template_id` — no other code path writes this key at all (`createTemplate`
   * above only ever targets `USER_KEY`), so seed scripts are the only writer and must
   * supply their own fixed id to stay idempotent across re-runs, rather than minting a
   * fresh uuid each time.
   *
   * All public templates share ONE JSON-array blob under `templates_public` — there is
   * no per-item DynamoDB row the way `AW-WorkPlans`/schedule templates have. A plain
   * read-modify-write here would let a lost update silently clobber the WHOLE blob, not
   * just one template, if two writers raced. Guarded via `setSettingIfValueMatches`
   * (ENG-965) — conditioned on the exact raw value this call read — with a bounded retry
   * on `ConditionalCheckFailedException`, same pattern already used for other
   * read-modify-write settings rows (see `routes/admin.ts`'s org share-settings toggle).
   * This is genuinely atomic against a CONCURRENT writer, unlike an earlier version of
   * this method that used the unconditioned `setSetting` and merely claimed parity with
   * a truly-atomic sibling (ENG-1609's per-item conditional create) without providing it.
   *
   * One narrow gap remains, deliberately: the very FIRST write to `templates_public`
   * (row does not exist yet at all) has nothing to condition on, so that specific
   * bootstrap case is a plain, unconditioned write. Acceptable for this method's actual
   * caller today — a human running a one-off seed script — but NOT a guarantee a future
   * live/automated caller should rely on without re-checking.
   */
  async upsertPublicTemplate(
    template: Omit<HtmlTemplate, "created_at" | "updated_at"> & { template_id: string },
    updatedBy: string,
    options: { onlyIfAbsent?: boolean } = {},
  ): Promise<{ template: HtmlTemplate; created: boolean }> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const row = await settingsService.getSetting(PUBLIC_KEY);
      const all: HtmlTemplate[] = parseRow(row?.settingValue);
      const idx = all.findIndex((t) => t.template_id === template.template_id);

      if (idx !== -1 && options.onlyIfAbsent) {
        return { template: all[idx], created: false };
      }

      const now = new Date().toISOString();
      const created = idx === -1;
      const resultTemplate: HtmlTemplate = created
        ? { ...template, created_at: now, updated_at: now }
        : { ...all[idx], ...template, updated_at: now };
      const nextAll = created
        ? [...all, resultTemplate]
        : all.map((t, i) => (i === idx ? resultTemplate : t));

      try {
        // Row EXISTENCE gates which write path is safe, not whether its value happens to be
        // truthy — `row != null` (not `row?.settingValue`) so a row that exists with an
        // empty-string settingValue still goes through the conditioned write. writeRow's own
        // JSON.stringify(array) can never itself produce "" (its floor is "[]"), so this case
        // is unreachable via this service's own writers today, but "row exists" and "row has
        // a truthy value" are different questions and only the former is what CAS needs.
        if (row != null) {
          await settingsService.setSettingIfValueMatches(
            PUBLIC_KEY,
            JSON.stringify(nextAll),
            row.settingValue,
            "User templates",
            updatedBy,
          );
        } else {
          // Genuinely no row yet — nothing to condition on. See doc comment above.
          await writeRow(PUBLIC_KEY, nextAll, updatedBy);
        }
        return { template: resultTemplate, created };
      } catch (err: any) {
        if (err?.code === "ConditionalCheckFailedException") {
          continue; // stale read — retry from a fresh one
        }
        throw err;
      }
    }

    throw new Error(
      `upsertPublicTemplate: exceeded ${MAX_ATTEMPTS} attempts for template_id "${template.template_id}" — too much write contention on templates_public`
    );
  },
};
