# Cycle 175 — `generateWithOpenAI` else is unreachable

**Date:** 2026-09-12T01:12:00Z
**Question:** Cycle 174: Runway HTTPS is the live URL skip.
`generateWithOpenAI` L1486–1492 also returns a URL (DALL-E
comment). After `SUPPORTED_MODELS` includes(), can any id
reach that else?

**Answer:** No. Every accepted id hits Azure / Gemini /
Gemini 3 / Runway. The else at L533–534 is dead. Cycle 174’s
persist hop was written for two URL vendors; only Runway is
live. `getOpenAIClient` is imported solely for that method
(L4 / L1454). `getApiKey`’s OpenAI default (L371–375) is
the same dead else. Tests never name `generateWithOpenAI` or
`dall-e`. Not a nanoservice.

## Evidence

Order in `generateImage`: default L492 → `normalizeImageModel`
L499 → `includes(SUPPORTED_MODELS)` L502 → dispatch L525–534.

| `SUPPORTED_MODELS` id | After normalize | Branch |
|---|---|---|
| `gpt-image-1` / `gpt-image-2` | same | Azure L525 |
| `gemini-2.5-flash-image` | same | Gemini L527 |
| `gemini-3-pro-image-preview` / `gemini-3.1-flash-image` | same | Gemini 3 L529 |
| `gemini-3.1-flash-image-preview` | `gemini-3.1-flash-image` | Gemini 3 L529 |
| `gen4_image` / `gemini_2.5_flash` | same | Runway L531 |
| anything else | refused L502–506 | never dispatch |

`generateWithOpenAI` has **one** call site: L534. Grep of
`backend/src` is that definition plus the meter comment L549
that still names it as a live sub-method. `__tests__` grep
`generateWithOpenAI` / `dall-e` is empty. Pricing has no
`dall-e` key. ENG-410 already moved gpt-image to Azure
(`getAzureImageConfig`).

`BLOG_SETUP.md` L34 still documents
`dev/AgentWeb/OpenAI/Image` — ops docs for a secret this
leaf no longer fetches on a live path.

Hermes has one image handler, no dead sibling next to FAL.
An HTTP extract of this file would still ship a DALL-E
client nothing calls.

## What this is not

Not a product patch. Do not delete the else in Q-014.
Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
cannot reach this method.

Not A-006. Dead code is in-process; deleting it is A-008
cleanup after #2.

## Relation to A-002 / A-007 / A-008

A-008 `git mv` is the moment to drop `generateWithOpenAI` +
the OpenAI secret else + `getOpenAIClient` import. After #2,
not instead of Q-014. Cycle 174’s HTTPS persist is Runway
only.

## Next cycle candidate

Meter provider ternary L554–558: `startsWith("gemini-")` →
gemini, else runway. Runway’s `gemini_2.5_flash`
(underscore) therefore meters as **runway**; Google’s
`gemini-2.5-flash-image` as **gemini**. File-level. Do not
add A-021.
