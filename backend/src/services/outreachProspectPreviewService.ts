/**
 * Outreach Onboarding sub-task 4 — Prospect search preview service.
 *
 * Stateless preview helper that powers the
 * `POST /api/onboarding/outreach/preview-prospects` endpoint. It mirrors the
 * Unipile/LinkedIn search path used by `agentModeService.importLeadsFromSearch`
 * but does NOT write to the CRM — it returns a normalized array of prospect
 * cards the onboarding UI can render straight to screen.
 *
 * Design rationale (Notion plan, Option B):
 *   - Reuses `linkedInOutreachService.resolveAccountId` so the user-LI →
 *     platform-fallback rule is honoured consistently with the CRM import
 *     path. No special-casing here.
 *   - Reuses `linkedInOutreachService.searchPeople` for the actual Unipile
 *     call. Idempotent — refresh-safe — because we never mutate.
 *   - Returns a stable shape (`PreviewProspect`) so sub-task 7's CRM-save
 *     can fold the same items straight into `import_leads_from_search`
 *     without re-querying.
 *
 * The two pure helpers (`buildProspectQuery`, `mapUnipileItemToPreview`) are
 * exported so unit tests can lock down the construction + mapping rules
 * independent of the Unipile mock plumbing.
 */

import { linkedInOutreachService } from "./linkedInOutreachService";
import { isAnonymizedSearchItem } from "../utils/anonymizedLinkedInLead";

/**
 * Output shape for a single prospect card. Matches the FE
 * `OutreachProspect` type in `customer-portal/src/pages/onboardingOutreachCrmSave.ts`,
 * which is what sub-task 7 consumes when persisting to CRM.
 */
export interface PreviewProspect {
  /** Stable id for FE list-keying. Falls back to the LinkedIn URL when no
   *  provider id is available so the FE never has to guard against null. */
  id: string;
  /** Full display name. Always present — falls back to "Unknown" so the
   *  card stays renderable when Unipile returns a partial item. */
  name: string;
  /** Optional headline / current title surfaced on the card. */
  headline?: string;
  /** Optional location string (free-form, as Unipile returns it). */
  location?: string;
  /** Canonical https://www.linkedin.com/in/<slug> URL. Empty string when
   *  no slug or profile_url is available — the FE renders the card
   *  without the "Open profile" link in that case. */
  linkedin_url: string;
  /** Optional public_identifier (slug) so the FE can build alternate URLs
   *  if needed. */
  public_identifier?: string;
  /** Current company, when Unipile gave us work_experience. */
  company?: string;
}

export interface PreviewQueryInput {
  /** Selected ICP name from sub-task 2 (e.g. "K-5 program directors"). */
  icp?: string | null;
  /** Free-text specifications from sub-task 3. */
  specifications?: string | null;
  /** Optional explicit role override — if absent we promote role-keywords
   *  from `specifications` automatically. */
  title?: string | null;
  /** Optional explicit company filter (rare on this screen). */
  company?: string | null;
}

export interface UnipileSearchParams {
  keywords?: string;
  title?: string;
  company?: string;
}

/** Maximum length of the keywords string we send to Unipile. The classic
 *  search endpoint accepts longer strings but the relevance drops off
 *  quickly past ~200 chars; keep it tight. */
export const MAX_KEYWORDS_LENGTH = 200;

/** Lowercased role keywords we promote into the structured `title` filter
 *  when found in the specifications text. Order matters — the longest
 *  match wins so "vp of marketing" beats "vp". */
const ROLE_KEYWORDS: ReadonlyArray<string> = [
  "vp of marketing",
  "head of marketing",
  "head of growth",
  "head of sales",
  "director of marketing",
  "director of growth",
  "chief marketing officer",
  "chief revenue officer",
  "chief executive officer",
  "vice president",
  "directors",
  "director",
  "managers",
  "manager",
  "founders",
  "founder",
  "ceo",
  "cmo",
  "cro",
  "cto",
  "vp",
];

/**
 * Build the structured Unipile search params from the picked ICP +
 * free-text specifications. Pure — no IO, easy to unit-test.
 *
 * Rules:
 *   - `keywords` is "<icp> <specifications>" trimmed to MAX_KEYWORDS_LENGTH.
 *     Empty when both inputs are blank — caller is responsible for the 400
 *     response in that case.
 *   - When `title` is supplied explicitly, pass it through.
 *   - Otherwise, scan `specifications` for a role keyword and promote the
 *     first match into `title`. Longest-match wins.
 *   - `company` only sent when the caller passes it explicitly.
 */
export function buildProspectQuery(
  input: PreviewQueryInput,
): UnipileSearchParams {
  const icp = (input.icp ?? "").trim();
  const specs = (input.specifications ?? "").trim();
  const explicitTitle = (input.title ?? "").trim();
  const company = (input.company ?? "").trim();

  // Compose keywords. We keep the ICP first because it's the strongest
  // semantic anchor — if the string gets truncated, the ICP survives.
  const keywordsRaw = [icp, specs].filter(Boolean).join(" ").trim();
  const keywords =
    keywordsRaw.length > MAX_KEYWORDS_LENGTH
      ? keywordsRaw.slice(0, MAX_KEYWORDS_LENGTH).trim()
      : keywordsRaw;

  // Title resolution — explicit beats inferred.
  let title = explicitTitle;
  if (!title && specs) {
    const lowerSpecs = specs.toLowerCase();
    // Sort by length DESC so "head of marketing" beats "marketing".
    const sorted = [...ROLE_KEYWORDS].sort((a, b) => b.length - a.length);
    for (const kw of sorted) {
      if (lowerSpecs.includes(kw)) {
        title = kw;
        break;
      }
    }
  }

  const out: UnipileSearchParams = {};
  if (keywords) out.keywords = keywords;
  if (title) out.title = title;
  if (company) out.company = company;
  return out;
}

/**
 * Map a Unipile `searchPeople` item into the stable `PreviewProspect`
 * shape consumed by the FE. Pure — no IO.
 *
 * Mirrors the field-mapping in `agentModeService.importLeadsFromSearch`
 * (search-result shape: `name`, `public_identifier`, `headline`,
 * `location`, optional `work_experience`). Different from full-profile
 * shape — we never see `first_name` / `last_name` here.
 */
export function mapUnipileItemToPreview(item: any): PreviewProspect {
  const safeItem = (item && typeof item === "object") ? item : {};

  // Build clean LinkedIn URL from slug; fall back to stripping the messy
  // miniProfileUrn off `profile_url` when no slug is present.
  let linkedin_url = "";
  if (typeof safeItem.public_identifier === "string" && safeItem.public_identifier) {
    linkedin_url = `https://www.linkedin.com/in/${safeItem.public_identifier}`;
  } else if (typeof safeItem.profile_url === "string" && safeItem.profile_url) {
    linkedin_url = safeItem.profile_url.split("?")[0];
  }

  // Stable id for FE list-keying. Prefer Unipile provider id, then slug,
  // then linkedin_url. Empty string is unacceptable — the FE keys on this.
  const id =
    (typeof safeItem.id === "string" && safeItem.id) ||
    (typeof safeItem.provider_id === "string" && safeItem.provider_id) ||
    (typeof safeItem.public_identifier === "string" && safeItem.public_identifier) ||
    linkedin_url ||
    `prospect-${Math.random().toString(36).slice(2, 10)}`;

  // Name resolution. Search results carry `name` (full); some Unipile
  // payloads still carry split first_name/last_name. Prefer full `name`.
  let name: string = "";
  if (typeof safeItem.name === "string" && safeItem.name.trim()) {
    name = safeItem.name.trim();
  } else if (
    typeof safeItem.first_name === "string" ||
    typeof safeItem.last_name === "string"
  ) {
    name = [safeItem.first_name, safeItem.last_name]
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .join(" ")
      .trim();
  }
  if (!name) name = "Unknown";

  const out: PreviewProspect = {
    id,
    name,
    linkedin_url,
  };

  if (typeof safeItem.headline === "string" && safeItem.headline.trim()) {
    out.headline = safeItem.headline.trim();
  }
  if (typeof safeItem.location === "string" && safeItem.location.trim()) {
    out.location = safeItem.location.trim();
  }
  if (typeof safeItem.public_identifier === "string" && safeItem.public_identifier) {
    out.public_identifier = safeItem.public_identifier;
  }

  // Company from work_experience when present (search results often omit it).
  if (Array.isArray(safeItem.work_experience) && safeItem.work_experience.length) {
    const current =
      safeItem.work_experience.find((w: any) => w?.current) ||
      safeItem.work_experience[0];
    if (current && typeof current.company === "string" && current.company.trim()) {
      out.company = current.company.trim();
    }
    if (
      !out.headline &&
      current &&
      typeof current.position === "string" &&
      current.position.trim()
    ) {
      out.headline = current.position.trim();
    }
  }

  return out;
}

/**
 * Result envelope returned by `searchProspectsPreview`.
 *   - `ok: true`  → carry the `items` array (possibly empty if Unipile
 *                    returned zero results — the UI shows the empty
 *                    state in that case).
 *   - `ok: false` → carry an `error` code so the route can pick the
 *                    appropriate HTTP status. Codes:
 *                       'no_filters'       — caller passed all-empty input
 *                                            (route returns 400).
 *                       'no_linkedin_account' — neither user LI nor
 *                                            platform fallback is
 *                                            configured (route returns
 *                                            200 with `prospects: []`
 *                                            so the UI falls through to
 *                                            the skip path; the FE
 *                                            inspects `linkedinConnected`
 *                                            to render the right message).
 *                       'unipile_error'    — Unipile call returned the
 *                                            { error } envelope from
 *                                            `handleError`. Route returns
 *                                            502.
 */
export type PreviewResult =
  | {
      ok: true;
      items: PreviewProspect[];
      linkedinConnected: boolean;
      cursor?: string;
    }
  | {
      ok: false;
      error: "no_filters" | "no_linkedin_account" | "unipile_error";
      message?: string;
    };

export interface SearchPreviewArgs {
  icp?: string | null;
  specifications?: string | null;
  title?: string | null;
  company?: string | null;
  /** Defaults to 10. Capped to 10 (the design intent — "5–10 humans") and
   *  floored at 1. */
  limit?: number;
}

/**
 * Run the actual Unipile-backed prospect search. The caller (route
 * handler) is responsible for HTTP status + response shaping.
 */
export async function searchProspectsPreview(
  userId: string,
  args: SearchPreviewArgs,
): Promise<PreviewResult> {
  // Validate filters. At least one of icp/specifications/title/company
  // must produce a non-empty Unipile param. If everything is blank,
  // return a structured 'no_filters' so the route can 400.
  const params = buildProspectQuery(args);
  if (!params.keywords && !params.title && !params.company) {
    return { ok: false, error: "no_filters" };
  }

  const accountId = await linkedInOutreachService.resolveAccountId(userId);
  // We need to surface whether the search ran on the user's own LI or the
  // platform fallback. `resolveAccountId` returns the user's own account
  // when present, else the platform fallback, else null. We can't tell
  // those apart from the return value alone, so we re-check via the
  // service's connected-account inspector. Cheap call (single GSI hit).
  if (!accountId) {
    return { ok: false, error: "no_linkedin_account" };
  }

  // Determine `linkedinConnected` — does the user have their own LI
  // connected, or are we falling back to the platform account? The FE
  // surfaces a banner when we're on platform-fallback so the user knows
  // the prospects are "AgentWeb network" instead of "your network".
  // Mirrors the user-LI check that lives at the top of `resolveAccountId`.
  let linkedinConnected = false;
  try {
    const { getAccountsByUserId } = await import("./connectedAccountsDb");
    const accounts = await getAccountsByUserId(userId);
    linkedinConnected = (accounts || []).some(
      (a: any) => a?.platform === "unipile" && !!a?.account_id,
    );
  } catch {
    // Non-fatal — if the inspector throws, default to false (the
    // banner is conservative and shows the platform-fallback message).
    linkedinConnected = false;
  }

  // Cap limit. Design says 5–10 — 10 is the upper bound. `searchPeople`
  // doesn't take a server-side limit, so we slice in JS.
  const limit = Math.max(1, Math.min(10, args.limit ?? 10));

  const searchResult = await linkedInOutreachService.searchPeople(
    accountId,
    params,
  );

  // `handleError` returns `{ error: '...' }` instead of throwing, so we
  // detect it here and 502 at the route layer.
  if (
    searchResult &&
    typeof searchResult === "object" &&
    "error" in searchResult &&
    !("items" in searchResult)
  ) {
    return {
      ok: false,
      error: "unipile_error",
      message:
        typeof (searchResult as any).error === "string"
          ? (searchResult as any).error
          : "Unipile search failed",
    };
  }

  const rawItems: any[] = Array.isArray(searchResult?.items)
    ? searchResult!.items
    : [];

  // ENG-1002: drop LinkedIn's anonymized out-of-network hits BEFORE the slice.
  // These cards are handed straight to POST /api/onboarding/outreach/save,
  // which persists them via crmDb.batchCreateLeads — so an unfiltered
  // placeholder becomes a nameless, un-dedupable CRM lead exactly the way the
  // agent-mode import used to create them. Filtering ahead of the slice also
  // means the user gets `limit` real prospects instead of losing card slots to
  // profiles they cannot see, open or contact.
  const items = rawItems
    .filter((item) => !isAnonymizedSearchItem(item))
    .slice(0, limit)
    .map(mapUnipileItemToPreview);

  return {
    ok: true,
    items,
    linkedinConnected,
    cursor:
      typeof searchResult?.cursor === "string"
        ? searchResult.cursor
        : undefined,
  };
}
