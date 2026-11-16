# Emma model upgrade audit — 2026-11-15

Base: `origin/main` at `d4758845b`. This is a source audit, not a read of production AW-Settings or organization preferences.

## Delivered safely

- Completed existing admin-only Claude Sonnet 5.5 metadata: provider-published reasoning effort choices and a non-placeholder description. No effort default is set, so no extra reasoning spend is requested.
- Fixed Sonnet 5.5 cache-read accounting from $0.20/M to $0.10/M; input/output remain $2/$10 per million. Price-book version advanced to 2026-11-15 with a new fingerprint.
- Catalog discovery now preserves validated `reasoning.supported_efforts` for future additions, without setting runtime effort defaults. Unknown/empty lists are ignored as a whole. Models remain admin-only; vision remains opt-in pending live verification.
- No role default, judge, embedding, legacy alias, user selection, organization override, provider credential, or production setting changed. No new dependency or service.

## Source inventory and precedence

`backend/src/services/modelRoles.ts` implements eight roles. Runnable persisted admin defaults are honored even when hidden by the new-selection picker; organization overrides and existing supersession behavior remain unchanged.

| Role | Source fallback | Additional default source |
| --- | --- | --- |
| chat | `gemini-3.8-flash` | `agent_mode_default_model` |
| enrichment | `openrouter/openai/gpt-5.6-luna` | `CRM_ENRICH_V3_DEFAULT_MODEL` environment rollback |
| image | `gemini-3-pro-image-preview` | `agent_mode_image_api_default_model`, then `default_image_model` |
| embedding | `openai/text-embedding-3-large` | Only compatible existing embedding space selectable |
| scoring_judge | `gemini-3.1-flash-lite` | `default-scoring-model` |
| content_generation | `gemini-3.8-flash` | `agent_mode_content_model` |
| research | `gemini-3.8-flash` | Organization role override |
| voice | `gemini-3.1-flash-live-preview` | Organization role override |

`docs/model-roles-inventory.md` contains historical local-only status and absent-supersession claims that no longer describe main. Its lexical inventory is historical, not a deployment/traffic report. The current source table above supersedes those status claims, not its historical evidence.

Current registry already contains visible Opus 5.5 and admin-only Sonnet 5.5, Haiku 5.5, GPT-6.1 Sol and Gemini 3.5 Flash Lite. Adding them again would duplicate existing work.

## Live provider evidence and cost comparison

Read-only GET `https://openrouter.ai/api/v1/models` returned 467 models; raw capture: `/home/harsha/.hermes/cache/scratch/emma-openrouter-models.json`. Endpoint evidence: `https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints`, captured at `/home/harsha/.hermes/cache/scratch/emma-sonnet55-endpoints.json`. Catalog availability does not prove credential access or successful inference.

| Candidate | Published input/output $/M | Decision |
| --- | --- | --- |
| Claude Sonnet 5.5 | 2 / 10; cache read 0.10, write 2.50 | Existing entry; complete metadata and correct cache rate, keep admin-only |
| Claude Opus 5.5 | 4 / 20 | Already visible; no change |
| GPT-6.1 Sol | 2 / 10; above 272k prompt tokens 4 / 15 | Already admin-only; no promotion; flat-book long-context accounting needs evaluation |
| GPT-6.1 Terra | 1 / 5; above 272k prompt tokens 2 / 7.5 | Already proposed in PR #3399; do not duplicate |
| GPT-6 Astra | 10 / 50; above 272k prompt tokens 20 / 75 | Not a cost-neutral replacement for current Flash defaults |
| Gemini 3.8 Flash | 0.825 / 4.125 at current OpenRouter listing | Current role fallback; existing curated book is 0.75 / 3.75, a discrepancy to review separately, not silently normalize |

Sonnet 5.5 catalog reports 1M context, 128k max output, tools/tool_choice, mandatory reasoning with supported efforts max/xhigh/high/medium/low, default high, and no temperature parameter. Endpoint listing agrees on tools and absence of temperature; some regional endpoint rates are 10% above the catalog base. Existing supportsTemperature=false is retained. No capability/quality benchmark was invented; existing AA snapshot scores are unchanged and are not current reevaluations.

Sonnet 5.5 base input/output is below the existing curated Sonnet 5 book ($3/$15), but that does not establish equal per-task cost or justify changing users' pins. Completion volume, reasoning, fallback endpoint prices and quality require measured comparison.

## Duplication and rollout gates

GitHub search and full PR #3399 body/comments were read. Existing open automation PR: https://github.com/AgentWebPro/agentweb/pull/3399. It already proposes Fable 5.2, dated DeepSeek Flash and GPT-6.1 Terra; its report says live smoke skipped, upstream data degraded, and tiered pricing blocks automatic promotion. This change does not add those entries or replace that PR.

Linear model search returned all results (`hasNextPage=false`). Relevant existing work: ENG-1606 roster/cost/quality rollout decision; ENG-1710 and ENG-665 evaluation and quality-per-dollar; ENG-1689/ENG-1770 dynamic catalog; ENG-1780 approval flip (blocked); ENG-1779 registry fixture tests (blocked); ENG-2292/ENG-2293 frontier monitor; ENG-1713 temperature audit. No duplicate ticket created.

Before customer exposure/default changes:
1. Run bounded authenticated tool/structured-output smoke and representative Emma quality/cost evaluation against existing defaults. This task made no paid inference calls.
2. Verify candidate-specific reasoning and vision using the actual runtime path; no vision flag enabled here.
3. Resolve long-prompt tier accounting (ENG-1774 noted by the existing refresh PR) before promoting affected OpenAI entries.
4. Read actual persisted admin/org settings before proposing any default migration; preserve explicit pins. Judge changes require a separate evaluation, embedding changes require compatible-space/reindex planning.
5. Check CI and deploy exact source through normal backend workflow, then independently verify production VersionLabel/source bundle and health. No deployment claim follows merely from catalog metadata tests.

## Validation

Test-first evidence: `/home/harsha/.hermes/cache/scratch/emma-upgrade-red.log` records 5 expected failing assertions for missing effort metadata, placeholder description, cache price and catalog propagation. Independent green run: `/home/harsha/.hermes/cache/scratch/emma-upgrade-green.log` — 144 tests passed across registry, refresh, price-book and model-role suites (`NODE_OPTIONS=--max-old-space-size=1536`, `jest --runInBand --forceExit`). Existing error-path console warnings and forced-exit notice remain; this is scoped testing, not a full backend build or live smoke.
