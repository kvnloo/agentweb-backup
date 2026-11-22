/**
 * Onboarding design-system build service — ENG-328.
 *
 * Mandatory onboarding step: scrape the account's website design system
 * (colors, typography, logo, layout/hierarchy notes) and write it as
 * `design.md` into a dedicated Knowledge Base task so it's available as
 * context for content-generation tools.
 *
 * Unlike onboardingBrandBuildService.ts (which hands the whole job to an
 * Emma chat session), this is DETERMINISTIC — it calls cssExtractor.ts's
 * existing extraction pipeline directly. That pipeline already produces real
 * computed hex colors and font data (not LLM paraphrase), and this step runs
 * on every single signup, so a cheaper, faster, non-LLM path is the better
 * fit than another freeform agent turn.
 *
 * Pipeline:
 *   1. Resolve the account's website URL (same precedence as brand-build).
 *   2. Extract the homepage via cssExtractor, plus up to 3 same-origin
 *      secondary pages discovered from on-page nav links (about/pricing/
 *      product/company/team).
 *   3. Merge design tokens across pages, run inferBrandTokens.
 *   4. Derive deterministic layout/hierarchy notes (no LLM signal exists for
 *      this in cssExtractor today — see cssExtractor.ts's ComputedElementStyles
 *      selector sampling).
 *   5. Assemble design.md and upsert it into a dedicated "Website Design
 *      System" Knowledge Base task (create once, `kbTaskId` persisted so
 *      re-runs overwrite in place instead of duplicating).
 *
 * If the scrape can't succeed (no URL, site down, bot-walled, timeout) this
 * falls back to deriving a minimal design.md from whatever brandGuidelines
 * already captured (colors/fonts), so the mandatory step always terminates
 * in `ready` rather than stranding the account — mirroring this codebase's
 * existing graceful-degradation precedent (ManualBrandFallback, the "I don't
 * have a website yet" skip) instead of introducing an unprecedented hard
 * lockout with no admin override.
 */

import { readUserForOwnership } from "../utils/readUserForOwnership";
import { userDb, taskDb, orgDb } from "./db";
import { resolveOrgProfileField } from "./orgProfileResolver";
import { v4 as uuidv4 } from "uuid";
import {
  buildFailedPatch,
  buildReadyPatch,
  DesignSystemFields,
  DesignSystemSource,
} from "./designSystemStatusService";

const DESIGN_SYSTEM_TIMEOUT_MS = 120_000;

const SECONDARY_PAGE_KEYWORDS = ["about", "pricing", "product", "company", "team"];
const MAX_SECONDARY_PAGES = 3;

type ExtractCSSFromURLFn = (url: string, options?: any) => Promise<any>;
type AnalyzeDesignTokensFn = (cssData: any) => Promise<any>;
type InferBrandTokensFn = (tokens: any) => any;
type FetchHtmlFn = (url: string) => Promise<string>;
type UpdateKnowledgeBaseFileFn = (
  taskId: string,
  fileName: string,
  content: string,
  mode: "replace" | "append",
  userId: string,
  sessionId: string
) => Promise<{ success: boolean; message?: string; error?: string }>;

export interface DesignSystemBuildDeps {
  extractCSSFromURL?: ExtractCSSFromURLFn;
  analyzeDesignTokens?: AnalyzeDesignTokensFn;
  inferBrandTokens?: InferBrandTokensFn;
  fetchHtml?: FetchHtmlFn;
  updateKnowledgeBaseFile?: UpdateKnowledgeBaseFileFn;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Lazy-loaded default deps, each requiring its module only when ACTUALLY
 * INVOKED — not when merely referenced. cssExtractor pulls JSDOM and
 * agentModeService is enormous (473KB, and pulls ESM deps Jest's default
 * transform can't parse); a caller that supplies every dep as a test fake
 * (as every unit test here does) must never trigger either require(), even
 * transitively, or the module load itself throws before the fake is ever
 * used.
 */
const defaultExtractCSSFromURL: ExtractCSSFromURLFn = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("./cssExtractor").extractCSSFromURL(...args);
const defaultAnalyzeDesignTokens: AnalyzeDesignTokensFn = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("./cssExtractor").analyzeDesignTokens(...args);
const defaultInferBrandTokens: InferBrandTokensFn = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("./cssExtractor").inferBrandTokens(...args);
const defaultFetchHtml: FetchHtmlFn = (...args) =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("./cssExtractor").fetchFreshHtmlFromValidatedUrl(...args);
const defaultUpdateKnowledgeBaseFile: UpdateKnowledgeBaseFileFn = (...args) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { agentModeService } = require("./agentModeService");
  return agentModeService.updateKnowledgeBaseFile(...args);
};

/**
 * Strip userinfo, query string, and fragment from a URL that is about to be
 * scraped and/or persisted (CodeRabbit finding, ENG-328). design.md is a
 * private Knowledge Base file Emma is explicitly instructed to read for
 * every visual task, and the same string is echoed into design.md's "Scraped
 * from"/"Pages scanned" lines and into any scrape-failure error text — so a
 * stray basic-auth userinfo or signed/token query string on productDomain
 * would otherwise flow verbatim into an LLM-readable file and error logs.
 * Sanitizing once at the source (here, and in discoverSecondaryPageUrls)
 * means every downstream consumer of these URLs is clean for free. Falls
 * back to the raw input if it isn't a parseable URL.
 */
function sanitizeScrapeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (!u.username && !u.password && !u.search && !u.hash) {
      // Nothing to strip — return the original string untouched rather than
      // URL's reserialized form, which e.g. adds a trailing "/" to a bare
      // origin. Avoids a gratuitous behavior/string change on the (vast
      // majority) common case of a clean company URL.
      return rawUrl;
    }
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Same precedence onboardingBrandBuildService.pickCompanyUrl uses
 * (productDomain -> brandGuidelines.brandData.domain -> legacy companyUrl).
 *
 * `productDomain` is dual-purposed — it's also the plain-domain analytics
 * feature-tracking field (see db.ts's doc comment: "e.g. 'app.example.com'")
 * — so callers that only ever went through onboarding's own https://-prepend
 * (handleBrandSubmit) never noticed it can arrive with no scheme. cssExtractor's
 * `new URL()` parse throws on a bare domain, so normalize here rather than
 * failing every scrape for an account whose productDomain came from Settings.
 */
function pickCompanyUrl(user: any): string | null {
  if (!user) return null;
  const raw =
    (typeof user.productDomain === "string" && user.productDomain.trim()) ||
    (typeof user.brandGuidelines?.brandData?.domain === "string" && user.brandGuidelines.brandData.domain.trim()) ||
    (typeof user.companyUrl === "string" && user.companyUrl.trim()) ||
    "";
  if (!raw) return null;
  const absolute = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return sanitizeScrapeUrl(absolute);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Discover up to MAX_SECONDARY_PAGES same-origin URLs worth extracting
 * alongside the homepage, from raw nav-link hrefs. Best-effort: a parse
 * failure just yields an empty list and the caller falls back to
 * homepage-only extraction.
 */
export function discoverSecondaryPageUrls(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const hrefRe = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  const found = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null && found.size < MAX_SECONDARY_PAGES) {
    let abs: URL;
    try {
      abs = new URL(m[1], base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    if (abs.hostname !== base.hostname) continue; // same-origin only
    const path = abs.pathname.toLowerCase();
    for (const kw of SECONDARY_PAGE_KEYWORDS) {
      if (found.has(kw)) continue;
      if (path.includes(kw)) {
        found.set(kw, sanitizeScrapeUrl(abs.toString()));
        break;
      }
    }
  }
  return Array.from(found.values());
}

function mergeCountArrays<T extends { count: number }>(items: T[], keyOf: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = map.get(key);
    if (existing) {
      existing.count += item.count;
    } else {
      map.set(key, { ...item });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** Merge DesignTokens across pages by summing usage counts, not overwriting. */
export function mergeDesignTokens(tokensList: any[]): any {
  if (tokensList.length === 1) return tokensList[0];

  const dedupeStrings = (arrays: string[][]) => Array.from(new Set(arrays.flat()));

  return {
    colors: {
      all: mergeCountArrays(
        tokensList.flatMap((t) => t.colors.all),
        (c) => c.value
      ),
      backgrounds: dedupeStrings(tokensList.map((t) => t.colors.backgrounds)),
      text: dedupeStrings(tokensList.map((t) => t.colors.text)),
      borders: dedupeStrings(tokensList.map((t) => t.colors.borders)),
      accents: dedupeStrings(tokensList.map((t) => t.colors.accents)),
    },
    typography: {
      fontFamilies: mergeCountArrays(
        tokensList.flatMap((t) => t.typography.fontFamilies),
        (f) => f.family
      ),
      fontSizes: mergeCountArrays(
        tokensList.flatMap((t) => t.typography.fontSizes),
        (s) => s.size
      ),
      fontWeights: mergeCountArrays(
        tokensList.flatMap((t) => t.typography.fontWeights),
        (w) => String(w.weight)
      ),
      lineHeights: mergeCountArrays(
        tokensList.flatMap((t) => t.typography.lineHeights),
        (l) => l.height
      ),
      scale: tokensList[0]?.typography.scale ?? tokensList.find((t) => t.typography.scale)?.typography.scale,
    },
    visualEffects: {
      boxShadows: mergeCountArrays(
        tokensList.flatMap((t) => t.visualEffects.boxShadows),
        (b) => b.value
      ),
      textShadows: tokensList[0]?.visualEffects.textShadows ?? [],
      borderRadius: mergeCountArrays(
        tokensList.flatMap((t) => t.visualEffects.borderRadius),
        (b) => b.value
      ),
      transitions: [],
    },
  };
}

/**
 * Deterministic layout/hierarchy heuristic. cssExtractor has no dedicated
 * spacing/grid signal — this reads which structural selectors it sampled
 * (header/nav/hero/cta/footer/main/section) rather than inventing one via an
 * extra LLM pass, keeping this mandatory-at-every-signup step fast and free.
 */
export function buildLayoutNotes(computedElements: Record<string, unknown> | undefined): string[] {
  if (!computedElements) {
    return ["No layout signal captured (the page could not be rendered in a real browser)."];
  }
  const keys = new Set(Object.keys(computedElements));
  const notes: string[] = [];
  notes.push(
    keys.has("header") || keys.has("nav") || keys.has("banner") || keys.has("navigation")
      ? "Header/navigation region detected."
      : "No distinct header/navigation region detected."
  );
  if (keys.has("hero")) notes.push("Hero section detected near the top of the page.");
  if (keys.has("cta") || keys.has("btn") || keys.has("button")) {
    notes.push("Call-to-action button styling detected.");
  }
  if (keys.has("main") || keys.has("section")) {
    notes.push("Content is organized into distinct main/section regions.");
  }
  notes.push(keys.has("footer") ? "Footer region detected." : "No distinct footer region detected.");
  return notes;
}

export function assembleDesignMarkdown(input: {
  url: string;
  brandIdentity: any;
  brandTokens: any;
  detailedTokens: any;
  layoutNotes: string[];
  pagesScanned: string[];
  generatedAt: string;
}): string {
  const { url, brandIdentity, brandTokens, detailedTokens, layoutNotes, pagesScanned, generatedAt } = input;
  const lines: string[] = [];
  lines.push(`# Design System — ${brandIdentity?.brandName || url}`);
  lines.push("");
  lines.push(`Scraped from ${url} on ${generatedAt}.`);
  lines.push(`Pages scanned: ${pagesScanned.join(", ")}`);
  lines.push("");
  lines.push("## Colors");
  lines.push("");
  lines.push(`- Primary: \`${brandTokens.colors.primary}\``);
  lines.push(`- Secondary: \`${brandTokens.colors.secondary}\``);
  if (brandTokens.colors.palette?.length) {
    lines.push(`- Palette: ${brandTokens.colors.palette.map((c: string) => `\`${c}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("### All detected colors (hex, usage count)");
  lines.push("");
  for (const c of (detailedTokens.colors.all as any[]).slice(0, 20)) {
    lines.push(`- \`${c.value}\` — used ${c.count}x${c.contexts?.length ? ` (${c.contexts.join(", ")})` : ""}`);
  }
  lines.push("");
  lines.push("## Typography");
  lines.push("");
  lines.push(`- Heading font: ${brandTokens.typography.headingFont}`);
  lines.push(`- Body font: ${brandTokens.typography.bodyFont}`);
  lines.push(
    `- Font weights: regular ${brandTokens.typography.fontWeights.regular}, semibold ${brandTokens.typography.fontWeights.semibold}, bold ${brandTokens.typography.fontWeights.bold}`
  );
  const scale = detailedTokens.typography.scale;
  if (scale) {
    lines.push("");
    lines.push("### Type scale");
    lines.push("");
    for (const key of ["h1", "h2", "h3", "body", "small"] as const) {
      const s = scale[key];
      if (s) lines.push(`- ${key}: ${s.fontSize} / line-height ${s.lineHeight} / weight ${s.fontWeight}`);
    }
  }
  lines.push("");
  lines.push("## Logo & Brand Assets");
  lines.push("");
  lines.push(`- Logo: ${brandIdentity?.logoUrl || "_not found_"}`);
  lines.push(`- Favicon: ${brandIdentity?.favicon || "_not found_"}`);
  lines.push(`- Brand name: ${brandIdentity?.brandName || "_not found_"}`);
  lines.push(`- Tagline: ${brandIdentity?.tagline || "_not found_"}`);
  lines.push("");
  lines.push("## Layout & Hierarchy");
  lines.push("");
  for (const note of layoutNotes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("## Visual Effects");
  lines.push("");
  lines.push(`- Primary shadow: \`${brandTokens.visualEffects.primaryShadow}\``);
  lines.push(`- Border radius: \`${brandTokens.visualEffects.borderRadius}\``);
  lines.push("");
  return lines.join("\n");
}

export function buildManualFallbackMarkdown(user: any, generatedAt: string, scrapeError?: string): string {
  const bd = user?.brandGuidelines?.brandData;
  const logoAttachment = (user?.brandGuidelines?.attachments || []).find((a: any) => a?.type === "logo");
  const lines: string[] = [];
  lines.push(`# Design System — ${bd?.brandName || user?.companyName || "Untitled"}`);
  lines.push("");
  lines.push(
    "_The website could not be scraped automatically" +
      (scrapeError ? ` (${scrapeError})` : "") +
      ". This file was derived from the brand details captured during onboarding instead of a live scrape — re-run the design-system step from Settings once the site is reachable to replace it with real scraped data._"
  );
  lines.push("");
  lines.push(`Generated ${generatedAt}.`);
  lines.push("");
  lines.push("## Colors");
  lines.push("");
  lines.push(`- Primary: \`${bd?.primaryColor || "unknown"}\``);
  lines.push(`- Secondary: \`${bd?.secondaryColor || "unknown"}\``);
  lines.push("");
  lines.push("## Typography");
  lines.push("");
  lines.push(`- Font family: ${bd?.fontFamily || "unknown"}`);
  lines.push("");
  lines.push("## Logo & Brand Assets");
  lines.push("");
  lines.push(`- Logo: ${logoAttachment?.url || "_not found_"}`);
  lines.push(`- Brand name: ${bd?.brandName || "_not found_"}`);
  lines.push(`- Tagline: ${bd?.tagline || "_not found_"}`);
  lines.push("");
  lines.push("## Layout & Hierarchy");
  lines.push("");
  lines.push("- No layout signal available (site was not scraped).");
  lines.push("");
  return lines.join("\n");
}

/** Create (or reuse) the dedicated Knowledge Base task that holds design.md. */
async function ensureKbTask(userId: string, existingTaskId: string | undefined): Promise<string> {
  if (existingTaskId) {
    const existing = await taskDb.getTaskById(existingTaskId);
    if (existing && (existing as any).userId === userId) return existingTaskId;
    // Stale/foreign pointer — fall through and create a fresh task rather
    // than writing into a task that no longer exists or belongs to someone else.
  }
  const taskId = uuidv4();
  await taskDb.createTask({
    taskId,
    userId,
    name: "Website Design System",
    prompt: "",
    status: "active",
    createdAt: new Date().toISOString(),
    useKnowledgeBase: true,
    updateKnowledgeBase: true,
    knowledgeBaseType: "private",
  });
  return taskId;
}

async function scrapeDesignSystem(
  companyUrl: string,
  deps: Required<Pick<DesignSystemBuildDeps, "extractCSSFromURL" | "analyzeDesignTokens" | "inferBrandTokens" | "fetchHtml">>
): Promise<{
  brandIdentity: any;
  brandTokens: any;
  detailedTokens: any;
  layoutNotes: string[];
  pagesScanned: string[];
}> {
  const { extractCSSFromURL, analyzeDesignTokens, inferBrandTokens, fetchHtml } = deps;

  const homepage = await extractCSSFromURL(companyUrl);

  let secondaryUrls: string[] = [];
  try {
    const html = await fetchHtml(companyUrl);
    secondaryUrls = discoverSecondaryPageUrls(html, companyUrl);
  } catch {
    // Nav-link discovery is best-effort; homepage-only extraction still succeeds.
  }

  const pageResults = [homepage];
  for (const secondaryUrl of secondaryUrls) {
    try {
      pageResults.push(await extractCSSFromURL(secondaryUrl));
    } catch {
      // One secondary page failing must not fail the whole scrape.
    }
  }

  const tokensPerPage = await Promise.all(pageResults.map((p) => analyzeDesignTokens(p)));
  const detailedTokens = mergeDesignTokens(tokensPerPage);
  const brandTokens = inferBrandTokens(detailedTokens);

  return {
    brandIdentity: homepage.brandIdentity,
    brandTokens,
    detailedTokens,
    layoutNotes: buildLayoutNotes(homepage.computedElements),
    pagesScanned: pageResults.map((p) => p.url),
  };
}

async function completeWithManualFallback(
  userId: string,
  user: any,
  now: () => Date,
  updateKnowledgeBaseFile: UpdateKnowledgeBaseFileFn,
  scrapeError?: string
): Promise<void> {
  try {
    const taskId = await ensureKbTask(userId, user?.designSystem?.kbTaskId);
    const markdown = buildManualFallbackMarkdown(user, now().toISOString(), scrapeError);
    const writeResult = await updateKnowledgeBaseFile(
      taskId,
      "design.md",
      markdown,
      "replace",
      userId,
      "onboarding-design-system"
    );
    if (!writeResult?.success) {
      throw new Error(writeResult?.error || writeResult?.message || "failed to write fallback design.md");
    }
    const fresh = (await readUserForOwnership(userId)) as any;
    const patch = buildReadyPatch(fresh?.designSystem as DesignSystemFields | undefined, "manual_fallback" as DesignSystemSource, taskId, now());
    if (patch) await userDb.updateUser(userId, patch as any);
  } catch (fallbackErr: any) {
    // Both the real scrape AND the manual fallback failed (e.g. Knowledge Base
    // write itself is down). Terminal failure so the UI's retry button
    // surfaces instead of an infinite spinner.
    const fresh = (await readUserForOwnership(userId)) as any;
    const message = scrapeError
      ? `scrape failed (${scrapeError}); fallback also failed: ${fallbackErr?.message ?? String(fallbackErr)}`
      : `fallback failed: ${fallbackErr?.message ?? String(fallbackErr)}`;
    const patch = buildFailedPatch(fresh?.designSystem as DesignSystemFields | undefined, message, now());
    await userDb.updateUser(userId, patch as any);
  }
}

/**
 * Fire-and-forget orchestrator. The route flips `designSystem.status →
 * running` synchronously, then calls this. Tests can `await` the returned
 * promise to assert persisted state.
 */
export async function triggerDesignSystemBuildForUser(
  userId: string,
  deps: DesignSystemBuildDeps = {}
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? DESIGN_SYSTEM_TIMEOUT_MS;
  const extractCSSFromURL = deps.extractCSSFromURL ?? defaultExtractCSSFromURL;
  const analyzeDesignTokens = deps.analyzeDesignTokens ?? defaultAnalyzeDesignTokens;
  const inferBrandTokens = deps.inferBrandTokens ?? defaultInferBrandTokens;
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml;
  const updateKnowledgeBaseFile = deps.updateKnowledgeBaseFile ?? defaultUpdateKnowledgeBaseFile;

  const user = await readUserForOwnership(userId);
  if (!user) return;

  // brandGuidelines — the manual-fallback content source — is an
  // org-authoritative pillar (same as designSystem's own status). Reading
  // `user.brandGuidelines` directly misses it for any account whose brand
  // was saved onto the Organization record (the common case once an org
  // exists), producing an emptier fallback than the account actually has
  // data for. Resolve it the same way /api/auth/me does.
  const org = (user as any).orgId ? await orgDb.getOrgById((user as any).orgId) : null;
  const resolvedBrandGuidelines = await resolveOrgProfileField(user, org, "brandGuidelines");
  const effectiveUser = {
    ...(user as any),
    brandGuidelines: resolvedBrandGuidelines ?? (user as any).brandGuidelines,
  };

  const companyUrl = pickCompanyUrl(effectiveUser);
  if (!companyUrl) {
    await completeWithManualFallback(userId, effectiveUser, now, updateKnowledgeBaseFile, "no website URL on account");
    return;
  }

  try {
    const result = await withTimeout(
      scrapeDesignSystem(companyUrl, { extractCSSFromURL, analyzeDesignTokens, inferBrandTokens, fetchHtml }),
      timeoutMs,
      "design-system scrape"
    );
    const taskId = await ensureKbTask(userId, (user as any).designSystem?.kbTaskId);
    const markdown = assembleDesignMarkdown({ url: companyUrl, ...result, generatedAt: now().toISOString() });
    const writeResult = await updateKnowledgeBaseFile(
      taskId,
      "design.md",
      markdown,
      "replace",
      userId,
      "onboarding-design-system"
    );
    if (!writeResult?.success) {
      throw new Error(writeResult?.error || writeResult?.message || "failed to write design.md to Knowledge Base");
    }
    const fresh = (await readUserForOwnership(userId)) as any;
    const patch = buildReadyPatch(fresh?.designSystem as DesignSystemFields | undefined, "scrape" as DesignSystemSource, taskId, now());
    if (patch) await userDb.updateUser(userId, patch as any);
  } catch (e: any) {
    console.warn("[onboardingDesignSystemService] scrape failed, falling back to manual", {
      userId,
      error: e?.message ?? String(e),
    });
    await completeWithManualFallback(userId, effectiveUser, now, updateKnowledgeBaseFile, e?.message ?? String(e));
  }
}
