/**
 * Brick 5: Format Archetype templates — VERBATIM from prod work plan
 * `plan_1768351741814_jgc2wwlxa`, steps[3].description (Creative Direction +
 * Format Archetypes).
 *
 * Each archetype defines:
 *   - LAYOUT STRUCTURE for Feed (1080x1080) and Story (1080x1350)
 *   - TEXT BUDGET (what text is allowed on canvas + the rule)
 *
 * The image-generation service injects the chosen archetype's LAYOUT
 * STRUCTURE + TEXT BUDGET verbatim into the Brick 8 6-layer prompt sent
 * to Gemini. This is the primary mechanism that prevents Gemini from
 * rendering long AI-paragraph subheadlines onto the canvas — the budget
 * tells the model exactly how many text elements are allowed and how
 * many words each can contain.
 *
 * Do NOT paraphrase. If the brick changes upstream, edit this file to
 * match verbatim.
 */

export type Archetype =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L";

export interface ArchetypeTemplate {
  id: Archetype;
  /** Short-form name used in logs / debug. */
  name: string;
  /** Verbatim LAYOUT STRUCTURE block for the Feed 1:1 format. */
  feedLayout: string;
  /** Verbatim LAYOUT STRUCTURE block for the Story 4:5 format. */
  storyLayout: string;
  /** Verbatim TEXT BUDGET block (allowed/disallowed elements + the Rule line). */
  textBudget: string;
}

export const ARCHETYPES: Record<Archetype, ArchetypeTemplate> = {
  A: {
    id: "A",
    name: "Native UI Format",
    feedLayout: [
      "Feed 1:1: UI element or screenshot centered in frame (70% of canvas width)",
      "- Device chrome / app frame visible at edges for authenticity",
      "- Clean, solid or subtly blurred background behind UI",
      "- Slight drop shadow under interface element",
      "- All UI text legible at ad size",
    ].join("\n"),
    storyLayout: [
      "Story 4:5: UI element occupies upper 60% of tall canvas",
      "- Device frame centered, slight tilt (max 3°) for dynamism",
      "- Lower 40% reserved for label and CTA",
      "- Background: subtle gradient from neutral to brand color descending",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — A: NATIVE UI",
      "✅ 1 product/app name badge — max 3 words, edge placement only",
      "✅ UI text inside the screenshot (mirrors real interface)",
      "❌ No headline, subheadline, body copy, or stat badges on canvas",
      "Rule: If it wouldn't appear in the real product UI, exclude it.",
    ].join("\n"),
  },
  B: {
    id: "B",
    name: "Data / Comparison Format",
    feedLayout: [
      "Feed 1:1: Primary stat or chart dominates center 60% of canvas",
      "- Single bold number or simple bar/line chart — no clutter",
      "- Thin dividing line separating data from context label",
      "- Background: dark neutral or brand dark",
      "- Secondary stat or label at 20% opacity, bottom-left",
    ].join("\n"),
    storyLayout: [
      "Story 4:5: Hero metric occupies top third in massive type (120px+)",
      "- Supporting chart or comparison in middle third",
      "- Source label or context in bottom third",
      "- Background: full-bleed gradient, dark to slightly lighter top-to-bottom",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — B: DATA / COMPARISON",
      "✅ 1 hero stat — large, dominant (e.g. \"10×\", \"4.9★\", \"$0 setup\")",
      "✅ 1 context label — max 4 words beneath stat",
      "✅ Chart axis labels — max 2 words each",
      "✅ CTA — max 3 words",
      "❌ No headline sentences, subheadlines, or body copy",
      "❌ No more than 2 data points simultaneously",
      "Rule: Numbers, labels, units only. If it's a sentence, cut it.",
    ].join("\n"),
  },
  C: {
    id: "C",
    name: "Lifestyle / Aspirational Format",
    feedLayout: [
      "Feed 1:1: Full-bleed environmental photography — object or workspace fills frame",
      "- Subject on rule-of-thirds intersection (right or left)",
      "- Generous negative space on opposite side for text overlay",
      "- Lighting: natural, directional — not studio flat",
      "- Depth of field: sharp subject, softly blurred environment",
    ].join("\n"),
    storyLayout: [
      "Story 4:5: Full-bleed lifestyle image occupies upper 65% of tall canvas",
      "- Cinematic crop — horizon line sits at upper-third",
      "- Frosted or gradient overlay on lower 40% for text legibility",
      "- Product or prop anchored at vertical midpoint of image",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — C: LIFESTYLE / ASPIRATIONAL",
      "✅ Headline — max 5 words, in negative space zone",
      "✅ Subheadline — max 8 words",
      "✅ CTA — max 3 words",
      "✅ 1 logo or wordmark",
      "❌ No stat badges, bullet points, body copy",
      "❌ No more than 3 text elements total",
      "Rule: Text should feel native to the scene. If it fights the image, remove it.",
    ].join("\n"),
  },
  D: {
    id: "D",
    name: "Typographic / Manifesto Format",
    feedLayout: [
      "Feed 1:1: Atmospheric background fills 100% of canvas (landscape, texture, gradient)",
      "- Headline centered, massive — occupies 35–45% of canvas height",
      "- Subheadline directly beneath, 40% smaller",
      "- Background desaturated or heavily darkened for contrast",
    ].join("\n"),
    storyLayout: [
      "Story 4:5: Atmospheric image, portrait-oriented, fills full canvas",
      "- Headline vertically centered in upper 50%, oversized type",
      "- Lower 45% reserved for subheadline + CTA",
      "- Overlay: dark gradient from 40% at top to 75% at bottom",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — D: TYPOGRAPHIC / MANIFESTO",
      "✅ Headline — max 8 words, dominant type (35–45% canvas height)",
      "✅ 1 supporting line — max 10 words, 40% smaller than headline",
      "✅ CTA — max 3 words",
      "❌ No third text element beyond CTA (pick headline + one supporting line)",
      "❌ No bullets, lists, or stat overlays competing with headline",
      "Rule: 2 text elements max beyond CTA. Hierarchy unmistakable at a glance.",
    ].join("\n"),
  },
  E: {
    id: "E",
    name: "USP + Triple Benefit Stack",
    feedLayout: [
      "Feed 1:1:",
      "TOP ZONE: Star rating (left) + customer count (right) — 10% from top",
      "MID ZONE: USP headline centered, bold, 2 lines max",
      "BOTTOM ZONE: 3 horizontal benefit blocks side by side, equal width",
      "- Each block: number badge (1/2/3) + benefit label",
      "- Thin dividing lines between blocks",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP ZONE: Star rating + customer count — top 12%",
      "UPPER-MID: USP headline — large, 2 lines, centered — 25–45%",
      "LOWER-MID: 3 benefit blocks stacked vertically",
      "- Each: full-width row with left number badge + right label",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — E: USP + TRIPLE BENEFIT STACK",
      "✅ Rating + count line — max 5 words total",
      "✅ USP headline — max 6 words",
      "✅ Benefit 1, 2, 3 labels — max 6 words each",
      "✅ CTA — max 3 words",
      "❌ No sentences beneath benefit labels",
      "❌ No subheadline between USP and benefits",
      "Rule: 6 copy elements total. Each must scan in under 1 second.",
    ].join("\n"),
  },
  F: {
    id: "F",
    name: "Unique Advantage Vertical List",
    feedLayout: [
      "Feed 1:1:",
      "TOP: Logo centered, 15% from top",
      "UPPER-MID: Headline — bold, centered, 2 lines max",
      "MID–BOTTOM: 3 benefit rows, icon (left) + label (right)",
      "- Equal vertical spacing, thin separator lines between rows",
      "- CTA button flush bottom center",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP: Logo — 10% from top",
      "HEADLINE: Large, centered, 3 lines allowed",
      "BENEFITS: 3 stacked rows, ~18% canvas height each",
      "- Icon left, label right",
      "- CTA large, pill-shaped, bottom 12%",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — F: ADVANTAGE VERTICAL LIST",
      "✅ Headline — max 6 words",
      "✅ Benefit rows 1, 2, 3 — max 5 words each (icon + label, no descriptor)",
      "✅ CTA — max 3 words",
      "❌ No descriptive sentences under benefit labels",
      "❌ No subheadline, rating badges, or media logos",
      "Rule: 5 copy elements. If a benefit needs more than 5 words, rewrite it.",
    ].join("\n"),
  },
  G: {
    id: "G",
    name: "Testimonial + Social Proof",
    feedLayout: [
      "Feed 1:1:",
      "TOP: Star rating (★★★★★) centered — 12% from top",
      "UPPER-MID: Pull quote, large type — 2–3 lines, centered",
      "MID: Attribution — name, title, company — smaller, muted",
      "LOWER-MID: Aggregate rating bold",
      "BOTTOM BAR: \"As Seen In\" + 3–4 media logos, evenly spaced",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP: Star rating — large, 10% from top",
      "HERO QUOTE: Oversized, centered — 30% of canvas",
      "ATTRIBUTION: Name + role below quote",
      "DIVIDER: Thin line",
      "AGGREGATE: Large rating + review count",
      "BOTTOM: Media logo bar — bottom 15%",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — G: TESTIMONIAL + SOCIAL PROOF",
      "✅ Star rating — visual only (★★★★★)",
      "✅ Pull quote — max 15 words, real customer voice",
      "✅ Attribution — max 5 words (Name · Title · Company)",
      "✅ Aggregate rating — max 6 words (e.g. \"4.9 / 5 · 2,847 reviews\")",
      "✅ \"As Seen In\" logo bar — logos only",
      "✅ CTA — max 3 words",
      "❌ No headline overlay, benefit bullets, or feature claims",
      "Rule: Every text element must be attributable proof. If it sounds like an ad, cut it.",
    ].join("\n"),
  },
  H: {
    id: "H",
    name: "CTA-Focused Grid",
    feedLayout: [
      "Feed 1:1:",
      "TOP: Logo (left) + rating badge (right) — top 10%",
      "UPPER-MID: Headline — 1–2 lines bold, centered",
      "MID: CTA button — prominent, pill-shaped, centered",
      "LOWER: 2×2 image grid filling remaining 40% of canvas (4px gaps)",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP: Logo centered — top 8%",
      "HEADLINE: Bold, centered, 2 lines — 15–28%",
      "CTA BUTTON: Large, pill-shaped — 30–38%",
      "GRID: 2×2 image grid — 40–88%",
      "BOTTOM: Rating badge centered — bottom 8%",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — H: CTA-FOCUSED GRID",
      "✅ Headline — max 6 words",
      "✅ CTA — max 3 words (primary message — make it count)",
      "✅ Rating badge — max 5 words",
      "❌ No subheadline, text overlays on grid images, or body copy",
      "Rule: 3 text elements total. CTA is the star — everything else is silent support.",
    ].join("\n"),
  },
  I: {
    id: "I",
    name: "Before/After Split Panel",
    feedLayout: [
      "Feed 1:1:",
      "LEFT PANEL (48%): \"Before\" — desaturated, darker, problem state",
      "RIGHT PANEL (48%): \"After\" — vibrant, solution state",
      "CENTER: Vertical divider line (2px, brand color) with arrow icon",
      "TOP LEFT/RIGHT: Panel labels — small caps",
      "BOTTOM: Shared CTA bar spanning full width — bottom 15%",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP HALF (0–48%): \"Before\" panel — full width, problem imagery",
      "DIVIDER: Horizontal line with central arrow chip",
      "BOTTOM HALF (52–85%): \"After\" panel — full width, solution imagery",
      "BOTTOM 15%: Headline + CTA button spanning full width",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — I: BEFORE / AFTER SPLIT",
      "✅ \"Before\" panel label — max 2 words",
      "✅ \"After\" panel label — max 2 words",
      "✅ 1 outcome headline spanning bottom bar — max 7 words",
      "✅ CTA — max 3 words",
      "❌ No text overlaid on either panel image",
      "❌ No subheadline, stat badges, or bullet points",
      "Rule: 4 text elements max. The image contrast is the argument — don't over-explain it.",
    ].join("\n"),
  },
  J: {
    id: "J",
    name: "Problem-Solution Highlight",
    feedLayout: [
      "Feed 1:1:",
      "LEFT (50%): Before image — muted, cooler tone",
      "RIGHT (50%): After image — warm, vibrant",
      "OVERLAY TOP: Ghost \"Before\" / \"After\" labels",
      "CENTER: Vertical separator, thin, brand color",
      "BOTTOM THIRD OVERLAY: Outcome headline spans full width on translucent bar",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP 45%: Before image, full width",
      "TRANSITION BAND: Brand-color strip with outcome label centered",
      "MIDDLE 40%: After image, full width, vibrant",
      "BOTTOM 15%: CTA + brand positioning tagline",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — J: PROBLEM-SOLUTION HIGHLIGHT",
      "✅ \"Before\" ghost label — max 1 word",
      "✅ \"After\" ghost label — max 1 word",
      "✅ Outcome headline on bottom bar — max 7 words (result language only)",
      "✅ CTA — max 3 words",
      "❌ No feature or benefit copy, stat badges, or subheadline",
      "Rule: Outcome headline describes life after, not the product. If it mentions a feature, rewrite it.",
    ].join("\n"),
  },
  K: {
    id: "K",
    name: "Typology / UGC Grid",
    feedLayout: [
      "Feed 1:1:",
      "TOP: Social handle + platform icon — left-aligned, top 10%",
      "GRID: 2×2 equal panels (4px gaps)",
      "- Top-left, Bottom-left: Before panels — slightly muted",
      "- Top-right, Bottom-right: After panels — vibrant",
      "GRID fills 80% of canvas",
      "BOTTOM: Thin CTA bar, full width",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP: Social handle + verified badge — top 8%",
      "SUBTITLE: \"Before → After\" label, centered — 12%",
      "GRID: 2×2 panels — 16–85% of canvas",
      "BOTTOM 12%: CTA button centered",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — K: TYPOLOGY / UGC GRID",
      "✅ Social handle — max 1 line (e.g. \"@brandname\")",
      "✅ \"Before → After\" directional label — max 3 words",
      "✅ CTA — max 3 words",
      "❌ No text inside any of the 4 grid panels",
      "❌ No headline, captions, star ratings, or media logos",
      "Rule: 3 text elements total. Grid panels must be purely visual.",
    ].join("\n"),
  },
  L: {
    id: "L",
    name: "Competitor Pain/Benefit Matrix",
    feedLayout: [
      "Feed 1:1:",
      "LEFT PANEL (48%): Dark/desaturated — labeled \"Others\"",
      "- 3 pain points, each with ✗ icon, stacked vertically",
      "RIGHT PANEL (48%): Brand background — labeled with your brand",
      "- 3 matching benefits, each with ✓ icon",
      "CENTER: Vertical divider, 2px, neutral",
      "BOTTOM: CTA button full-width, right-panel brand color",
    ].join("\n"),
    storyLayout: [
      "Story 4:5:",
      "TOP HEADER: Split label bar — \"Others\" (left, muted) / \"[Brand]\" (right, colored)",
      "3 COMPARISON ROWS stacked — each: ✗ pain (left) | ✓ benefit (right) | center divider",
      "Rows separated by thin lines",
      "BOTTOM 15%: CTA button full-width",
    ].join("\n"),
    textBudget: [
      "TEXT BUDGET — L: COMPETITOR PAIN MATRIX",
      "✅ Left column header — max 2 words (\"Others\" — never a real brand name)",
      "✅ Right column header — max 2 words (your brand name)",
      "✅ Pain labels 1, 2, 3 — max 4 words each",
      "✅ Benefit labels 1, 2, 3 — max 4 words each (mirror each pain)",
      "✅ CTA — max 3 words",
      "❌ No competitor logos, brand names, or sentences",
      "Rule: 9 text elements total. Every pain must have a direct benefit mirror.",
    ].join("\n"),
  },
};

/**
 * Brick 8 Aesthetic Integration Rules (verbatim). The user's visual
 * preferences from Brick 1 dictate which one to apply. We default to
 * "Minimal + Typographic" because it's the safest fit for most brands
 * and renders cleanly on Gemini. Future work: derive aesthetic from
 * brand category / industry signals captured in Brick 1.
 */
export type Aesthetic = "light-nature" | "dark-tech" | "minimal-typographic";

export const AESTHETIC_RULES: Record<Aesthetic, string> = {
  "light-nature": [
    "AESTHETIC INTEGRATION RULES — Light Mode + Nature as Atmosphere (B2B SaaS):",
    "NATURE ROLE: Backdrop only — blurred landscapes, distant horizons, views through glass",
    "ARCHITECTURE: White marble, concrete, glass walls, modern minimalist spaces",
    "PLANT ACCENTS: 1-2 max per ad — succulent, single potted plant. Never the focal point.",
    "PHOTOGRAPHY: Mountains, ocean, coastline — always blurred or background layer",
    "REFERENCE BRANDS: Superhuman, Linear, Vercel, Apple",
    "NEVER: Botanical illustrations, pressed leaves, seed packets, greenhouses, trail maps, Kinfolk/editorial aesthetic, nature as subject",
  ].join("\n"),
  "dark-tech": [
    "AESTHETIC INTEGRATION RULES — Dark Mode + Tech UI (Developer Tools):",
    "BACKGROUNDS: #1A1A2E, #0A0A1A with subtle grid patterns or code blur",
    "UI ELEMENTS: Code editor chrome, terminal windows, dashboard components",
    "ACCENTS: Neon blue, green status indicators, gradient glows",
    "PHOTOGRAPHY: None — pure digital/UI treatment",
    "REFERENCE BRANDS: Linear, Raycast, Warp, GitHub",
    "NEVER: Stock photography, nature imagery, lifestyle elements",
  ].join("\n"),
  "minimal-typographic": [
    "AESTHETIC INTEGRATION RULES — Minimal + Typographic (Bold Brands):",
    "BACKGROUNDS: Solid colors, gradients, or single dramatic photograph",
    "TEXT: Oversized typography IS the creative. 60-80% of frame is text.",
    "ACCENTS: Single pop color for CTA, monochrome everything else",
    "REFERENCE BRANDS: Nike, Apple, Stripe",
    "NEVER: Busy compositions, multiple focal points, small text",
  ].join("\n"),
};

/**
 * Default 3-variant archetype set. Skips A (Native UI) because it's the
 * format that requires Gemini to render coherent text inside a UI mockup —
 * exactly the failure mode that produces "Cosseors anodied wlari" gibberish.
 *
 * D + I + C is a high-success-rate trio:
 *   D: Typographic / Manifesto — Gemini renders bold typography flawlessly
 *   I: Before/After Split — minimal text, image contrast carries the argument
 *   C: Lifestyle / Aspirational — atmospheric photo + 2-3 short text overlays
 *
 * Each is in the brick's "AT LEAST 3 of the 4 archetypes" set OR an
 * approved E-N variant.
 */
export const DEFAULT_VARIANT_ARCHETYPES: ReadonlyArray<Archetype> = ["D", "I", "C"];

/**
 * Resolve a free-text archetype label (whatever the LLM emitted in
 * Brick 4) to a concrete Archetype id. Falls back through the
 * default variant set when no match.
 */
export function resolveArchetype(
  label: string | undefined,
  fallbackIndex: number,
): Archetype {
  if (label) {
    const upper = label.trim().toUpperCase();
    // Exact id match.
    if (upper in ARCHETYPES) return upper as Archetype;
    // Match by name keyword.
    for (const [id, t] of Object.entries(ARCHETYPES)) {
      if (upper.includes(t.name.toUpperCase())) return id as Archetype;
    }
    // Match common keywords.
    if (/NATIVE\s*UI|SCREENSHOT/.test(upper)) return "A";
    if (/DATA|COMPARISON|CHART|STAT/.test(upper)) return "B";
    if (/LIFESTYLE|ASPIRATIONAL/.test(upper)) return "C";
    if (/TYPOGRAPHIC|MANIFESTO/.test(upper)) return "D";
    if (/USP|TRIPLE\s*BENEFIT/.test(upper)) return "E";
    if (/ADVANTAGE|VERTICAL\s*LIST/.test(upper)) return "F";
    if (/TESTIMONIAL|SOCIAL\s*PROOF/.test(upper)) return "G";
    if (/CTA.*GRID|GRID.*CTA/.test(upper)) return "H";
    if (/BEFORE.*AFTER|SPLIT/.test(upper)) return "I";
    if (/PROBLEM.*SOLUTION/.test(upper)) return "J";
    if (/UGC|TYPOLOGY/.test(upper)) return "K";
    if (/COMPETITOR|MATRIX/.test(upper)) return "L";
  }
  return DEFAULT_VARIANT_ARCHETYPES[
    fallbackIndex % DEFAULT_VARIANT_ARCHETYPES.length
  ];
}
