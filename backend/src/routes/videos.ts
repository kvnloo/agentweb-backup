import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";

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

export default router;
