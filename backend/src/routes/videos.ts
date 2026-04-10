import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { userDb } from "../services/db";
import { imageService } from "../services/imageGeneration";

const router = Router();

// ─── Bedrock client ────────────────────────────────────────────────────────────

let bedrockClient: AnthropicBedrock | null = null;

function getBedrockClient(): AnthropicBedrock {
  if (!bedrockClient) {
    bedrockClient = new AnthropicBedrock({ awsRegion: "us-west-2" });
  }
  return bedrockClient;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

const VALID_PLATFORMS = ["tiktok", "instagram", "linkedin", "youtube"] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

const PLATFORM_SPECS: Record<Platform, { aspectRatio: string; duration: string; hookTip: string }> = {
  tiktok:    { aspectRatio: "9:16", duration: "15–60 seconds", hookTip: "Hook must land in the first 3 seconds" },
  instagram: { aspectRatio: "9:16", duration: "15–90 seconds", hookTip: "Visual hook in first 2 seconds" },
  linkedin:  { aspectRatio: "16:9 or 1:1", duration: "30–90 seconds", hookTip: "Professional opening, bold statement" },
  youtube:   { aspectRatio: "16:9", duration: "60–300 seconds", hookTip: "Hook in first 5 seconds, then context" },
};

interface VideoConcept {
  title: string;
  framework: string;
  hook: string;
  narrativeArc: string;
  visualStyle: string;
  veoPromptDirection: string;
}

// ─── POST /concepts ─────────────────────────────────────────────────────────────
//
// Generates 3 distinct video concepts using different storytelling frameworks.
// Fast (no VEO) — just a Claude text generation call.

router.post("/concepts", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { platform, description, brandData } = req.body as {
      platform?: string;
      description?: string;
      brandData?: Record<string, string>;
    };

    // ── Validation ──────────────────────────────────────────────────────────
    if (!platform || !VALID_PLATFORMS.includes(platform as Platform)) {
      return res.status(400).json({
        error: `platform is required and must be one of: ${VALID_PLATFORMS.join(", ")}`,
      });
    }

    if (!description || description.trim().length < 10) {
      return res.status(400).json({
        error: "description is required and must be at least 10 characters",
      });
    }

    const spec = PLATFORM_SPECS[platform as Platform];

    // ── Build prompt ─────────────────────────────────────────────────────────
    let userPrompt = `Generate exactly 3 video concepts for a ${platform.toUpperCase()} video.
Platform specs: aspect ratio ${spec.aspectRatio}, duration ${spec.duration}. ${spec.hookTip}.

Product/Service description: ${description.trim()}`;

    if (brandData && Object.keys(brandData).length > 0) {
      const brandLines = Object.entries(brandData)
        .filter(([, v]) => v)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      userPrompt += `\n\nBrand context:\n${brandLines}`;
    }

    userPrompt += `

Use these 3 storytelling frameworks — one per concept:
1. Problem-Agitate-Solution: Open with a relatable pain point, amplify the frustration, then reveal the solution
2. Before/After Transformation: Show life/business before vs. after using the product
3. Social Proof / Results: Lead with a striking result or testimonial, then explain how it was achieved

For each concept, the veoPromptDirection MUST be 40–80 words and include: camera angle, subject and action, environment, lighting, visual style (cinematic/documentary/hyperrealistic), mood, and quality tags. Never mention text overlays, logos, or UI elements.

Respond with ONLY valid JSON in this exact format:
{
  "concepts": [
    {
      "title": "Concept title",
      "framework": "Framework name",
      "hook": "First 3 seconds — what does the viewer see/hear?",
      "narrativeArc": "What happens across the video",
      "visualStyle": "Visual aesthetic in 1–2 sentences",
      "veoPromptDirection": "40–80 word VEO prompt"
    }
  ]
}`;

    // ── Call Claude via Bedrock ───────────────────────────────────────────────
    const client = getBedrockClient();
    const response = await client.messages.create({
      model: "arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6",
      max_tokens: 2000,
      system: "You are an expert video producer and creative director. You respond with ONLY valid JSON — no markdown, no explanation, no preamble.",
      messages: [{ role: "user", content: userPrompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    // ── Parse response ───────────────────────────────────────────────────────
    const textBlock = response.content.find((b: Anthropic.ContentBlock) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return res.status(500).json({ error: "No text response from model" });
    }

    let parsed: { concepts: VideoConcept[] };
    try {
      // Strip markdown code fences if present
      const raw = textBlock.text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      parsed = JSON.parse(raw);
    } catch {
      console.error("[videos/concepts] Failed to parse model response:", textBlock.text);
      return res.status(500).json({ error: "Model returned invalid JSON" });
    }

    if (!Array.isArray(parsed.concepts) || parsed.concepts.length === 0) {
      return res.status(500).json({ error: "Model returned unexpected response structure" });
    }

    return res.json({ concepts: parsed.concepts });
  } catch (error) {
    console.error("[videos/concepts] Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// ─── POST /generate-frame ──────────────────────────────────────────────────────
//
// Generates a single still frame image for video start/end using Claude to craft
// a brand-aware prompt, then calls the image generation service with the logo.
// This is richer than /api/blog/generate-image because it has brand context.

router.post("/generate-frame", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, platform, isStart } = req.body as {
      prompt?: string;
      platform?: string;
      isStart?: boolean;
    };

    if (!prompt || prompt.trim().length < 5) {
      return res.status(400).json({ error: "prompt is required (min 5 characters)" });
    }

    // ── Fetch brand context ──────────────────────────────────────────────────
    const user = await userDb.getUserById(userId);
    const brand = user?.brandGuidelines;
    const brandData = brand?.brandData;
    const logoUrl = brand?.attachments?.find(
      (a: { type: string; url: string }) => a.type === "logo"
    )?.url ?? null;

    // ── Build brand context string for Claude ────────────────────────────────
    let brandContext = "";
    if (brandData) {
      const parts: string[] = [];
      if (brandData.brandName) parts.push(`Brand: ${brandData.brandName}`);
      if (brandData.tagline) parts.push(`Tagline: ${brandData.tagline}`);
      if (brandData.primaryColor) parts.push(`Primary color: ${brandData.primaryColor}`);
      if (brandData.visualStyle || brandData.toneOfVoice) parts.push(`Style: ${brandData.visualStyle || brandData.toneOfVoice}`);
      if (logoUrl) parts.push(`Logo available: yes (will be composited by image generator)`);
      brandContext = parts.length > 0 ? `\nBrand context:\n${parts.join("\n")}` : "";
    }

    const spec = platform && VALID_PLATFORMS.includes(platform as Platform)
      ? PLATFORM_SPECS[platform as Platform]
      : { aspectRatio: "16:9", duration: "", hookTip: "" };

    // ── Use Claude to craft an enhanced image generation prompt ──────────────
    const client = getBedrockClient();
    const systemPrompt = `You are an expert visual director specializing in commercial video production.
Your task is to craft a precise image generation prompt for a single cinematic still frame.
The prompt must be optimized for AI image generation (Imagen/Gemini style).
Rules:
- Write ONLY the image generation prompt — no explanation, no preamble
- Include: subject, action/pose, environment, lighting, visual style, mood, quality tags
- Aspect ratio: ${spec.aspectRatio}
- Frame position: ${isStart ? "opening frame (sets the scene, hooks the viewer)" : "closing frame (resolution, payoff, call to action moment)"}
- Do NOT include: text overlays, logos, UI elements, watermarks (these are handled separately)
- Keep it 40–80 words`;

    const userMessage = `User's instruction: ${prompt.trim()}${brandContext}

Craft the image generation prompt:`;

    const claudeResponse = await client.messages.create({
      model: "arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const textBlock = claudeResponse.content.find((b: Anthropic.ContentBlock) => b.type === "text");
    const enhancedPrompt = textBlock && textBlock.type === "text"
      ? textBlock.text.trim()
      : prompt.trim();

    console.log(`[videos/generate-frame] Enhanced prompt: ${enhancedPrompt}`);

    // ── Generate image ───────────────────────────────────────────────────────
    const isAvailable = await imageService.isAvailable();
    if (!isAvailable) {
      return res.status(503).json({ error: "Image generation service unavailable" });
    }

    const imageParams = {
      prompt: enhancedPrompt,
      filename: `${isStart ? "start" : "end"}-frame.png`,
      size: spec.aspectRatio === "9:16" ? "1024x1536" : "1536x1024",
      quality: "low",
      userId,
    };

    // Try with logo first; if the logo URL is inaccessible, fall back to without logo
    let result = await imageService.generateImage({
      ...imageParams,
      ...(logoUrl ? { logoImage: logoUrl } : {}),
    });

    if (!result.success && logoUrl) {
      console.warn("[videos/generate-frame] Logo failed, retrying without logo:", result.error);
      result = await imageService.generateImage(imageParams);
    }

    if (!result.success || !result.imageUrl) {
      return res.status(500).json({ error: result.error || "Image generation failed" });
    }

    return res.json({ imageUrl: result.imageUrl });
  } catch (error) {
    console.error("[videos/generate-frame] Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
