/**
 * Onboarding Epic Phase 2 — Ad image service (Brick 8 / Step 5).
 *
 * Step 5 of the B2B lead-gen ads work plan (`plan_1768351741814_jgc2wwlxa`).
 * Bridges from creative direction (Step 4) to image generation by constructing
 * Brick 8 6-layer Gemini Pro prompts and calling `imageService.generateImage`
 * once per variant.
 *
 * Flow:
 *   1. Wait for `creativeDirStatus === 'ready'`.
 *   2. Project brand context (colors / typography / logo / company info)
 *      from the User record's `brandGuidelines.brandData`.
 *   3. Pull chosen creative-direction concepts and format archetypes.
 *   4. For each of 3 variants: build a 6-layer Brick 8 prompt
 *      (FORMAT / SETTING / FOCAL POINT / TEXT / BADGE / STYLE).
 *   5. Run all 3 image-generation calls in parallel via `Promise.all`.
 *   6. Apply a hard per-variant timeout — slow variants get a placeholder
 *      URL and the run still ships ready so the UI can render.
 *   7. Patch the User via `adImageReadyPatch({ variants: [...] })`.
 *
 * Same fire-and-forget orchestration pattern as the other onboarding
 * services (icp / competitor / creative-dir / ad-copy). The route layer
 * wraps with `adImageStartPatch` synchronously and launches the background
 * work via `startAdImageGenerationForUser`.
 *
 * The system prompt is the verbatim Step 5 description from the prod work
 * plan. Do NOT rewrite it locally — if Step 5 changes, update the prod plan
 * via `manage_predefined_work_plan` and re-pull. The unit test asserts the
 * prompt contains "BRICK 8" + the 6 LAYER markers from the prod copy.
 *
 * Verbatim prompt source:
 *   aws dynamodb get-item --table-name AW-WorkPlans --region us-west-2 \
 *     --key '{"planId":{"S":"plan_1768351741814_jgc2wwlxa"}}'
 *   then read steps[4].description.
 */

import { imageService as defaultImageService } from "./imageGeneration";
import { reportUIError } from "../utils/errorReporter";
import { userDb } from "./db";
import {
  DEFAULT_IMAGE_STYLE_SPEC,
  DEFAULT_IMAGE_HARD_CONSTRAINTS,
  type GlobalImageDirectives,
} from "./imagePromptDefaults";
import {
  adImageFailedPatch,
  adImageReadyPatch,
  adImageStartPatch,
  AdImageResult,
  AdImageStatusFields,
  AdImageVariant,
} from "./adImageStatusService";
import {
  extractIcpBrandContext,
  IcpBrandContext,
} from "./onboardingIcpService";
import { getPersistedBrandLogoUrl } from "./agentMode/brandLogo";
import type { ICPPersona } from "./icpStatusService";
import type { CreativeDirResult } from "./creativeDirStatusService";
import {
  ARCHETYPES,
  AESTHETIC_RULES,
  DEFAULT_VARIANT_ARCHETYPES,
  resolveArchetype,
  type Aesthetic,
  type Archetype,
} from "./brick5Archetypes";

/** Number of ad image variants per run. Brick 8 spec is "3 per ICP". */
const AD_IMAGE_VARIANT_COUNT = 3;

/** 60% of variants are square (1080x1080), 40% vertical (1080x1350). */
type AdImageFormat = "1080x1080" | "1080x1350";

/** Hard per-variant timeout. Beyond this we patch with placeholder. */
const PER_VARIANT_TIMEOUT_MS = 180_000;

/** Default Gemini Pro image model — supports 1080x1080 + 1080x1350. */
const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";

/** Placeholder URL marker — frontend renders a CSS gradient when it sees this. */
const PLACEHOLDER_URL = "placeholder://ad-image-failed";

/** Default brand color when none is captured yet — neutral charcoal. */
const DEFAULT_PRIMARY_COLOR = "#1A1A2E";

/** Default font family — system sans-serif. */
const DEFAULT_FONT_FAMILY = "Inter";

/**
 * Brand visual context — extends `IcpBrandContext` with the visual fields
 * needed by Brick 8 (colors, typography, logo). Projected from
 * `brandGuidelines.brandData` on the User record.
 */
export interface AdImageBrandContext extends IcpBrandContext {
  primaryColor?: string;
  secondaryColor?: string;
  fontFamily?: string;
  logoUrl?: string;
}

/**
 * Step 5 system prompt — VERBATIM from prod work plan
 * `plan_1768351741814_jgc2wwlxa`, steps[4].description (Brick 8: Gemini Pro
 * Image Prompts). Sourced via:
 *   aws dynamodb get-item --table-name AW-WorkPlans --region us-west-2 \
 *     --key '{"planId":{"S":"plan_1768351741814_jgc2wwlxa"}}'
 *
 * The descriptive content is unchanged. We treat this as the SYSTEM PROMPT
 * for prompt-construction guidance — every per-variant user prompt that we
 * pass to Gemini is built to match this 6-layer schema.
 */
export const AD_IMAGE_SYSTEM_PROMPT = [
  "## BRICK 8: GEMINI PRO IMAGE PROMPTS",
  "## Overview",
  "Brick 8 transforms the strategic ad variants from Brick 6 into production-ready image generation prompts for Gemini Pro. Each prompt is a comprehensive, single-prompt specification that defines every visual element of the final creative.",
  "## When to Execute",
  "Brick 8 is executed AFTER Bricks 1-7 are complete. It requires:",
  "- Brand DNA (Brick 1) for colors, typography, logo rules",
  "- ICP profiles (Brick 2) for audience-specific visual resonance",
  "- Creative Direction + Format Archetypes (Brick 5) for visual strategy",
  "- Top-priority ad variants (Brick 6) for the specific copy to render",
  "- User aesthetic preferences captured in Brick 1",
  "## Prompt Architecture",
  "Every Gemini prompt MUST contain ALL of the following components in this exact order. Incomplete prompts produce inconsistent results.",
  "### The 6 Layers (in order)",
  "LAYER 1: FORMAT & DIMENSIONS",
  '  "Create a [photography type / illustration style] Facebook ad [width]x[height]px."',
  "  Common formats:",
  "  Only consider formats in these the two porportions with the following frequency 60%/40%:",
  "  - 1080x1080px (Meta Feed — square)",
  "  - 1080 x 1350px (Story/Reel — vertical)",
  "LAYER 2: BACKGROUND / SETTING",
  '  "SETTING: [Ultra-specific scene description]"',
  "  Include:",
  "  - Primary environment (e.g., 'light-mode code editor interface')",
  "  - Background element (e.g., 'blurred mountain landscape through frosted glass')",
  "  - Lighting details with color temperature (e.g., 'warm morning light, golden hour')",
  "  - Composition angle (e.g., 'shot from directly above,' 'slight perspective tilt')",
  "  - Atmospheric details (e.g., 'soft shadows, clean negative space')",
  "LAYER 3: SUBJECT / FOCAL POINT",
  '  "FOCAL POINT: [Exact subject positioning and content]"',
  "  Include:",
  "  - What the viewer's eye hits FIRST",
  "  - Exact text that appears on any UI elements, screens, or cards",
  "  - Data/numbers that appear in dashboards or charts",
  "  - Spatial relationships between elements",
  "  - Color coding of specific elements (e.g., 'green checkmarks,' 'red overdue badges')",
  "LAYER 4: TEXT OVERLAYS",
  '  "TEXT OVERLAY at [position] in [font family] [weight] ([color with hex code]):',
  "  '[Exact Headline Text]'\"",
  "  Rules:",
  "  - Always specify exact font, weight, size, color, and position",
  "  - Headline: top or top-center, bold, large (28-48pt)",
  "  - Subheadline: below headline or bottom, regular weight, smaller (18-24pt)",
  "  - Use hex codes for every color reference",
  "LAYER 5: BADGE / CTA + COLOR & BRAND",
  "  Include ALL of:",
  "  - CTA button: position, text, background color, text color, shape",
  "  - Logo: exact placement (top-left standard), size in px, light/dark version",
  "  - Trust badges: YC badge, customer logos, certification marks",
  "  - Supplementary text: 'Free,' 'No card required,' etc.",
  "LAYER 6: STYLE SPECIFICATION",
  '  "[Photography/illustration style]. [Brand aesthetic]. [Lighting treatment]."',
  "  End with:",
  "  - Overall mood/feeling summary",
  "  - What this should NOT look like",
  "  - Explicit format confirmation (e.g., '1080x1080 square format')",
].join("\n");

/**
 * Pick the format split across N variants — 60% square, 40% vertical, with
 * the floor going to square when fractions don't divide cleanly.
 *
 * For N=3: 2 squares + 1 vertical (60/40 rounded).
 * For N=2: 1 square + 1 vertical.
 * For N=1: 1 square (60% wins the tiebreak).
 */
export function pickFormatSplit(n: number): AdImageFormat[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  const squares = Math.max(1, Math.round(n * 0.6));
  const verticals = n - squares;
  const out: AdImageFormat[] = [];
  for (let i = 0; i < squares; i++) out.push("1080x1080");
  for (let i = 0; i < verticals; i++) out.push("1080x1350");
  return out;
}

/**
 * Inputs to the per-variant prompt builder. Exposed for unit testing.
 */
export interface SixLayerPromptInputs {
  variantIndex: number;
  format: AdImageFormat;
  concept: string;
  copyAngle: string;
  formatArchetype: string;
  brand: AdImageBrandContext;
  persona: ICPPersona | undefined;
}

/**
 * Identifier baked into every generated variant so we can tell which
 * version of the prompt produced which image. Bumped manually when the
 * brick templates or layer construction changes. Eventually moves to
 * DynamoDB so the partner portal can edit + version prompts without a
 * deploy.
 */
export const PROMPT_BUILDER_VERSION = "v2-brick5-2026-04-26";

/**
 * Default aesthetic when none is captured on the brand. We pick
 * "minimal-typographic" because it's the safest fit for most brands and
 * Gemini renders bold typography flawlessly. Heuristic upgrade path:
 * derive aesthetic from brand category in Brick 1.
 */
const DEFAULT_AESTHETIC: Aesthetic = "minimal-typographic";

/**
 * Build the Brick 8 6-layer prompt for a single variant. Pure — no I/O.
 *
 * The prompt is the brick's archetype LAYOUT STRUCTURE + TEXT BUDGET
 * injected verbatim, with brand context (colors, font, company name,
 * tagline, logo URL) substituted as variables. The TEXT BUDGET is the
 * primary mechanism that keeps Gemini from rendering full AI-paragraph
 * subheadlines onto the canvas — it tells the model exactly how many
 * text elements are allowed and how many words each can contain.
 *
 * Why we don't pass the long copy angle as a subheadline anymore: every
 * archetype's TEXT BUDGET caps subheadlines at 5-10 words. Passing the
 * full copy angle (often 20-40 words) was the bug that produced the
 * "Your checkout is leaking revenue right now — every declined card,
 * every abandoned cart, every manual payout..." rendered onto the image.
 */
export function buildSixLayerPromptForVariant(
  inputs: SixLayerPromptInputs,
  /**
   * Optional template override loaded from DynamoDB by the orchestrator.
   * When present, layout + budget come from the row (admin-edited via
   * the partner portal). When absent, we fall back to the constants —
   * this keeps unit tests pure (no DB mocking required) and gives us a
   * safe default when DynamoDB is unreachable. The caller's
   * responsibility to bump promptVersion when they pass a template.
   */
  template?: {
    feedLayout: string;
    storyLayout: string;
    textBudget: string;
    name: string;
  },
  /**
   * Optional extras:
   *  - negativeExamples: visual directions distilled from the user's recent
   *    image rejects (♥/✕). Appended as a dedicated block so the model steers
   *    away from disliked concepts. Empty (default) keeps the first run clean.
   *  - globalDirectives: runtime-overridable style spec + hard constraints
   *    (WS1a). Absent fields fall back to the DEFAULT_IMAGE_* constants so the
   *    rendered prompt is byte-identical until the managed row is edited.
   */
  opts: {
    negativeExamples?: string;
    globalDirectives?: GlobalImageDirectives;
  } = {},
): string {
  const negativeExamples = opts.negativeExamples ?? "";
  const styleSpec = opts.globalDirectives?.styleSpec ?? DEFAULT_IMAGE_STYLE_SPEC;
  const hardConstraints =
    opts.globalDirectives?.hardConstraints ?? DEFAULT_IMAGE_HARD_CONSTRAINTS;
  const { variantIndex, format, concept, copyAngle, formatArchetype, brand, persona } =
    inputs;
  const archetypeId: Archetype = resolveArchetype(formatArchetype, variantIndex);
  const archetypeConst = ARCHETYPES[archetypeId];
  const archetype = template ?? archetypeConst;
  const aestheticRules = AESTHETIC_RULES[DEFAULT_AESTHETIC];

  const companyName = brand.companyName || "Your brand";
  const primaryColor = brand.primaryColor || DEFAULT_PRIMARY_COLOR;
  const secondaryColor = brand.secondaryColor || "#FFFFFF";
  const fontFamily = brand.fontFamily || DEFAULT_FONT_FAMILY;
  const tagline = brand.tagline || brand.valueProposition || "";
  const personaPain = persona?.pain || "";

  const isFeed = format === "1080x1080";
  const layoutBlock = isFeed ? archetype.feedLayout : archetype.storyLayout;

  const lines: string[] = [];

  lines.push(`# Brick 8 — Gemini Pro image prompt (variant ${variantIndex + 1})`);
  lines.push(`# Prompt version: ${PROMPT_BUILDER_VERSION}`);
  lines.push(`# Archetype: ${archetypeConst.id} — ${archetype.name}`);
  lines.push(`# Concept: ${concept || "(none)"}`);
  lines.push(`# Copy angle: ${copyAngle || "(none)"}`);
  lines.push(``);

  // Layer 1 — FORMAT & DIMENSIONS (verbatim brick template)
  lines.push(`LAYER 1: FORMAT & DIMENSIONS`);
  lines.push(
    isFeed
      ? `Create a photorealistic square Meta Feed ad — 1080x1080px. Aspect ratio 1:1.`
      : `Create a photorealistic portrait Story/Reel Meta ad — 1080x1350px. Aspect ratio 4:5.`,
  );
  lines.push(``);

  // Layer 2 — BACKGROUND / SETTING
  // Aesthetic rules govern background choices. The archetype's layout
  // block (Layer 3) constrains composition — Layer 2 just sets the
  // visual world.
  lines.push(`LAYER 2: BACKGROUND / SETTING`);
  lines.push(aestheticRules);
  lines.push(``);
  lines.push(
    `Brand color anchors: primary ${primaryColor}, secondary ${secondaryColor}. ` +
      `Lighting: soft directional, natural color temperature. ` +
      `No clutter; high signal-to-noise.`,
  );
  lines.push(``);

  // Layer 3 — SUBJECT / FOCAL POINT (verbatim archetype LAYOUT STRUCTURE)
  // This is the layer that previously caused gibberish. By using the
  // archetype's exact layout instead of "render a UI screenshot or
  // dashboard or chart or workspace", we constrain the image so Gemini
  // doesn't have to invent UI text.
  lines.push(`LAYER 3: SUBJECT / FOCAL POINT — Archetype ${archetypeConst.id} layout (${archetype.name})`);
  lines.push(layoutBlock);
  if (personaPain) {
    lines.push(``);
    lines.push(
      `Emotional anchor: this ad targets the pain "${personaPain}". The focal-point composition above should evoke that pain visually within the archetype's structure. Do NOT render the pain text on the canvas — it lives in the Meta primary text shown above the image.`,
    );
  }
  lines.push(``);

  // Layer 4 — TEXT OVERLAYS (governed by the archetype's TEXT BUDGET)
  // The brand text we pass through is intentionally minimal — only what
  // the archetype's text budget allows. Long copy belongs to the Meta
  // primary text rendered ABOVE the image by Meta itself, not on the
  // canvas. The TEXT BUDGET below is the verbatim brick rule that
  // Gemini must respect.
  lines.push(`LAYER 4: TEXT OVERLAYS`);
  lines.push(archetype.textBudget);
  lines.push(``);
  if (tagline) {
    lines.push(
      `Headline source material (use within the budget above; condense if needed): "${tagline}". ` +
        `Render in ${fontFamily} bold (${primaryColor}). ` +
        `If the budget says no headline (e.g. archetype A or K), ignore this and follow the budget.`,
    );
  }
  lines.push(``);

  // Layer 5 — BADGE / CTA + COLOR & BRAND
  // When `brand.logoUrl` is set we pass the actual logo as an image input
  // alongside this prompt (see generateWithTimeout → logoImage). The
  // imageGeneration service auto-injects a strict "reproduce with
  // absolute precision, do not restyle" instruction. We only need to
  // tell the model WHERE to place it; the WHAT comes from the image.
  // Fallback path (no logoUrl) renders a typographic wordmark instead.
  const logoLine = brand.logoUrl
    ? `Place the provided logo image (the official mark for ${companyName}, passed as an image input alongside this prompt) at the position the archetype specifies (top-left default). Use a light variant on dark backgrounds and a dark variant on light backgrounds. Reproduce the logo exactly as provided — do NOT redraw, restyle, recolor, or reinterpret it.`
    : `Brand wordmark "${companyName}" rendered in ${fontFamily} bold (${primaryColor}) at the position the archetype specifies (top-left default).`;
  lines.push(`LAYER 5: BADGE / CTA + COLOR & BRAND`);
  lines.push(logoLine);
  lines.push(
    `CTA button (if archetype permits one): rounded rectangle, ${primaryColor} background, ${secondaryColor} text, ` +
      `text "Learn more" in ${fontFamily} bold. Position per archetype layout.`,
  );
  lines.push(``);

  // Layer 6 — STYLE SPECIFICATION (lead from managed directives; the
  // format-confirmation sentence stays dynamic).
  lines.push(`LAYER 6: STYLE SPECIFICATION`);
  lines.push(
    `${styleSpec} Format confirmation: ${format} ${isFeed ? "square" : "vertical"} format.`,
  );
  lines.push(``);

  // Negative examples — the user's recent rejects, distilled into visual
  // directions to avoid. Placed just before HARD CONSTRAINTS so it carries
  // weight without being buried mid-prompt. Skipped on the first run.
  const trimmedNegatives = negativeExamples.trim();
  if (trimmedNegatives) {
    lines.push(``);
    lines.push(trimmedNegatives);
    lines.push(``);
  }

  // Final reminder — Gemini sometimes ignores text-budget rules without
  // an explicit re-statement. This catches the common failure mode. The
  // block comes from the managed directives (default = DEFAULT_IMAGE_HARD_
  // CONSTRAINTS), pushed as one block — identical output to the prior
  // four separate line pushes after lines.join("\n").
  lines.push(`HARD CONSTRAINTS:`);
  lines.push(hardConstraints);

  return lines.join("\n");
}

/**
 * Project the AdImageBrandContext from the persisted User record.
 * Extends `extractIcpBrandContext` with the visual fields Brick 8 needs.
 */
export function extractAdImageBrandContext(user: any): AdImageBrandContext {
  const base = extractIcpBrandContext(user || {});
  const bd = user?.brandGuidelines?.brandData || {};
  const ctx: AdImageBrandContext = { ...base };
  if (typeof bd.primaryColor === "string" && bd.primaryColor) {
    ctx.primaryColor = bd.primaryColor;
  }
  if (typeof bd.secondaryColor === "string" && bd.secondaryColor) {
    ctx.secondaryColor = bd.secondaryColor;
  }
  if (typeof bd.fontFamily === "string" && bd.fontFamily) {
    ctx.fontFamily = bd.fontFamily;
  }
  // Shared ENG-326 resolution: attachments `logo` asset (the store the brand
  // config UI + updateBrandGuidelines actually write) → brandData.logoUrl →
  // legacy brandAssets with a logo-ish type.
  const persistedLogo = getPersistedBrandLogoUrl(user?.brandGuidelines);
  if (persistedLogo) {
    ctx.logoUrl = persistedLogo;
  }
  // Ad-image-only legacy fallback: some old records carry the logo on
  // `brandAssets` typed as plain "image", which the shared resolver ignores.
  const assets = Array.isArray(user?.brandGuidelines?.brandAssets)
    ? user.brandGuidelines.brandAssets
    : [];
  if (!ctx.logoUrl) {
    for (const a of assets) {
      const url = typeof a?.url === "string" ? a.url : "";
      const type = typeof a?.type === "string" ? a.type.toLowerCase() : "";
      if (url && (type.includes("logo") || type === "image")) {
        ctx.logoUrl = url;
        break;
      }
    }
  }
  return ctx;
}

/** Image generator interface — `imageService.generateImage`-compatible. */
export interface AdImageGeneratorDep {
  generateImage: (params: {
    prompt: string;
    filename: string;
    userId: string;
    size?: string;
    imageModel?: string;
    /**
     * URL of the brand logo to condition the generation on. When provided,
     * `imageService.generateImage` adds the logo as a real image input
     * (alongside the text prompt) and injects a strict "reproduce with
     * absolute precision, do NOT restyle" instruction. Fixes the previous
     * pattern where the URL was passed as a string in the text prompt and
     * the diffusion model just hallucinated a logo because it can't fetch
     * URLs from text.
     */
    logoImage?: string;
  }) => Promise<{
    success: boolean;
    imageUrl?: string;
    filename?: string;
    error?: string;
  }>;
}

/**
 * Wrap a generator call with a hard per-variant timeout. On timeout we
 * resolve with a `success: false` shape so the orchestrator treats it the
 * same as any other failure (placeholder).
 */
async function generateWithTimeout(
  gen: AdImageGeneratorDep,
  prompt: string,
  filename: string,
  userId: string,
  format: AdImageFormat,
  timeoutMs: number,
  logoUrl?: string
): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      gen.generateImage({
        prompt,
        filename,
        userId,
        size: format,
        imageModel: DEFAULT_IMAGE_MODEL,
        ...(logoUrl ? { logoImage: logoUrl } : {}),
      }),
      new Promise<{ success: boolean; error: string }>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              success: false,
              error: `image generation timed out after ${Math.round(
                timeoutMs / 1000
              )}s`,
            }),
          timeoutMs
        );
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pure parallel image-generation loop. Builds the 6-layer prompt for each
 * variant, fires `Promise.all`, and folds failures into placeholders so the
 * run still ships with N variants.
 *
 * Exported for unit-testing with an injected fake image generator.
 */
export async function generateAdImagesForUser(
  creativeDir: CreativeDirResult,
  brand: AdImageBrandContext,
  personas: ICPPersona[],
  userId: string,
  deps: {
    imageGen?: AdImageGeneratorDep;
    timeoutMs?: number;
    /**
     * Inject a template loader for tests so we don't need a real Dynamo
     * connection. Defaults to `getTemplateForArchetype` from the
     * promptTemplatesService — which falls back to brick5Archetypes
     * constants if Dynamo is unreachable, so even prod is degraded-OK.
     */
    loadTemplate?: (
      archetype: Archetype,
    ) => Promise<{
      feedLayout: string;
      storyLayout: string;
      textBudget: string;
      name: string;
      version: string;
    }>;
    /**
     * Negative visual directions distilled from the user's recent image
     * rejects. Threaded into every variant's prompt so a regen steers
     * away from disliked concepts. Empty on the first generation.
     */
    negativeExamples?: string;
    /**
     * Runtime-overridable global directives (style spec + hard constraints).
     * If provided, used directly. If absent, loaded via loadGlobalDirectives
     * (default = the managed store). A load failure degrades to the
     * DEFAULT_IMAGE_* constants (byte-identical) — never blocks generation.
     */
    globalDirectives?: GlobalImageDirectives;
    /** Inject the directives loader for tests. Defaults to the managed store. */
    loadGlobalDirectives?: () => Promise<GlobalImageDirectives>;
  } = {}
): Promise<AdImageResult> {
  const gen = deps.imageGen ?? (defaultImageService as AdImageGeneratorDep);
  const negativeExamples = deps.negativeExamples ?? "";
  let globalDirectives = deps.globalDirectives;
  if (!globalDirectives) {
    try {
      const loadGlobalDirectives =
        deps.loadGlobalDirectives ??
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getGlobalImageDirectives } = require("./promptTemplatesService");
          const row = await getGlobalImageDirectives();
          return { styleSpec: row.styleSpec, hardConstraints: row.hardConstraints };
        });
      globalDirectives = await loadGlobalDirectives();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[onboardingAdImageService] global directives load failed; using constants",
        { error: e instanceof Error ? e.message : String(e) },
      );
      globalDirectives = undefined; // builder falls back to DEFAULT_IMAGE_*
    }
  }
  const timeoutMs = deps.timeoutMs ?? PER_VARIANT_TIMEOUT_MS;
  const loadTemplate =
    deps.loadTemplate ??
    (async (a: Archetype) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getTemplateForArchetype } = require("./promptTemplatesService");
      return getTemplateForArchetype(a);
    });

  const formats = pickFormatSplit(AD_IMAGE_VARIANT_COUNT);
  const concepts =
    creativeDir.concepts.length > 0
      ? creativeDir.concepts
      : ["VISCERAL MOMENT (VM)", "TRANSFORMATION (TR)", "SOCIAL PROOF (SP)"];
  const copyAngles =
    creativeDir.copy_angles.length > 0
      ? creativeDir.copy_angles
      : ["PA", "OV", "SPL"];
  const archetypes =
    creativeDir.format_archetypes.length > 0
      ? creativeDir.format_archetypes
      : ["A", "B", "C"];

  // Build tasks in parallel — we may need to fetch template rows from
  // Dynamo, and there's no point doing those serially.
  const tasks = await Promise.all(
    formats.map(async (format, i) => {
      const concept = concepts[i % concepts.length];
      const copyAngle = copyAngles[i % copyAngles.length];
      const formatArchetypeRaw = archetypes[i % archetypes.length];
      const archetype = resolveArchetype(formatArchetypeRaw, i);
      const persona = personas[i % Math.max(personas.length, 1)] || undefined;
      // Hydrate the template from Dynamo (or constants fallback). The
      // version string from the loaded row gets stamped on the variant
      // for prompt-quality attribution.
      let template:
        | {
            feedLayout: string;
            storyLayout: string;
            textBudget: string;
            name: string;
            version: string;
          }
        | undefined;
      try {
        template = await loadTemplate(archetype);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          "[onboardingAdImageService] template load failed; using constants",
          {
            archetype,
            error: e instanceof Error ? e.message : String(e),
          },
        );
      }
      const prompt = buildSixLayerPromptForVariant(
        {
          variantIndex: i,
          format,
          concept,
          copyAngle,
          formatArchetype: archetype,
          brand,
          persona,
        },
        template,
        { negativeExamples, globalDirectives },
      );
      const filename = `ad-image-${userId}-${i + 1}-${Date.now()}.png`;
      const promptVersion =
        template?.version ?? PROMPT_BUILDER_VERSION;
      return { prompt, filename, format, index: i, archetype, concept, promptVersion };
    }),
  );

  const results = await Promise.all(
    tasks.map(async (t) => {
      const r = await generateWithTimeout(
        gen,
        t.prompt,
        t.filename,
        userId,
        t.format,
        timeoutMs,
        brand.logoUrl
      );
      const variant: AdImageVariant = {
        id: `variant-${t.index + 1}`,
        imageUrl:
          r.success && r.imageUrl ? r.imageUrl : `${PLACEHOLDER_URL}#${t.index + 1}`,
        prompt: t.prompt,
        // Combine the builder version + template version so signals can
        // distinguish "same template text, new builder logic" from
        // "same builder, edited template text" when iterating.
        promptVersion: `${PROMPT_BUILDER_VERSION}/${t.promptVersion}`,
        archetype: t.archetype,
        concept: t.concept,
      };
      if (!r.success) {
        // eslint-disable-next-line no-console
        console.warn(
          `[onboardingAdImageService] variant ${t.index + 1} failed: ${r.error}`
        );
      }
      return variant;
    })
  );

  return { variants: results };
}

/**
 * Fire-and-forget orchestrator. Reads the User record, gates on
 * `creativeDirStatus === 'ready'`, runs the parallel image-generation loop,
 * and patches the User with the result.
 *
 * If creative direction isn't ready, fails the run with a clear error so
 * the UI can render the "waiting for creative direction" state.
 */
export async function triggerAdImageGenerationForUser(
  userId: string,
  deps: { imageGen?: AdImageGeneratorDep; timeoutMs?: number } = {}
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) return;

  const u = user as any;
  const creativeDirStatus =
    typeof u.creativeDirStatus === "string" ? u.creativeDirStatus : "idle";
  if (creativeDirStatus !== "ready") {
    const reason = `creative direction not ready (status=${creativeDirStatus})`;
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(
      userId,
      adImageFailedPatch(((current as any) || {}) as AdImageStatusFields, reason) as any
    );
    // eslint-disable-next-line no-console
    console.error("[onboardingAdImageService] gated by creative-dir step", {
      userId,
      reason,
    });
    void reportUIError({
      operation: "onboarding:ad-image:gated-creative-dir",
      errorMessage: reason,
      userId,
      context: {
        Source: "backend",
        Step: "adImage",
        creativeDirStatus,
      },
    });
    return;
  }

  const personas: ICPPersona[] = Array.isArray(u.icpResult)
    ? (u.icpResult as ICPPersona[])
    : [];
  const creativeDir: CreativeDirResult =
    u.creativeDirResult && typeof u.creativeDirResult === "object"
      ? (u.creativeDirResult as CreativeDirResult)
      : { concepts: [], copy_angles: [], format_archetypes: [] };
  const brand = extractAdImageBrandContext(u);

  // ENG-326 AC-3: ad images are BRANDED assets — without a persisted logo the
  // prompt builder would render an approximate typographic wordmark, which is
  // exactly the "random logo" defect. Fail the run pointing the user at brand
  // config instead of silently substituting.
  if (!brand.logoUrl) {
    const reason =
      "no brand logo is saved in Brand Guidelines — upload your logo in brand config, then regenerate. " +
      "Ad images are never generated with an invented or approximate logo (ENG-326).";
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(
      userId,
      adImageFailedPatch(((current as any) || {}) as AdImageStatusFields, reason) as any
    );
    // eslint-disable-next-line no-console
    console.error("[onboardingAdImageService] gated on missing brand logo", {
      userId,
      reason,
    });
    void reportUIError({
      operation: "onboarding:ad-image:missing-brand-logo",
      errorMessage: reason,
      userId,
      context: {
        Source: "backend",
        Step: "adImage",
      },
    });
    return;
  }

  // Close the image feedback loop: if the user has rejected variants on a
  // prior generation (♥/✕ swipe → adImageVariantsRated), distill those
  // rejects into negative visual directions so this generation steers
  // away from them. Empty on the first run (nothing rated yet). See
  // adImageVariantRatingService.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildNegativeExamplesBlockForImages } = require("./adImageVariantRatingService");
  const priorVariants: Array<{ id: string; concept?: string; archetype?: string }> =
    Array.isArray(u.adImageResult?.variants) ? u.adImageResult.variants : [];
  const negativeExamples: string = buildNegativeExamplesBlockForImages(
    { adImageVariantsRated: u.adImageVariantsRated },
    priorVariants.map((v) => ({
      id: v.id,
      conceptLabel: v.concept,
      archetype: v.archetype,
    })),
  );

  // WS2 telemetry: record image-gen lifecycle onto the onboarding loop so a
  // degraded model / timeout clusters on the health endpoint. Best-effort.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    recordOnboardingEvent,
    recordOnboardingFailure,
    ONBOARDING_TELEMETRY_EVENTS,
  } = require("./onboardingTelemetry");
  const isRegen = priorVariants.length > 0;
  void recordOnboardingEvent(userId, ONBOARDING_TELEMETRY_EVENTS.imageGenStarted, {
    regen: isRegen,
  });
  const genStartedAt = Date.now();

  let result: AdImageResult;
  try {
    result = await generateAdImagesForUser(
      creativeDir,
      brand,
      personas,
      userId,
      { ...deps, negativeExamples }
    );
  } catch (genErr) {
    void recordOnboardingFailure(
      userId,
      ONBOARDING_TELEMETRY_EVENTS.imageGenFailed,
      genErr,
      { regen: isRegen, durationMs: Date.now() - genStartedAt },
    );
    throw genErr;
  }

  // generateAdImagesForUser swallows per-variant failures and substitutes a
  // placeholder URL, so "completed" with liveCount < variantCount is a
  // partial failure; liveCount === 0 is a full failure of the external model.
  const variantCount = result.variants.length;
  const liveCount = result.variants.filter(
    (v) => typeof v.imageUrl === "string" && !v.imageUrl.includes("placeholder"),
  ).length;
  const durationMs = Date.now() - genStartedAt;
  if (liveCount === 0 && variantCount > 0) {
    void recordOnboardingFailure(
      userId,
      ONBOARDING_TELEMETRY_EVENTS.imageGenFailed,
      new Error("all image variants failed (every URL is a placeholder)"),
      { regen: isRegen, variantCount, liveCount, durationMs },
    );
  } else {
    void recordOnboardingEvent(userId, ONBOARDING_TELEMETRY_EVENTS.imageGenCompleted, {
      regen: isRegen,
      variantCount,
      liveCount,
      failedCount: variantCount - liveCount,
      durationMs,
    });
  }

  const current = await userDb.getUserById(userId);
  const patch = adImageReadyPatch(((current as any) || {}) as AdImageStatusFields, result);
  if (!patch) {
    // Stale completion (user is no longer in `running` or current is missing)
    // — drop silently. Same convention as ad-copy / creative-dir services.
    return;
  }

  // Mirror successfully-generated variants into the user's hidden
  // chat-session so /images, the heart/X favorite-image / archive-image
  // endpoints, and any future Emma deploy tools see them through the
  // same code paths Emma's own generated images flow through. Best-
  // effort — failure must NOT block the cascade. We fold the resolved
  // sessionId into the same `adImageReadyPatch` write below, keeping
  // the success path a single userDb.updateUser call.
  let chatSessionId: string | undefined;
  try {
    const liveVariants = result.variants.filter(
      (v) => typeof v.imageUrl === "string" && !v.imageUrl.includes("placeholder")
    );
    if (liveVariants.length > 0) {
      const { mirrorOnboardingAdImagesToChatSession } = await import(
        "./onboardingAdImageChatSessionMirror"
      );
      chatSessionId = await mirrorOnboardingAdImagesToChatSession(
        userId,
        liveVariants.map((v) => ({
          id: v.id,
          imageUrl: v.imageUrl,
          prompt: v.prompt,
        })),
        { existingSessionId: (current as any)?.adImageChatSessionId }
      );
    }
  } catch (mirrorErr) {
    console.warn(
      "[onboardingAdImageService] chat-session mirror failed (non-fatal):",
      mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
    );
  }

  const finalPatch: any = chatSessionId
    ? { ...patch, adImageChatSessionId: chatSessionId }
    : patch;
  await userDb.updateUser(userId, finalPatch);
}

/**
 * Synchronous entry point for routes — flips status to `running` and
 * launches background work.
 */
export async function startAdImageGenerationForUser(
  userId: string,
  deps: { imageGen?: AdImageGeneratorDep; timeoutMs?: number } = {}
): Promise<void> {
  await userDb.updateUser(userId, adImageStartPatch() as any);
  // Eager DAG sub-task 2: orchestrator owns step ordering for opted-in
  // users; cheap no-op gated inside the orchestrator for everyone else.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    isEagerPipelineActiveFor,
    reconcileForUser,
  } = require("./onboardingOrchestratorWiring");
  const current = (await userDb.getUserById(userId)) as
    | { useEagerPipeline?: boolean }
    | null;
  if (isEagerPipelineActiveFor(current)) {
    void reconcileForUser(userId);
    return;
  }
  void triggerAdImageGenerationForUser(userId, deps);
}
