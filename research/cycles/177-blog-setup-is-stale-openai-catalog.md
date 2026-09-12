# Cycle 177 — `BLOG_SETUP.md` is a stale fifth image catalog

**Date:** 2026-09-12T01:20:00Z
**Question:** Cycle 176 next: `BLOG_SETUP.md` L34 still documents
`OpenAI/Image` for a secret cycle 175 showed the leaf never
fetches on a live `SUPPORTED_MODELS` path. Is that ops
doc describing the blog hero path, or a dead catalog?

**Answer:** The doc is a **fifth catalog** (ops, not code).
Blog heroes omit `imageModel`, so cycle 170’s hardcoded
`gemini-3-pro-image-preview` fires, and `isAvailable()`
probes **`Google/Image`**. Backend has no Picsum, no
DALL-E 3, no `OPENAI_IMAGE_API_KEY`. Agent-engine is a
**different deploy unit** that still has a live OpenAI
env. Do not collapse those two. Not a nanoservice.

## Evidence

```48:55:backend/src/controllers/blog.ts
  const result = await imageService.generateImage({
    prompt: prompt,
    size: "1536x1024",
    quality: "low",
    filename: filename || `blog-hero-${Date.now()}.png`,
    userId: userId,
    inputImages: []
  });
```

No `imageModel`. Leaf L492–494 then sets
`gemini-3-pro-image-preview`. `isAvailable()` L1539–1543
calls `getApiKey("gemini-3-pro-image-preview")` → L361–365
`dev|prod/AgentWeb/Google/Image`. The same omit is on the
HTTP blog generate-image route (`blog.ts` L1431–1438).

| Catalog | Claims | Live |
|---|---|---|
| `BLOG_SETUP.md` L9 / L46–67 | GPT Image 1 + DALL-E 3 + Picsum; `OPENAI_IMAGE_API_KEY`; `blog-images/` | None of that in `backend/` |
| Doc L32–35 / L218 | `OpenAI/Image` secret | Blog probes `Google/Image` |
| Leaf `getApiKey` else L371–375 | `OpenAI/Image` | Unreachable (cycle 175) |
| Fallback log L1559 | “Failed to initialize **OpenAI** Image Service” | Constructor never fetches a secret |
| Agent-engine `web_agent.py` L3296–3299 | `OPENAI_IMAGE_API_KEY` else after `gpt-image-1` | **Live** on the GCP worker |

Backend grep of `OPENAI_IMAGE_API_KEY`, `picsum.photos`,
`dall-e-3`, and `blog-images/` is empty. Doc L62 still
uploads to `blog-images/`.

Agent Mode blog heroes are the inverted DAG A-012 already
parks: `agentModeService.ts` L29894 dynamically imports
`controllers/blog`, then L29962 / L30001 call
`generateBlogImage`. Cycle 177 is the **secret/docs**
half of that same lift — not a new A-item.

Agent-engine still maps `OPENAI_IMAGE_API_KEY` → GCP
secret `openai-image` (`secrets_manager.py` L199–200;
`.env.example` L79; tests). Default there is
`"openai-image-1"` (`web_agent.py` L3240) — not a
backend `SUPPORTED_MODELS` id. That catalog split is
cycle 178, not this one.

Hermes `FAL_MODELS` is one table the tests pin. An ops
markdown that names a vendor the leaf no longer fetches
is the same drift as cycle 166’s four code catalogs.

## What this is not

Not a product patch. Do not rewrite `BLOG_SETUP.md` on a
research turn. Do not add A-021. Do not unify Emma vs
MCP field names.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not refresh an ops doc. Q-003
mapper still Matt-gated (cycle 170).

Not A-006. HTTP-splitting the leaf would not sync the
markdown, and would still leave agent-engine’s OpenAI
env on a second box.

## Relation to A-002 / A-007 / A-008 / A-012

A-012 is the in-process lift of `generateBlogImage` out
of `controllers/`. A-008 `git mv` of `imageGeneration.ts`
does not delete L29894. After #2, not instead of Q-014.

## Next cycle candidate

Agent-engine default `"openai-image-1"` (`web_agent.py`
L3240) and `FLUX.1-Kontext-pro` (L3249) are not in
backend `SUPPORTED_MODELS`. Two deploy units, two
dispatch tables. File-level. Do not add A-021.
