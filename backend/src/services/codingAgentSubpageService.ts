/**
 * Coding-agent sub-page engine.
 *
 * Cheap path for adding a page to an EXISTING landing-page site: instead of a fresh
 * v0 generation (which spends v0 credits and stands up new design from scratch), it
 * reuses the proven `runCodingAgent` loop to write a new `app/<slug>/page.tsx` into
 * the site's repo, matching the site's existing design. A sub-page is the ideal
 * coding-agent job — it riffs on an already-polished page in the same repo rather
 * than inventing a design, which is where v0's value (net-new design) isn't needed.
 *
 * Separate module (not in v0Service) to avoid a circular import: codingAgentService
 * imports v0Service, so v0Service reaches this module via a dynamic import.
 *
 * Flag-gated by CODING_AGENT_SUBPAGES; off = the v0 sub-page path is unchanged.
 */
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import { LANDING_PAGE_PREVIEW_BRANCH, runCodingAgent } from "./codingAgentService";
import { incrementUserTokenUsage } from "./tokenUsageService";
import { mcpFetch } from "../mcp/server/httpClient";
import { buildPageSlug } from "./v0Service";
import type { GeneratedLandingPage, BrandContext } from "./v0Service";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: { timeout: 30_000, connectTimeout: 5_000 },
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

/**
 * Model for net-new sub-page generation. Defaults to Opus 4.8 (the most capable
 * model) because page design quality matters here — overridable for cost tuning.
 * The coding agent's getClientForModel routes "anthropic.claude-opus-4-8" to the
 * Bedrock bearer-token client.
 */
const SUBPAGE_MODEL = process.env.CODING_AGENT_SUBPAGE_MODEL || "anthropic.claude-opus-4-8";

export interface AddPageViaCodingAgentOptions {
  leadListId?: string;
  originatingSessionId?: string;
}

/**
 * Add a page to an existing site using the coding agent (no v0 call). Creates the
 * page record, runs the agent against the site's repo to write the new route, and
 * maps the agent's verdict back onto the record.
 */
export async function addPageViaCodingAgent(
  site: GeneratedLandingPage,
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  opts: AddPageViaCodingAgentOptions = {}
): Promise<GeneratedLandingPage> {
  if (!site.githubRepoUrl) {
    throw new Error("addPageViaCodingAgent requires a site with a deployed GitHub repo");
  }

  const id = uuidv4();
  const slug = buildPageSlug(name);
  const now = new Date().toISOString();


  /*
   * Both halves or neither, decided ONCE and copied as a unit. An id without its label
   * fires a conversion that matches no conversion action — reported as fired, attributing
   * nothing — and the task instructions below are gated on the same pair, so a partial
   * copy would leave a record claiming tracking that is never wired.
   */
  const inheritedGoogleAds = site.googleAdsConversionId && site.googleAdsConversionLabel
    ? {
        googleAdsConversionId: site.googleAdsConversionId,
        googleAdsConversionLabel: site.googleAdsConversionLabel,
        ...(site.googleAdsCustomerId ? { googleAdsCustomerId: site.googleAdsCustomerId } : {}),
        ...(site.googleAdsTrackingInstalled !== undefined
          ? { googleAdsTrackingInstalled: site.googleAdsTrackingInstalled } : {}),
      }
    : undefined;

  const record: GeneratedLandingPage = {
    id,
    userId,
    name,
    prompt,
    status: "generating",
    iterations: 0,
    slug,
    githubRepoUrl: site.githubRepoUrl,
    vercelProjectId: site.vercelProjectId,
    // Belongs to the same site as the page it was added to.
    siteId: site.siteId ?? site.id,
    ...(opts.originatingSessionId ? { originatingSessionId: opts.originatingSessionId } : {}),
    ...(opts.leadListId ? { leadListId: opts.leadListId } : {}),
    // A conversion is site-wide by construction (shared root layout), so this page
    // inherits the site's pair rather than resolving its own — the same rule addSubPage
    // follows. Carried onto the record so RULE 7.5 and the offline import (ENG-1325) can
    // read it off ANY page of the site (ENG-1328).
    //
    // Copied as ONE unit, from a pair validated once above. Copying the id and label
    // independently would persist half a pair when the site record holds only one — and
    // the task instructions, which require both, would then be omitted for that same
    // page: a record advertising a conversion id that nothing ever fires.
    ...(inheritedGoogleAds ?? {}),
    createdAt: now,
    updatedAt: now,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  // Best practice for agentic code generation: never commit unverified LLM output
  // to the production branch. Stage the agent's edits on the reusable preview branch;
  // the agent builds and self-verifies on that branch's Vercel preview
  // (check_deployment), and we promote to main ONLY on a green build — so the live
  // site is never broken by a bad generation.
  const draftBranch = LANDING_PAGE_PREVIEW_BRANCH;
  // Same pair the record inherited — derived once above, so the instructions and the
  // persisted metadata can never disagree about whether this page is tracked.
  const googleAds = inheritedGoogleAds
    ? {
        conversionId: inheritedGoogleAds.googleAdsConversionId,
        conversionLabel: inheritedGoogleAds.googleAdsConversionLabel,
      }
    : undefined;
  const task = buildSubPageTask(slug, name, prompt, brandContext, opts.leadListId, googleAds);

  try {
    const result = await runCodingAgent(task, {
      pageId: id,
      userId,
      sessionId: opts.originatingSessionId || `subpage-${id}`,
      llmModel: SUBPAGE_MODEL,
      draftBranch,
    });

    // Charge this sub-page run's own LLM turns to the caller's monthly usage. The
    // coding loop makes its own (often high-cost Opus) calls that no parent meter
    // sees, so without this its spend escapes the per-user token/cost cap (ENG-200).
    // Charged whether the build went green or not — the turns cost money either way.
    // Fire-and-forget + fail-open: metering must never fail/slow sub-page generation.
    if (result.usageTotals) {
      const { totalTokens, costUsd } = result.usageTotals;
      incrementUserTokenUsage(userId, totalTokens, costUsd).catch((err: unknown) =>
        console.error("addPageViaCodingAgent: failed to record per-user usage:", err)
      );
    }

    if (!result.success) {
      // Build never went green on the preview — main is untouched.
      await updateRecordOutcome(id, "failed", result.previewUrl, result.message);
      return {
        ...record,
        status: "failed",
        ...(result.previewUrl ? { deployedUrl: result.previewUrl } : {}),
        errorMessage: result.message,
      };
    }

    // Verified green on the preview → promote the draft to main (page goes live).
    try {
      const pub = await mcpFetch({
        method: "POST",
        path: `/api/landing-pages/v0/generated/${id}/publish`,
        context: { userId },
        body: { branch: draftBranch },
      });
      const liveUrl = pub?.live_url || pub?.deployed_url || result.previewUrl;
      await updateRecordOutcome(id, "deployed", liveUrl, undefined);
      return { ...record, status: "deployed", ...(liveUrl ? { deployedUrl: liveUrl } : {}) };
    } catch (pubErr: any) {
      // Built and verified on the preview, but the merge to main failed. Leave it as
      // a draft (preview URL) — main stays untouched and it can be re-published.
      const message = `Built on preview but publish to main failed: ${pubErr?.message || "unknown error"}`;
      await updateRecordOutcome(id, "draft", result.previewUrl, message).catch(() => {});
      return {
        ...record,
        status: "draft",
        ...(result.previewUrl ? { deployedUrl: result.previewUrl } : {}),
        errorMessage: message,
      };
    }
  } catch (err: any) {
    const message = err?.message || "Coding-agent sub-page generation failed";
    await updateRecordOutcome(id, "failed", undefined, message).catch(() => {});
    return { ...record, status: "failed", errorMessage: message };
  }
}

async function updateRecordOutcome(
  id: string,
  status: GeneratedLandingPage["status"],
  deployedUrl?: string,
  errorMessage?: string
): Promise<void> {
  const sets = ["#status = :status", "updatedAt = :now"];
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, any> = { ":status": status, ":now": new Date().toISOString() };
  if (deployedUrl) {
    sets.push("deployedUrl = :url");
    values[":url"] = deployedUrl;
  }
  if (errorMessage) {
    sets.push("errorMessage = :err");
    values[":err"] = errorMessage.slice(0, 1000);
  }
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET " + sets.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
    .promise();
}

/**
 * The agent's task. Prescriptive and reference-first (Anthropic best practice: tell
 * the agent WHEN/HOW, not just what): read the existing site design first, match it
 * exactly, then build the new route, then verify the build before reporting.
 */
export function buildSubPageTask(
  slug: string,
  name: string,
  prompt: string,
  brand: BrandContext,
  leadListId?: string,
  googleAds?: { conversionId: string; conversionLabel: string }
): string {
  const brandLines = summarizeBrand(brand);
  const formLine = leadListId
    ? `- The lead-capture form on this page MUST submit to lead list "${leadListId}". Mirror exactly how the existing site's home-page form is wired (same endpoint/handler) — read it first, don't invent a new one.`
    : `- If the page has a lead-capture form, wire it the same way the existing site's home page wires its form. Read the home page first to see how.`;

  return [
    `Add a NEW page to this existing, already-deployed landing-page site. Create the route at app/${slug}/page.tsx (page name: "${name}").`,
    ``,
    `STEP 1 — Learn the existing design (do this first).`,
    `Use list_files to see the repo, then read_file on the site's home page (app/page.tsx), its layout (app/layout.tsx), and any shared component/style files it imports. The new page MUST look like it belongs to this site: reuse the same fonts, colors, spacing, components, and tone. Do NOT introduce a new design language or new dependencies.`,
    ``,
    `STEP 2 — Build the page.`,
    `Create app/${slug}/page.tsx as a complete, production-quality Next.js/React page implementing this brief:`,
    ``,
    prompt,
    ``,
    brandLines,
    formLine,
    // Both halves checked again here rather than trusted from the caller: this function
    // is exported and directly tested, and a half-empty pair would emit an instruction
    // naming a conversion that can never match a conversion action.
    //
    // Until now this path relied entirely on "mirror the home page's form" to carry the
    // tracking call across. That works when it works, but it is inference: the agent can
    // reasonably build a clean form and drop the call, and nothing would notice until a
    // campaign reported zero conversions. Naming the requirement — and the exact pair —
    // removes the guesswork (ENG-1328).
    ...(googleAds?.conversionId && googleAds?.conversionLabel ? [
      `- This site has Google Ads conversion tracking. On a SUCCESSFUL form submission the page MUST call `
      + `fireLeadTracking({ email, eventId, googleAds: { conversionId: "${googleAds.conversionId}", `
      + `conversionLabel: "${googleAds.conversionLabel}" } }) — imported from "@/lib/agentweb-track", exactly as the `
      + `home page's form does. Generate eventId ONCE per submit with crypto.randomUUID() and send the same value `
      + `as an "eventId" field in the /api/capture body.`,
      `- Do NOT hand-author a gtag() call and do NOT call gtag('config', ...) — the base tag is already installed `
      + `in the shared root layout, and fireLeadTracking fires the conversion correctly, in the right order, `
      + `before any redirect. Dropping this call means the page captures leads that report no conversion.`,
    ] : []),
    `- Write real, specific copy from the brief — no lorem ipsum, no [PLACEHOLDER] text.`,
    `- Self-contained and consistent with the existing components; prefer reusing the site's components over writing new ones.`,
    ``,
    `STEP 3 — Verify before you finish.`,
    `Call check_deployment to confirm the build passes. If it fails, read the error, fix the page, and check again. Only when the build is green, call report_to_user with the live route and a one-line summary. Do not report success on a failing build.`,
  ].join("\n");
}

function summarizeBrand(brand: BrandContext): string {
  if (!brand || Object.keys(brand).length === 0) {
    return `- No brand context was provided; match the existing site's visual style as the source of truth.`;
  }
  const parts: string[] = [];
  if (brand.brandName) parts.push(`brand "${brand.brandName}"`);
  if (brand.primaryColor) parts.push(`primary color ${brand.primaryColor}`);
  if (brand.fontFamily) parts.push(`font ${brand.fontFamily}`);
  if (brand.toneOfVoice) parts.push(`tone ${brand.toneOfVoice}`);
  const summary = parts.length ? parts.join(", ") : "see the existing site";
  return `- Brand: ${summary}. The existing site's design is the source of truth — prefer it over these values where they conflict.`;
}
