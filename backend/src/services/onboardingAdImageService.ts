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
import { userDb } from "./db";
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
import type { ICPPersona } from "./icpStatusService";
import type { CreativeDirResult } from "./creativeDirStatusService";

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
 * Build the Brick 8 6-layer prompt for a single variant. Pure — no I/O.
 *
 * The Gemini API takes a SINGLE STRING prompt, so all 6 layers are emitted
 * inline as one structured spec. The rendering model parses the layer
 * headers and produces a coherent ad creative that matches the spec.
 */
export function buildSixLayerPromptForVariant(
  inputs: SixLayerPromptInputs
): string {
  const { variantIndex, format, concept, copyAngle, formatArchetype, brand, persona } =
    inputs;
  const companyName = brand.companyName || "(not provided)";
  const primaryColor = brand.primaryColor || DEFAULT_PRIMARY_COLOR;
  const secondaryColor = brand.secondaryColor || "#FFFFFF";
  const fontFamily = brand.fontFamily || DEFAULT_FONT_FAMILY;
  const tagline = brand.tagline || brand.valueProposition || companyName;
  const personaName = persona?.name || "ICP";
  const personaPain = persona?.pain || "(no pain captured)";
  const personaDesire = persona?.desire || "(no desire captured)";

  const lines: string[] = [];

  // Layer 1 — FORMAT & DIMENSIONS
  lines.push(`LAYER 1: FORMAT & DIMENSIONS`);
  lines.push(
    `Create a high-end editorial-style Facebook / Meta ad in ${format}px (variant ${
      variantIndex + 1
    }).`
  );
  if (format === "1080x1080") {
    lines.push(`Square format for Meta Feed. Aspect ratio 1:1.`);
  } else {
    lines.push(`Vertical format for Story / Reel. Aspect ratio 4:5.`);
  }
  lines.push(``);

  // Layer 2 — BACKGROUND / SETTING
  lines.push(`LAYER 2: BACKGROUND / SETTING`);
  lines.push(
    `SETTING: A clean, modern environment that visually expresses the "${concept}" concept. ` +
      `Use ${primaryColor} as the dominant atmospheric color, with ${secondaryColor} as the secondary. ` +
      `Soft directional lighting, minimal clutter, premium SaaS aesthetic. ` +
      `Composition follows format archetype "${formatArchetype}" — see archetype reference.`
  );
  lines.push(``);

  // Layer 3 — SUBJECT / FOCAL POINT
  lines.push(`LAYER 3: SUBJECT / FOCAL POINT`);
  lines.push(
    `FOCAL POINT: The viewer's eye hits ${
      personaName
    }'s pain — "${personaPain}" — rendered as a recognizable visual ` +
      `(UI screenshot, dashboard, chart, or relatable workspace). ` +
      `Use color cues that map to the resolution: green / success accents for the desired state ` +
      `("${personaDesire}"), red / alert accents for the unresolved pain. ` +
      `Spatial hierarchy: pain is foregrounded, resolution is implied or partially revealed.`
  );
  lines.push(``);

  // Layer 4 — TEXT OVERLAYS
  lines.push(`LAYER 4: TEXT OVERLAYS`);
  lines.push(
    `TEXT OVERLAY at top-center in ${fontFamily} bold (${primaryColor}, 36pt): ` +
      `"${tagline}". ` +
      `SUBHEADLINE at bottom-center in ${fontFamily} regular (${primaryColor}, 22pt): ` +
      `the copy angle "${copyAngle}" rendered as a one-line hook. ` +
      `Typography weight and size match Meta Feed legibility standards.`
  );
  lines.push(``);

  // Layer 5 — BADGE / CTA + COLOR & BRAND
  lines.push(`LAYER 5: BADGE / CTA + COLOR & BRAND`);
  const logoLine = brand.logoUrl
    ? `Logo for ${companyName} (${brand.logoUrl}) placed top-left at 96x96px, light version on dark backgrounds and dark version on light backgrounds. `
    : `Brand wordmark "${companyName}" placed top-left in ${fontFamily} bold (${primaryColor}, 28pt). `;
  lines.push(
    `${logoLine}` +
      `CTA button at bottom-right: rounded rectangle, ${primaryColor} background, ${secondaryColor} text, ` +
      `text "Learn more" in ${fontFamily} bold 18pt. ` +
      `Brand colors for ${companyName}: primary ${primaryColor}, secondary ${secondaryColor}.`
  );
  lines.push(``);

  // Layer 6 — STYLE SPECIFICATION
  lines.push(`LAYER 6: STYLE SPECIFICATION`);
  lines.push(
    `Photography style: clean, editorial, high-end SaaS. ` +
      `Mood: confident, trustworthy, premium. ` +
      `Lighting: soft natural light, no harsh shadows. ` +
      `What this should NOT look like: stock photography, cluttered collages, generic gradient backgrounds. ` +
      `Format confirmation: ${format} ${
        format === "1080x1080" ? "square" : "vertical"
      } format.`
  );

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
  if (typeof bd.logoUrl === "string" && bd.logoUrl) {
    ctx.logoUrl = bd.logoUrl;
  }
  // Some user records carry the logo on a separate `brandAssets` array. We
  // pick the first asset whose type indicates a logo.
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
  timeoutMs: number
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
  deps: { imageGen?: AdImageGeneratorDep; timeoutMs?: number } = {}
): Promise<AdImageResult> {
  const gen = deps.imageGen ?? (defaultImageService as AdImageGeneratorDep);
  const timeoutMs = deps.timeoutMs ?? PER_VARIANT_TIMEOUT_MS;

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

  const tasks = formats.map((format, i) => {
    const concept = concepts[i % concepts.length];
    const copyAngle = copyAngles[i % copyAngles.length];
    const formatArchetype = archetypes[i % archetypes.length];
    const persona = personas[i % Math.max(personas.length, 1)] || undefined;
    const prompt = buildSixLayerPromptForVariant({
      variantIndex: i,
      format,
      concept,
      copyAngle,
      formatArchetype,
      brand,
      persona,
    });
    const filename = `ad-image-${userId}-${i + 1}-${Date.now()}.png`;
    return { prompt, filename, format, index: i };
  });

  const results = await Promise.all(
    tasks.map(async (t) => {
      const r = await generateWithTimeout(
        gen,
        t.prompt,
        t.filename,
        userId,
        t.format,
        timeoutMs
      );
      const variant: AdImageVariant = {
        id: `variant-${t.index + 1}`,
        imageUrl:
          r.success && r.imageUrl ? r.imageUrl : `${PLACEHOLDER_URL}#${t.index + 1}`,
        prompt: t.prompt,
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

  const result = await generateAdImagesForUser(
    creativeDir,
    brand,
    personas,
    userId,
    deps
  );
  const current = await userDb.getUserById(userId);
  const patch = adImageReadyPatch(((current as any) || {}) as AdImageStatusFields, result);
  if (!patch) {
    // Stale completion (user is no longer in `running` or current is missing)
    // — drop silently. Same convention as ad-copy / creative-dir services.
    return;
  }
  await userDb.updateUser(userId, patch as any);
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
  void triggerAdImageGenerationForUser(userId, deps);
}
