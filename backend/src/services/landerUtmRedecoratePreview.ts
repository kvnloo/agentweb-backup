import { UTM_KEYS } from "../utils/adUtm";
import {
  CLICK_ID_KEYS,
  LANDER_PROVENANCE_KEY,
  resolveLanderParams,
  validateUtmConfig,
  type UtmConfig,
} from "../utils/landerUtm";

export interface PreviewLanderRecord {
  id: string;
  userId: string;
  name: string;
  status: "generating" | "draft" | "deploying" | "deployed" | "failed";
  deployedUrl?: string;
  customDomainUrl?: string;
  utmOverride?: UtmConfig;
}

export interface DeployedLink {
  /** Stable source location supplied by the deploy reader (for example app/page.tsx:12). */
  location: string;
  href: string;
}

export interface LanderUtmPreviewDependencies {
  listLanders(userId: string): Promise<PreviewLanderRecord[]>;
  getCustomerDefault(userId: string): Promise<UtmConfig | null>;
  /** Read-only deployment boundary. Returning null means the deployed artifact is missing. */
  readDeployedLinks(lander: PreviewLanderRecord): Promise<readonly DeployedLink[] | null>;
}

export interface LinkParamDiff {
  added: Record<string, string>;
  updated: Record<string, { from: string; to: string }>;
  removed: Record<string, string>;
}

export interface LinkPreviewChange {
  location: string;
  before: string;
  after: string;
  params: LinkParamDiff;
}

export type LanderPreviewRow =
  | { landerId: string; name: string; status: "changed"; changes: LinkPreviewChange[] }
  | { landerId: string; name: string; status: "no_change"; changes: [] }
  | {
      landerId: string;
      name: string;
      status: "skipped";
      reason: "explicit_per_lander_override";
      changes: [];
    }
  | { landerId: string; name: string; status: "error"; error: string; changes: [] };

export interface LanderUtmPreviewResult {
  rows: LanderPreviewRow[];
  summary: {
    changed: number;
    noChange: number;
    skipped: number;
    errors: number;
    linkChanges: number;
  };
}

const MANAGED_KEYS = new Set<string>([...UTM_KEYS, LANDER_PROVENANCE_KEY]);
const PRESERVED_CLICK_IDS = new Set<string>(CLICK_ID_KEYS);

function diffLink(href: string, location: string, desired: Record<string, string>): LinkPreviewChange | null {
  let current: URL;
  try {
    current = new URL(href);
  } catch {
    throw new Error(`corrupt deployed link at ${location}: invalid absolute URL`);
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    throw new Error(`corrupt deployed link at ${location}: unsupported protocol ${current.protocol}`);
  }

  const originalEntries = [...current.searchParams.entries()];
  const existing = new Map<string, string>();
  for (const [key, value] of originalEntries) {
    if (MANAGED_KEYS.has(key) && existing.has(key)) {
      throw new Error(`corrupt deployed link at ${location}: duplicate parameter "${key}"`);
    }
    if (!existing.has(key)) existing.set(key, value);
  }

  const params: LinkParamDiff = { added: {}, updated: {}, removed: {} };
  for (const key of UTM_KEYS) {
    const before = existing.get(key);
    const after = desired[key];
    if (after === undefined) {
      if (before !== undefined) params.removed[key] = before;
    } else if (before === undefined) {
      params.added[key] = after;
    } else if (before !== after) {
      params.updated[key] = { from: before, to: after };
    }
  }

  const provenanceBefore = existing.get(LANDER_PROVENANCE_KEY);
  const provenanceAfter = desired[LANDER_PROVENANCE_KEY];
  if (provenanceBefore === undefined) {
    params.added[LANDER_PROVENANCE_KEY] = provenanceAfter;
  } else if (provenanceBefore !== provenanceAfter) {
    params.updated[LANDER_PROVENANCE_KEY] = { from: provenanceBefore, to: provenanceAfter };
  }

  if (
    Object.keys(params.added).length === 0 &&
    Object.keys(params.updated).length === 0 &&
    Object.keys(params.removed).length === 0
  ) {
    return null;
  }

  const rebuilt = new URLSearchParams();
  for (const key of UTM_KEYS) {
    if (desired[key] !== undefined) rebuilt.set(key, desired[key]);
  }
  for (const [key, value] of originalEntries) {
    if (!MANAGED_KEYS.has(key)) rebuilt.append(key, value);
  }
  // Click ids are outside the managed set by construction and therefore can only
  // be carried forward, never enter `removed`. Keep this assertion close to the diff.
  for (const key of PRESERVED_CLICK_IDS) {
    if (existing.has(key) && !rebuilt.has(key)) rebuilt.set(key, existing.get(key)!);
  }
  rebuilt.set(LANDER_PROVENANCE_KEY, provenanceAfter);
  current.search = rebuilt.toString();

  return { location, before: href, after: current.toString(), params };
}

/**
 * Read-only preview of UTM redecorations for deployed landers.
 *
 * Mutation is structurally unavailable: dependencies expose only reads, and the
 * result is computed from snapshots. A caller cannot turn this into live apply
 * with a flag because no apply option or write boundary exists.
 */
export async function previewLanderUtmRedecoration(
  input: { userId: string; selectedLanderIds?: readonly string[] },
  deps: LanderUtmPreviewDependencies,
): Promise<LanderUtmPreviewResult> {
  const [allLanders, customerDefault] = await Promise.all([
    deps.listLanders(input.userId),
    deps.getCustomerDefault(input.userId),
  ]);
  const selected = new Set(input.selectedLanderIds ?? []);
  const landers = allLanders.filter((lander) => lander.status === "deployed");
  const rows: LanderPreviewRow[] = [];

  for (const lander of landers) {
    try {
      // Validate before skipping: a corrupt override is an error, not a valid
      // customer override protected from a default update (ENG-728 AC5).
      const override = validateUtmConfig(lander.utmOverride, "per-lander override");
      if (Object.keys(override).length > 0 && !selected.has(lander.id)) {
        rows.push({
          landerId: lander.id,
          name: lander.name,
          status: "skipped",
          reason: "explicit_per_lander_override",
          changes: [],
        });
        continue;
      }

      const links = await deps.readDeployedLinks(lander);
      if (links === null) throw new Error("deployed artifact is missing");
      if (!Array.isArray(links)) throw new Error("deployed artifact is corrupt");

      const desired = resolveLanderParams({
        override: lander.utmOverride,
        customerDefault: customerDefault ?? undefined,
      }).params;
      const changes = links
        .map((link) => {
          if (
            !link ||
            typeof link.location !== "string" ||
            link.location.trim() === "" ||
            typeof link.href !== "string"
          ) {
            throw new Error("deployed artifact contains a corrupt link record");
          }
          return diffLink(link.href, link.location, desired);
        })
        .filter((change): change is LinkPreviewChange => change !== null);

      rows.push(
        changes.length > 0
          ? { landerId: lander.id, name: lander.name, status: "changed", changes }
          : { landerId: lander.id, name: lander.name, status: "no_change", changes: [] },
      );
    } catch (error: any) {
      rows.push({
        landerId: lander.id,
        name: lander.name,
        status: "error",
        error: error?.message || "failed to resolve deployed lander",
        changes: [],
      });
    }
  }

  return {
    rows,
    summary: {
      changed: rows.filter((row) => row.status === "changed").length,
      noChange: rows.filter((row) => row.status === "no_change").length,
      skipped: rows.filter((row) => row.status === "skipped").length,
      errors: rows.filter((row) => row.status === "error").length,
      linkChanges: rows.reduce(
        (count, row) => count + (row.status === "changed" ? row.changes.length : 0),
        0,
      ),
    },
  };
}
